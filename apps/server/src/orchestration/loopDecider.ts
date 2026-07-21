// FILE: loopDecider.ts
// Purpose: Single owner of every `/loop` command transition. `decider.ts` case
//          arms delegate here so the continuation policy, budget validation,
//          and stop semantics live in one module.
// Layer: Orchestration decision logic
// Depends on: loopDecision.ts (pure continuation policy), @synara/shared/loop

import type {
  OrchestrationCommand,
  OrchestrationThread,
  ThreadLoop,
  ThreadLoopContinuedPayload,
  ThreadLoopOffPayload,
  ThreadLoopSetPayload,
  ThreadLoopWaitNotedPayload,
  ThreadMessageSentPayload,
  ThreadTurnPurpose,
  ThreadTurnStartRequestedPayload,
} from "@synara/contracts";
import {
  DEFAULT_TURN_DISPATCH_MODE,
  LOOP_DEFAULT_ARMED_MAX_ITERATIONS,
  LoopActivationId,
  MessageId,
  LOOP_DEFAULT_HARD_CAP,
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
  LOOP_PROMPT_MAX_INPUT_CHARS,
  LoopPrompt,
} from "@synara/contracts";
import { validateLoopBudget } from "@synara/shared/loop";
import { Schema } from "effect";

import {
  buildLoopContinuationThreadView,
  chooseStopReason,
  decideLoopContinuation,
  effectiveCap,
  RUNNING_SESSION_STATUSES,
} from "./loopDecision.ts";

export type LoopEventDraft =
  | { type: "thread.loop-set"; payload: typeof ThreadLoopSetPayload.Type }
  | { type: "thread.loop-off"; payload: typeof ThreadLoopOffPayload.Type }
  | { type: "thread.loop-wait-noted"; payload: typeof ThreadLoopWaitNotedPayload.Type }
  | { type: "thread.loop-continued"; payload: typeof ThreadLoopContinuedPayload.Type }
  | { type: "thread.message-sent"; payload: typeof ThreadMessageSentPayload.Type }
  | { type: "thread.turn-start-requested"; payload: typeof ThreadTurnStartRequestedPayload.Type };

export type LoopCommandDecision =
  | { kind: "invalid"; detail: string }
  | { kind: "events"; events: ReadonlyArray<LoopEventDraft> };

type LoopSetCommand = Extract<OrchestrationCommand, { type: "thread.loop.set" }>;
type LoopOffCommand = Extract<OrchestrationCommand, { type: "thread.loop.off" }>;
type LoopToggleCommand = Extract<OrchestrationCommand, { type: "thread.loop.toggle" }>;
type LoopContinueCommand = Extract<OrchestrationCommand, { type: "thread.loop.continue" }>;

const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;

function invalid(detail: string): LoopCommandDecision {
  return { kind: "invalid", detail };
}

function events(drafts: ReadonlyArray<LoopEventDraft>): LoopCommandDecision {
  return { kind: "events", events: drafts };
}

function requireLoopableThread(
  thread: OrchestrationThread,
): { kind: "ok" } | { kind: "invalid"; detail: string } {
  if (thread.parentThreadId !== null) {
    return { kind: "invalid", detail: `Loops are only allowed on top-level threads.` };
  }
  if (thread.deletedAt !== null) {
    return { kind: "invalid", detail: `Thread '${thread.id}' is deleted.` };
  }
  if (thread.archivedAt !== null) {
    return { kind: "invalid", detail: `Thread '${thread.id}' is archived.` };
  }
  return { kind: "ok" };
}

function describeBudgetError(error: NonNullable<ReturnType<typeof validateLoopBudget>>): string {
  switch (error.field) {
    case "budget":
      return `Cannot set both a count and a duration budget.`;
    case "maxIterations":
      return `maxIterations must be between 1 and ${LOOP_MAX_COUNT_BUDGET}.`;
    case "durationSeconds":
      return `durationSeconds must be between 1 and ${LOOP_MAX_DURATION_SECONDS}.`;
  }
}

// Deterministic loop user-message identity: at-least-once command execution
// must never mint divergent message ids for the same continuation.
function loopMessageIdForCommand(command: LoopContinueCommand): MessageId {
  return MessageId.makeUnsafe(`loop-msg:${command.commandId}`);
}

export function decideLoopSet(
  command: LoopSetCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  const loopable = requireLoopableThread(thread);
  if (loopable.kind === "invalid") {
    return invalid(loopable.detail);
  }
  const budgetError = validateLoopBudget({
    maxIterations: command.maxIterations,
    durationSeconds: command.durationSeconds,
  });
  if (budgetError !== null) {
    return invalid(describeBudgetError(budgetError));
  }

  const existingLoop = thread.loop?.active === true ? thread.loop : null;
  if (
    command.expectedActivationId !== undefined &&
    existingLoop?.activationId !== command.expectedActivationId
  ) {
    return invalid(`Loop activation '${command.expectedActivationId}' is no longer active.`);
  }
  const isReconfigure = existingLoop !== null;
  // Duration budget is anchored from server time so a stale client clock cannot
  // artificially extend or shorten a loop run.
  const endsAt =
    command.durationSeconds !== null
      ? new Date(Date.parse(command.createdAt) + command.durationSeconds * 1000).toISOString()
      : null;

  let prompt: string;
  if (command.prompt !== null && command.prompt.length > 0) {
    try {
      prompt = Schema.decodeUnknownSync(LoopPrompt)(command.prompt);
    } catch {
      return invalid(
        `Loop prompt must be 1-${LOOP_PROMPT_MAX_INPUT_CHARS} characters, not whitespace-only, and cannot start with a slash command.`,
      );
    }
  } else if (command.prompt !== null && command.prompt.length === 0) {
    // Tri-state contract: null preserves, non-empty replaces. An explicit empty
    // string must never silently clear an active loop's prompt.
    if (isReconfigure && existingLoop.prompt !== "") {
      return invalid(
        `Loop prompt cannot be cleared with an empty string; pass null to preserve it or non-empty text to replace it.`,
      );
    }
    prompt = "";
  } else {
    prompt = isReconfigure ? existingLoop.prompt : "";
  }
  // Budget-less loops default to the guided-UI count budget instead of running
  // to the hard cap.
  const maxIterations =
    command.maxIterations === null && command.durationSeconds === null
      ? LOOP_DEFAULT_ARMED_MAX_ITERATIONS
      : command.maxIterations;

  // Locked reconfigure rule: any successful set while active starts a new
  // activation window — counters reset, new activationId, original createdAt.
  const loop: ThreadLoop = {
    active: true,
    prompt,
    iteration: 0,
    maxIterations,
    endsAt,
    hardCap: LOOP_DEFAULT_HARD_CAP,
    consecutiveErrors: 0,
    lastStopReason: null,
    activationId: LoopActivationId.makeUnsafe(command.commandId),
    createdAt: isReconfigure ? existingLoop.createdAt : command.createdAt,
    updatedAt: command.createdAt,
  };
  return events([
    {
      type: "thread.loop-set",
      payload: { threadId: command.threadId, loop },
    },
  ]);
}

export function decideLoopOff(
  command: LoopOffCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  const loop = thread.loop;
  // Thread never had a loop: emit nothing rather than fabricating a synthetic
  // ThreadLoop for an activation that never existed.
  if (loop === null || loop === undefined) {
    return events([]);
  }
  const stopReason = command.reason ?? "user_stop";
  return events([
    {
      type: "thread.loop-off",
      payload: {
        threadId: command.threadId,
        stopReason,
        // Idempotent off: an already-off loop is re-emitted unchanged.
        loop: loop.active
          ? {
              ...loop,
              active: false,
              lastStopReason: stopReason,
              updatedAt: command.createdAt,
            }
          : loop,
      },
    },
  ]);
}

export function decideLoopToggle(
  command: LoopToggleCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  if (thread.loop?.active === true) {
    // Bare `/loop` while active toggles future iterations off but leaves a
    // currently running loop-owned turn alone to settle on its own.
    return events([
      {
        type: "thread.loop-off",
        payload: {
          threadId: command.threadId,
          stopReason: "toggled_off",
          loop: {
            ...thread.loop,
            active: false,
            lastStopReason: "toggled_off",
            updatedAt: command.createdAt,
          },
        },
      },
    ]);
  }

  const loopable = requireLoopableThread(thread);
  if (loopable.kind === "invalid") {
    return invalid(loopable.detail);
  }

  const loop: ThreadLoop = {
    active: true,
    prompt: "",
    iteration: 0,
    // Toggle-armed loops carry the safe default count budget, not hardCap-only.
    maxIterations: LOOP_DEFAULT_ARMED_MAX_ITERATIONS,
    endsAt: null,
    hardCap: LOOP_DEFAULT_HARD_CAP,
    consecutiveErrors: 0,
    lastStopReason: null,
    activationId: LoopActivationId.makeUnsafe(command.commandId),
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return events([
    {
      type: "thread.loop-set",
      payload: { threadId: command.threadId, loop },
    },
  ]);
}

export function decideLoopContinue(
  command: LoopContinueCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  if (thread.loop?.active !== true) {
    return events([]);
  }
  if (
    command.expectedUpdatedAt !== undefined &&
    thread.loop.updatedAt !== command.expectedUpdatedAt
  ) {
    return events([]);
  }
  if (
    command.expectedActivationId !== undefined &&
    thread.loop.activationId !== command.expectedActivationId
  ) {
    return events([]);
  }
  const decision = decideLoopContinuation({
    loop: thread.loop,
    // Anchored to the command, not wall clock, so replays classify identically.
    nowMs: Date.parse(command.createdAt),
    thread: buildLoopContinuationThreadView(thread),
  });

  if (decision.type === "wait") {
    // Waits persist no accounting, but must still produce an event: a
    // zero-event command is rejected with a durable receipt, permanently
    // burning this deterministic commandId. The dedicated wait-noted event
    // bumps updatedAt to rotate the next continuation commandId without
    // re-triggering LoopReactor the way thread.loop-set would.
    return events([
      {
        type: "thread.loop-wait-noted",
        payload: {
          threadId: command.threadId,
          loop: {
            ...thread.loop,
            updatedAt: command.createdAt,
          },
        },
      },
    ]);
  }
  if (decision.type === "off") {
    return events([
      {
        type: "thread.loop-off",
        payload: {
          threadId: command.threadId,
          stopReason: decision.reason,
          loop: {
            ...thread.loop,
            active: false,
            lastStopReason: decision.reason,
            consecutiveErrors: decision.nextConsecutiveErrors,
            updatedAt: command.createdAt,
          },
        },
      },
    ]);
  }
  const prompt = thread.loop.prompt;
  if (prompt === "") {
    // Unreachable: the decision policy waits on a missing prompt.
    return events([]);
  }
  const messageId = loopMessageIdForCommand(command);
  const nextIteration = decision.nextIteration;
  const loop = {
    ...thread.loop,
    iteration: nextIteration,
    consecutiveErrors: decision.nextConsecutiveErrors,
    lastStopReason: null,
    updatedAt: command.createdAt,
  } satisfies ThreadLoop;
  const purpose: ThreadTurnPurpose = {
    kind: "loop-iteration",
    activationId: loop.activationId,
    iteration: nextIteration,
  };
  return events([
    {
      type: "thread.message-sent",
      payload: {
        threadId: command.threadId,
        messageId,
        role: "user",
        text: prompt,
        dispatchMode: DEFAULT_TURN_DISPATCH_MODE,
        turnId: null,
        streaming: false,
        source: "native",
        purpose,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    },
    {
      type: "thread.turn-start-requested",
      payload: {
        threadId: command.threadId,
        messageId,
        assistantDeliveryMode: DEFAULT_ASSISTANT_DELIVERY_MODE,
        dispatchMode: DEFAULT_TURN_DISPATCH_MODE,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        purpose,
        createdAt: command.createdAt,
      },
    },
    {
      type: "thread.loop-continued",
      payload: {
        threadId: command.threadId,
        nextIteration,
        nextConsecutiveErrors: decision.nextConsecutiveErrors,
        loop,
      },
    },
  ]);
}

export function decideLoopCommand(
  command: LoopSetCommand | LoopOffCommand | LoopToggleCommand | LoopContinueCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  switch (command.type) {
    case "thread.loop.set":
      return decideLoopSet(command, thread);
    case "thread.loop.off":
      return decideLoopOff(command, thread);
    case "thread.loop.toggle":
      return decideLoopToggle(command, thread);
    case "thread.loop.continue":
      return decideLoopContinue(command, thread);
  }
}

export type ManualMessageLoopDecision =
  | { kind: "none" }
  | { kind: "loop-off"; payload: typeof ThreadLoopOffPayload.Type }
  | {
      kind: "loop-continued";
      payload: typeof ThreadLoopContinuedPayload.Type;
      purpose: ThreadTurnPurpose;
    };

/**
 * Policy for a manual `thread.turn.start` while a loop is active: the message
 * either retires the loop (budget exhausted, unsupported content, racing
 * pending loop start, invalid prompt) or becomes the next loop-owned iteration
 * with the manual text as the new prompt. Shares the budget/expiry math with
 * `decideLoopContinuation` via the same helpers and clock anchor.
 */
export function decideManualMessageWhileLoopActive(input: {
  loop: ThreadLoop;
  thread: OrchestrationThread;
  message: { text: string; hasAttachments: boolean; hasStructuredReferences: boolean };
  createdAt: string;
}): ManualMessageLoopDecision {
  const { loop, thread, message, createdAt } = input;
  const nowMs = Date.parse(createdAt);
  const loopOff = (
    stopReason: NonNullable<ThreadLoop["lastStopReason"]>,
  ): ManualMessageLoopDecision => ({
    kind: "loop-off",
    payload: {
      threadId: thread.id,
      stopReason,
      loop: {
        ...loop,
        active: false,
        lastStopReason: stopReason,
        updatedAt: createdAt,
      },
    },
  });

  const pendingLoopStart =
    thread.pendingTurnStart?.purpose?.kind === "loop-iteration" &&
    thread.pendingTurnStart.purpose.activationId === loop.activationId;

  if (message.hasAttachments || message.hasStructuredReferences) {
    // Text-only v1: loop prompts cannot carry attachments, skill references,
    // or mentions.
    return loopOff("attachments_not_supported");
  }
  if (loop.endsAt !== null) {
    const endsAtMs = Date.parse(loop.endsAt);
    // Fail closed on unparseable endsAt, mirroring decideLoopContinuation.
    if (!Number.isFinite(endsAtMs) || nowMs >= endsAtMs) {
      // Duration budget has expired: stop the loop, but let the user's manual
      // message continue as a normal turn.
      return loopOff("budget_duration");
    }
  }
  if (loop.iteration >= effectiveCap(loop)) {
    // Budget already exhausted: stop the loop, but let the user's manual
    // message continue as a normal turn.
    return loopOff(chooseStopReason(loop));
  }
  if (pendingLoopStart) {
    // A loop-owned turn start is already pending; a racing manual message
    // wins and retires the loop rather than fighting the pending start.
    return loopOff("replaced_by_manual_policy");
  }

  // A manual user message while the loop is active becomes (or replaces)
  // the loop prompt and doubles as the next loop-owned iteration.
  let manualPrompt: LoopPrompt;
  try {
    manualPrompt = Schema.decodeUnknownSync(LoopPrompt)(message.text);
  } catch {
    return loopOff("prompt_invalid");
  }
  const nextIteration = loop.iteration + 1;
  const purpose: ThreadTurnPurpose = {
    kind: "loop-iteration",
    activationId: loop.activationId,
    iteration: nextIteration,
  };
  return {
    kind: "loop-continued",
    purpose,
    payload: {
      threadId: thread.id,
      nextIteration,
      nextConsecutiveErrors: loop.consecutiveErrors,
      loop: {
        ...loop,
        prompt: manualPrompt,
        iteration: nextIteration,
        lastStopReason: null,
        updatedAt: createdAt,
      },
    },
  };
}

/**
 * Stop-now atomicity: interrupting is inherently a stop intent. The loop turns
 * off when the interrupted turn is loop-owned, and also when no concrete turn
 * can be resolved but the session is live (starting/running/stopping) or a
 * loop-owned start is pending — otherwise the loop would silently survive a
 * user's Stop.
 */
export function decideInterruptLoopOff(input: {
  thread: OrchestrationThread;
  interruptTurnId: string | undefined;
  isLoopOwnedInterrupt: boolean;
  createdAt: string;
}): typeof ThreadLoopOffPayload.Type | null {
  const { thread, interruptTurnId, isLoopOwnedInterrupt, createdAt } = input;
  const loop = thread.loop;
  if (loop?.active !== true) {
    return null;
  }
  const pendingLoopStart =
    thread.pendingTurnStart?.purpose?.kind === "loop-iteration" &&
    thread.pendingTurnStart.purpose.activationId === loop.activationId;
  const sessionLive =
    thread.session !== null && RUNNING_SESSION_STATUSES.has(thread.session.status);
  const shouldStop =
    isLoopOwnedInterrupt || (interruptTurnId === undefined && (sessionLive || pendingLoopStart));
  if (!shouldStop) {
    return null;
  }
  return {
    threadId: thread.id,
    stopReason: "user_stop",
    loop: {
      ...loop,
      active: false,
      lastStopReason: "user_stop",
      updatedAt: createdAt,
    },
  };
}
