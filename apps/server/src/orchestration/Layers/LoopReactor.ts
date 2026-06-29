import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Cause, Duration, Effect, Fiber, Layer, Option, Schedule, Stream } from "effect";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";

import {
  LoopReactor,
  type LoopReactorShape,
} from "../Services/LoopReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

// Same trigger set as GoalContinuationReactor: events that mean "a turn may have
// just settled" or "the loop/interaction state changed in a way that should
// re-evaluate dispatch". Plus thread.loop-resumed (the reactor owns post-resume
// dispatch, same as goal-resumed).
const TRIGGER_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-diff-completed",
  "thread.session-set",
  "thread.loop-resumed",
  "thread.interaction-mode-set",
  "thread.activity-appended",
]);

function triggerThreadId(event: OrchestrationEvent): ThreadId | null {
  if (
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.session-set" ||
    event.type === "thread.loop-resumed" ||
    event.type === "thread.interaction-mode-set" ||
    event.type === "thread.activity-appended"
  ) {
    return event.payload.threadId;
  }
  return null;
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const loopIterationMessageId = (): MessageId =>
  MessageId.makeUnsafe(`loop-iteration:${crypto.randomUUID()}`);

const LOOP_ERROR_PAUSE_THRESHOLD = 3;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // We act at most once per completed turn per thread.
  const lastHandledTurnId = new Map<ThreadId, TurnId>();
  // Ephemeral per-thread consecutive-error counter. Reset on successful completion.
  const consecutiveErrors = new Map<ThreadId, number>();
  // Per-thread scheduled wake-up fibers: when the interval hasn't elapsed yet,
  // we fork a fiber that sleeps for the remaining time then re-enqueues. Cancelled
  // on the next trigger event or when the loop is cleared/paused.
  const wakeUpFibers = new Map<ThreadId, Fiber.Fiber<void, never>>();

  // Forward declaration: worker is assigned after handleThread/handleThreadSafely
  // are defined. handleThread references worker via this binding for wake-up re-enqueue.
  let worker: DrainableWorker<ThreadId> | undefined;

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }

  function asFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // Scan activities backwards for the latest context-window.updated usedPercent.
  function latestUsedPercent(thread: OrchestrationThread): number | null {
    for (let i = thread.activities.length - 1; i >= 0; i -= 1) {
      const activity = thread.activities[i];
      if (!activity || activity.kind !== "context-window.updated") {
        continue;
      }
      const payload = asRecord(activity.payload);
      const rawPercent = asFiniteNumber(payload?.usedPercent);
      if (rawPercent !== null) {
        return Math.max(0, Math.min(100, rawPercent));
      }
      const usedTokens = asFiniteNumber(payload?.usedTokens);
      const maxTokens = asFiniteNumber(payload?.maxTokens);
      if (usedTokens !== null && maxTokens !== null && maxTokens > 0) {
        return Math.min(100, (usedTokens / maxTokens) * 100);
      }
    }
    return null;
  }

  const handleThread = Effect.fn(function* (threadId: ThreadId) {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(threadId),
    );
    if (!thread) {
      return;
    }

    const loop = thread.loop;
    if (!loop || loop.status !== "active") {
      return;
    }

    // Loop death: if the session is stopped or errored, clear the loop.
    const sessionStatus = thread.session?.status;
    if (sessionStatus === "stopped" || sessionStatus === "error") {
      const existing = wakeUpFibers.get(threadId);
      if (existing) {
        wakeUpFibers.delete(threadId);
        yield* Fiber.interrupt(existing);
      }
      lastHandledTurnId.delete(threadId);
      consecutiveErrors.delete(threadId);
      yield* orchestrationEngine.dispatch({
        type: "thread.loop.clear",
        commandId: serverCommandId("loop-clear-session-stopped"),
        threadId,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const latestTurn = thread.latestTurn;
    if (!latestTurn) {
      return;
    }

    // Error handling: track consecutive terminal turn errors. Pause after
    // LOOP_ERROR_PAUSE_THRESHOLD so the user knows the loop is stuck.
    if (latestTurn.state === "error") {
      const count = (consecutiveErrors.get(threadId) ?? 0) + 1;
      if (count >= LOOP_ERROR_PAUSE_THRESHOLD) {
        consecutiveErrors.delete(threadId);
        lastHandledTurnId.delete(threadId);
        const existing = wakeUpFibers.get(threadId);
        if (existing) {
          wakeUpFibers.delete(threadId);
          yield* Fiber.interrupt(existing);
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.loop.pause",
          commandId: serverCommandId("loop-pause-errors"),
          threadId,
          createdAt: new Date().toISOString(),
        });
        yield* Effect.logWarning("loop paused after consecutive turn errors", {
          threadId,
          count,
        });
        return;
      }
      consecutiveErrors.set(threadId, count);
      lastHandledTurnId.set(threadId, latestTurn.turnId);
      return;
    }

    if (latestTurn.state !== "completed") {
      return;
    }
    consecutiveErrors.delete(threadId);

    if (lastHandledTurnId.get(threadId) === latestTurn.turnId) {
      return;
    }

    // The agent must be free.
    if (thread.session?.activeTurnId != null) {
      return;
    }
    if (sessionStatus !== "ready" && sessionStatus !== "idle") {
      return;
    }

    // Never override a human in the loop.
    if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
      return;
    }

    // Plan mode is read-only planning; do not apply loop pressure.
    if (thread.interactionMode === "plan") {
      return;
    }

    // Pre-dispatch usage check: if context usage is above 80%, skip this iteration.
    // The CompactionReactor will compact, and the loop re-evaluates on the
    // compaction's thread.activity-appended event.
    const usedPercent = latestUsedPercent(thread);
    if (usedPercent !== null && usedPercent >= 80) {
      // Don't mark as handled — re-evaluate when compaction drops usage.
      return;
    }

    // Interval enforcement: wait `intervalSeconds` after the last turn completion
    // before firing the next iteration. If the turn took longer than the interval,
    // fire immediately (no stacking, no overlap).
    const completedAt = latestTurn.completedAt;
    if (completedAt !== null) {
      const elapsedMs = Date.now() - Date.parse(completedAt);
      const intervalMs = loop.intervalSeconds * 1000;
      if (elapsedMs < intervalMs) {
        // Cancel any existing wake-up fiber and fork a new one for the remaining time.
        const existing = wakeUpFibers.get(threadId);
        if (existing) {
          yield* Fiber.interrupt(existing);
        }
        const remainingMs = intervalMs - elapsedMs;
        const wakeEffect: Effect.Effect<void, never, never> = Effect.sleep(
          Duration.millis(remainingMs),
        ).pipe(
          Effect.flatMap(() => worker?.enqueue(threadId) ?? Effect.void),
        );
        const fiber = yield* Effect.forkDetach(wakeEffect);
        wakeUpFibers.set(threadId, fiber as Fiber.Fiber<void, never>);
        return;
      }
    }

    // Cancel any pending wake-up fiber — we're dispatching now.
    const existing = wakeUpFibers.get(threadId);
    if (existing) {
      wakeUpFibers.delete(threadId);
      yield* Fiber.interrupt(existing);
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("loop-iteration"),
      threadId,
      message: {
        messageId: loopIterationMessageId(),
        role: "user",
        text: loop.prompt,
        attachments: [],
      },
      inputSource: "loop-iteration",
      runtimeMode: thread.runtimeMode,
      interactionMode: "default",
      dispatchMode: "queue",
      createdAt: new Date().toISOString(),
    });
    lastHandledTurnId.set(threadId, latestTurn.turnId);
  });

  const handleThreadSafely = (threadId: ThreadId) =>
    handleThread(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("loop reactor failed to process thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  worker = yield* makeDrainableWorker(handleThreadSafely);

  const start: LoopReactorShape["start"] = Effect.fn(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!TRIGGER_EVENT_TYPES.has(event.type)) {
          return Effect.void;
        }
        const threadId = triggerThreadId(event);
        return threadId === null ? Effect.void : worker!.enqueue(threadId);
      }).pipe(Effect.retry(Schedule.spaced(Duration.seconds(1)))),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies LoopReactorShape;
});

export const LoopReactorLive = Layer.effect(LoopReactor, make);
