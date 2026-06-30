import {
  CommandId,
  MessageId,
  ORCHESTRATION_GOAL_COMPLETION_SENTINEL,
  ORCHESTRATION_GOAL_BLOCKED_SENTINEL,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import {
  renderGoalContinuationPrompt,
  renderGoalBudgetLimitedPrompt,
} from "../goalContinuationPrompt.ts";
import {
  GoalContinuationReactor,
  type GoalContinuationReactorShape,
} from "../Services/GoalContinuationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

// Domain events that mean "a turn may have just settled" or "the goal/interaction state
// changed in a way that should re-evaluate continuation". We re-read the snapshot on each
// and decide from `latestTurn`, so either ordering (checkpoint-first or session-idle-first)
// converges.
const TRIGGER_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-diff-completed",
  "thread.session-set",
  // Resume: the reactor owns post-resume continuation dispatch (the web client only
  // dispatches the first turn on goal create). Without this, `/goal resume` stalls
  // indefinitely until a manual message or session restart fires a trigger.
  "thread.goal-resumed",
  // Plan mode exit: continuations skip while `interactionMode === "plan"`, but without
  // this trigger the reactor never re-evaluates when the user exits plan mode. The event
  // already exists (`orchestration.ts:1355`); just add it to the trigger set.
  "thread.interaction-mode-set",
]);

function triggerThreadId(event: OrchestrationEvent): ThreadId | null {
  if (
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.session-set" ||
    event.type === "thread.goal-resumed" ||
    event.type === "thread.interaction-mode-set"
  ) {
    return event.payload.threadId;
  }
  return null;
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const continuationMessageId = (): MessageId =>
  MessageId.makeUnsafe(`goal-continuation:${crypto.randomUUID()}`);

const budgetLimitedMessageId = (): MessageId =>
  MessageId.makeUnsafe(`goal-budget-limited:${crypto.randomUUID()}`);

// Number of consecutive goal turns that report the same blocker before the
// reactor marks the goal blocked (terminal). Codex uses 3; we match.
const GOAL_BLOCKED_AUDIT_THRESHOLD = 3;

// The assistant message produced by the just-completed turn. We require it to be present
// before deciding, so sentinel detection reads the real final text rather than racing the
// message's persistence into the projection.
function findAssistantMessageForTurn(thread: OrchestrationThread, turnId: TurnId) {
  return [...thread.messages]
    .reverse()
    .find((entry) => entry.role === "assistant" && entry.turnId === turnId);
}

// Strip markdown formatting (bold `**`, code blocks, backticks) and whitespace before
// sentinel matching. Different providers format the sentinel differently (Claude bolds it,
// Codex wraps in a code block, Gemini adds trailing whitespace). The sentinel approach's
// whole point is cross-provider compatibility — exact plain-text match alone would only
// work on providers that emit the sentinel verbatim.
function normalizeSentinelCandidate(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\n?|\n?```$/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

// Extract the blocker reason from the assistant text preceding the
// <goal-blocked/> sentinel. The model is prompted to state the blocker on the
// lines before the sentinel.
function extractBlockedReason(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && normalizeSentinelCandidate(line) !== ORCHESTRATION_GOAL_BLOCKED_SENTINEL,
    );
  const reason = lines.at(-1) ?? "Recurring blocker detected by goal audit";
  return reason.length > 280 ? `${reason.slice(0, 277)}...` : reason;
}

// Heuristic blocker detection for turns where the model reports being stuck
// without emitting the explicit <goal-blocked/> sentinel.
// ponytail: regex-based heuristic, not a full NLP parse — sufficient for the
// audit's purpose (detect recurrence of the same blocker text). Upgrade to a
// structured model-emitted marker if providers adopt one.
const BLOCKER_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bI(?:'m| am) blocked\b/i, label: "I'm blocked" },
  { pattern: /\bcannot proceed\b/i, label: "cannot proceed" },
  { pattern: /\bblocked by\b/i, label: "blocked by dependency" },
  { pattern: /\bunblock(?:ed)?\s+(?:this|the)\s+(?:goal|task)\b/i, label: "needs unblock" },
  { pattern: /\bstuck\b[^.]*\b(?:cannot|can't|unable)\b/i, label: "stuck and unable to proceed" },
];

function detectBlockerHeuristic(text: string): string | null {
  for (const { pattern, label } of BLOCKER_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
}

const GOAL_ERROR_PAUSE_THRESHOLD = 3;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // We act at most once per completed turn per thread. Recorded only once we commit to
  // an action, so a trigger that arrives while the agent is still busy can retry later.
  const lastHandledTurnId = new Map<ThreadId, TurnId>();
  // Ephemeral per-thread consecutive-error counter. Reset on successful turn completion.
  // After GOAL_ERROR_PAUSE_THRESHOLD consecutive terminal turn errors, pause the goal so
  // the user knows it is stuck instead of silently burning budget on erroring continuations
  // (Codex c62d792). In-memory only — lost on restart, which also clears the failing session.
  const consecutiveErrors = new Map<ThreadId, number>();
  // Blocked-audit: tracks the last blocker text the model reported and how many
  // consecutive goal turns it has recurred. When the same blocker recurs
  // GOAL_BLOCKED_AUDIT_THRESHOLD times, the reactor dispatches thread.goal.blocked
  // (terminal). Reset on any non-blocker turn. In-memory only.
  const blockedAudit = new Map<ThreadId, { reason: string; count: number }>();
  // Budget steering: ensures the final budget_limited steering turn fires at most
  // once per goal activation. Reset when the goal leaves budget_limited (resume).
  const budgetSteered = new Set<ThreadId>();
  // Threads enqueued via reconcile() may need a one-shot bootstrap when latestTurn
  // is missing (e.g. goal persisted but the first objective turn never started
  // before restart). Normal trigger paths must not bootstrap — that races with
  // the client's auto-start turn and duplicates the objective.
  const reconcileBootstrapThreadIds = new Set<ThreadId>();

  const canDispatchGoalAutomation = (thread: OrchestrationThread) => {
    if (thread.session?.activeTurnId != null) {
      return false;
    }
    const sessionStatus = thread.session?.status;
    if (sessionStatus !== "ready" && sessionStatus !== "idle") {
      return false;
    }
    if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
      return false;
    }
    if (thread.interactionMode === "plan") {
      return false;
    }
    return true;
  };

  const handleThread = Effect.fn(function* (threadId: ThreadId) {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(threadId),
    );
    if (!thread) {
      return;
    }

    const goal = thread.goal;
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) {
      return;
    }

    const latestTurn = thread.latestTurn;
    if (!latestTurn) {
      if (!reconcileBootstrapThreadIds.delete(threadId)) {
        return;
      }
      if (!canDispatchGoalAutomation(thread)) {
        return;
      }
      const isFreshGoal =
        goal.turnCount === 0 && goal.continuationCount === 0 && thread.messages.length === 0;
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("goal-reconcile-bootstrap"),
        threadId,
        message: {
          messageId: continuationMessageId(),
          role: "user",
          text: isFreshGoal ? goal.objective : renderGoalContinuationPrompt(goal),
          attachments: [],
        },
        inputSource: isFreshGoal ? undefined : "goal-continuation",
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Goal error handling: track consecutive terminal turn errors. Without this the stall
    // is silent — the reactor returns early on non-completed turns, so the user sees no
    // indication the goal is stuck. Worse, manual messages between errors reset the visible
    // state and the reactor dispatches another continuation that errors again, burning
    // budget. Pause after GOAL_ERROR_PAUSE_THRESHOLD so the user can `/goal resume` to retry.
    if (latestTurn.state === "error") {
      const count = (consecutiveErrors.get(threadId) ?? 0) + 1;
      if (count >= GOAL_ERROR_PAUSE_THRESHOLD) {
        consecutiveErrors.delete(threadId);
        lastHandledTurnId.delete(threadId);
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.pause",
          commandId: serverCommandId("goal-pause-errors"),
          threadId,
          createdAt: new Date().toISOString(),
        });
        yield* Effect.logWarning("goal paused after consecutive turn errors", {
          threadId,
          count,
        });
        return;
      }
      consecutiveErrors.set(threadId, count);
      lastHandledTurnId.set(threadId, latestTurn.turnId);
      return;
    }

    // Only act on a turn that has actually completed.
    if (latestTurn.state !== "completed") {
      return;
    }
    // A successful completion resets the error counter.
    consecutiveErrors.delete(threadId);

    if (lastHandledTurnId.get(threadId) === latestTurn.turnId) {
      return;
    }

    if (!canDispatchGoalAutomation(thread)) {
      return;
    }

    // Require the completed turn's assistant message to be persisted before deciding. The
    // turn-diff/session-set triggers can arrive before the message lands in the projection;
    // acting early would read stale text and wrongly suppress the goal forever. Retry on
    // the next trigger instead (without marking the turn handled).
    const assistantMessage = findAssistantMessageForTurn(thread, latestTurn.turnId);
    if (assistantMessage === undefined) {
      return;
    }

    // Completion: the model emitted the sentinel as the final line of its reply after the
    // completion audit. Match against the normalized last line (strip markdown formatting
    // and whitespace) so providers that bold/code-wrap the sentinel still detect correctly.
    const lastLine = assistantMessage.text.trimEnd().split(/\r?\n/).at(-1)?.trim();
    if (
      lastLine !== undefined &&
      normalizeSentinelCandidate(lastLine) === ORCHESTRATION_GOAL_COMPLETION_SENTINEL
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.goal.complete",
        commandId: serverCommandId("goal-complete"),
        threadId,
        createdAt: new Date().toISOString(),
      });
      // Goal is terminal now; drop the per-thread bookkeeping so the map cannot grow
      // unboundedly across the server's lifetime.
      lastHandledTurnId.delete(threadId);
      blockedAudit.delete(threadId);
      budgetSteered.delete(threadId);
      return;
    }

    // Blocked sentinel: the model emitted <goal-blocked/> after its blocked-audit
    // (codex port). Terminal — dispatch the blocked event with the blocker reason
    // extracted from the lines preceding the sentinel.
    if (
      lastLine !== undefined &&
      normalizeSentinelCandidate(lastLine) === ORCHESTRATION_GOAL_BLOCKED_SENTINEL
    ) {
      const blockedReason = extractBlockedReason(assistantMessage.text);
      yield* orchestrationEngine.dispatch({
        type: "thread.goal.blocked",
        commandId: serverCommandId("goal-blocked"),
        threadId,
        blockedReason,
        createdAt: new Date().toISOString(),
      });
      lastHandledTurnId.delete(threadId);
      blockedAudit.delete(threadId);
      budgetSteered.delete(threadId);
      return;
    }

    // Budget steering: when the goal flips to budget_limited (set by applyGoalTurnAccounting
    // in the projector when tokensUsed >= tokenBudget), dispatch one final hidden steering
    // turn telling the model to wrap up and summarize what it accomplished (codex
    // budget_limit.md port). Fire at most once per activation. Budget_limited goals never
    // get continuation dispatches — only the single steering turn, then the goal waits for
    // the user to resume or clear it.
    if (goal.status === "budget_limited") {
      if (!budgetSteered.has(threadId)) {
        budgetSteered.add(threadId);
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("goal-budget-limited"),
          threadId,
          message: {
            messageId: budgetLimitedMessageId(),
            role: "user",
            text: renderGoalBudgetLimitedPrompt(goal),
            attachments: [],
          },
          inputSource: "goal-budget-limited",
          runtimeMode: thread.runtimeMode,
          interactionMode: "default",
          dispatchMode: "queue",
          createdAt: new Date().toISOString(),
        });
      }
      lastHandledTurnId.set(threadId, latestTurn.turnId);
      return;
    }

    // Blocked-audit: if the assistant text contains a blocker marker (heuristic —
    // "I'm blocked", "cannot proceed", "blocked by"), track recurrence. Same blocker
    // GOAL_BLOCKED_AUDIT_THRESHOLD turns in a row → dispatch thread.goal.blocked.
    // This catches blockers the model reports without emitting the explicit sentinel.
    const blockerReason = detectBlockerHeuristic(assistantMessage.text);
    if (blockerReason !== null) {
      const prev = blockedAudit.get(threadId);
      const nextCount = prev && prev.reason === blockerReason ? prev.count + 1 : 1;
      blockedAudit.set(threadId, { reason: blockerReason, count: nextCount });
      if (nextCount >= GOAL_BLOCKED_AUDIT_THRESHOLD) {
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.blocked",
          commandId: serverCommandId("goal-blocked-audit"),
          threadId,
          blockedReason: blockerReason,
          createdAt: new Date().toISOString(),
        });
        lastHandledTurnId.delete(threadId);
        blockedAudit.delete(threadId);
        budgetSteered.delete(threadId);
        return;
      }
    } else {
      // Non-blocker turn resets the audit.
      blockedAudit.delete(threadId);
    }

    // No-activity suppression (pi-goal guardrail): if the last turn was a
    // continuation turn that produced no tool activity, the agent is stuck in
    // a reasoning loop without acting. Stop continuing and wait for fresh user
    // input — the next user message produces a non-continuation turn whose
    // starter message has a different source, naturally resetting this check.
    const starterMessage = thread.messages.find(
      (m) => m.role === "user" && m.turnId === latestTurn.turnId && m.source === "goal-continuation",
    );
    if (starterMessage !== undefined) {
      const hadToolActivity = thread.activities.some(
        (a) => a.turnId === latestTurn.turnId && a.tone === "tool",
      );
      if (!hadToolActivity) {
        lastHandledTurnId.set(threadId, latestTurn.turnId);
        yield* Effect.logInfo("goal continuation suppressed: no tool activity", {
          threadId,
          turnId: latestTurn.turnId,
        });
        return;
      }
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("goal-continuation"),
      threadId,
      message: {
        messageId: continuationMessageId(),
        role: "user",
        text: renderGoalContinuationPrompt(goal),
        attachments: [],
      },
      inputSource: "goal-continuation",
      runtimeMode: thread.runtimeMode,
      interactionMode: "default",
      dispatchMode: "queue",
      createdAt: new Date().toISOString(),
    });
    // Only mark the turn handled after a successful dispatch; if the dispatch above
    // fails the turn stays unhandled and a later trigger retries instead of stalling.
    lastHandledTurnId.set(threadId, latestTurn.turnId);
  });

  const handleThreadSafely = (threadId: ThreadId) =>
    handleThread(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("goal continuation reactor failed to process thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(handleThreadSafely);

  const start: GoalContinuationReactorShape["start"] = Effect.fn(function* () {
    // Wrap the stream consumer in Effect.retry so a stream-level failure (PubSub closed,
    // engine crash) doesn't permanently kill the reactor. The per-event Effect.catchCause
    // already prevents per-event errors from killing the stream — this handles stream-level
    // failures. The 1s delay prevents tight restart loops. Matches the verified pattern in
    // ProviderSessionReaper.ts:79 (Schedule.spaced without Schedule.forever).
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!TRIGGER_EVENT_TYPES.has(event.type)) {
          return Effect.void;
        }
        const threadId = triggerThreadId(event);
        return threadId === null ? Effect.void : worker.enqueue(threadId);
      }).pipe(Effect.retry(Schedule.spaced(Duration.seconds(1)))),
    );
  });

  return {
    start,
    drain: worker.drain,
    reconcile: (threadIds) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          Effect.sync(() => {
            reconcileBootstrapThreadIds.add(threadId as ThreadId);
          }).pipe(
            Effect.andThen(Effect.sleep(Duration.millis(500))),
            Effect.andThen(() => worker.enqueue(threadId as ThreadId)),
          ),
        { discard: true },
      ),
  } satisfies GoalContinuationReactorShape;
});

export const GoalContinuationReactorLive = Layer.effect(GoalContinuationReactor, make);
