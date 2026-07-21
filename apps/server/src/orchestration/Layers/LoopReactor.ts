// FILE: LoopReactor.ts
// Purpose: Automatically continue `/loop` iterations on terminal settlement, arm, and duration expiry.
// Layer: Orchestration runtime reactor

import {
  CommandId,
  type LoopStopReason,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadLoop,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Ref, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { buildLoopContinuationThreadView, decideLoopContinuation } from "../loopDecision.ts";
import { ProjectionThreadLoopRepository } from "../../persistence/Services/ProjectionThreadLoop.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { LoopReactor, type LoopReactorShape } from "../Services/LoopReactor.ts";

function isStartupReconciliationCommandId(commandId: string): boolean {
  return commandId.startsWith("restart-reconcile:");
}

const BLOCKER_RESOLVED_ACTIVITY_KINDS = new Set(["approval.resolved", "user-input.resolved"]);

function isBlockerResolvedActivity(activity: { kind: string }): boolean {
  return BLOCKER_RESOLVED_ACTIVITY_KINDS.has(activity.kind);
}

// Deterministic continuation identity: the same {thread, loop state version,
// iteration count} always maps to the same commandId, so duplicate signals
// (event replays, races between reactor triggers) collapse in the engine's
// command receipt/fingerprint dedupe instead of needing a durable claim ledger.
function makeLoopContinueCommandId(
  threadId: OrchestrationThread["id"],
  loop: ThreadLoop,
): CommandId {
  return CommandId.makeUnsafe(`loop-continue:${threadId}:${loop.updatedAt}:${loop.iteration}`);
}

function dispatchLoopContinue(options: {
  orchestrationEngine: OrchestrationEngineShape;
  thread: OrchestrationThreadShell;
  loop: ThreadLoop;
  createdAt: string;
}): Effect.Effect<void, never> {
  const { orchestrationEngine, thread, loop, createdAt } = options;
  const threadId = thread.id;

  if (!loop.active) {
    return Effect.void;
  }

  // Pre-evaluate the pure policy against the same shell state. A wait outcome
  // must not reach the engine: a command that produces no events is rejected
  // with a durable receipt, burning this deterministic commandId.
  const decision = decideLoopContinuation({
    loop,
    nowMs: Date.parse(createdAt) || Date.now(),
    thread: buildLoopContinuationThreadView(thread),
  });
  if (decision.type === "wait") {
    return Effect.void;
  }

  const command = {
    type: "thread.loop.continue" as const,
    commandId: makeLoopContinueCommandId(threadId, loop),
    threadId,
    expectedUpdatedAt: loop.updatedAt,
    expectedActivationId: loop.activationId,
    createdAt,
  } satisfies Extract<OrchestrationCommand, { type: "thread.loop.continue" }>;

  return orchestrationEngine.dispatch(command).pipe(
    Effect.catch((error) =>
      Effect.logWarning("loop continuation dispatch failed", {
        threadId,
        error: String(error),
      }),
    ),
    Effect.asVoid,
  );
}

const makeLoopReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionThreadLoopRepository = yield* ProjectionThreadLoopRepository;

  // Duration-budget loops need a wall-clock wake: a loop blocked on approval or
  // user input receives no settlement event, so without a timer it would sit
  // past `endsAt` indefinitely. One deadline entry per active duration loop; a
  // single timer fiber sleeps until min(endsAt) and re-arms on every change.
  const durationDeadlinesRef = yield* Ref.make(new Map<OrchestrationThreadShell["id"], number>());
  const timerWakeQueue = yield* Queue.unbounded<void>();

  const syncDurationDeadline = (
    threadId: OrchestrationThreadShell["id"],
    loop: ThreadLoop | null,
  ) =>
    Effect.gen(function* () {
      const endsAtMs =
        loop?.active === true && loop.endsAt !== null ? Date.parse(loop.endsAt) : null;
      const deadline = endsAtMs !== null && Number.isFinite(endsAtMs) ? endsAtMs : null;
      const deadlines = yield* Ref.get(durationDeadlinesRef);
      if ((deadlines.get(threadId) ?? null) === deadline) {
        return;
      }
      yield* Ref.update(durationDeadlinesRef, (current) => {
        const next = new Map(current);
        if (deadline === null) {
          next.delete(threadId);
        } else {
          next.set(threadId, deadline);
        }
        return next;
      });
      yield* Queue.offer(timerWakeQueue, undefined);
    });

  const continueThread = (threadId: OrchestrationThreadShell["id"], createdAt: string) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(threadOption)) {
        return;
      }
      const loop = threadOption.value.loop;
      if (loop?.active === true) {
        yield* dispatchLoopContinue({
          orchestrationEngine,
          thread: threadOption.value,
          loop,
          createdAt,
        });
      }
    });

  const restoreActiveLoops: LoopReactorShape["restoreActiveLoops"] = Effect.gen(function* () {
    // Projection/query infrastructure failures must propagate: silently
    // treating them as an empty snapshot would skip loop restoration and
    // strand active loops after a restart.
    const readModel = yield* projectionSnapshotQuery.getShellSnapshot().pipe(Effect.orDie);
    const now = new Date().toISOString();
    for (const thread of readModel.threads) {
      if (thread.loop?.active === true) {
        yield* syncDurationDeadline(thread.id, thread.loop);
        yield* dispatchLoopContinue({
          orchestrationEngine,
          thread,
          loop: thread.loop,
          createdAt: now,
        });
      }
    }
  });

  // Single timer fiber: sleep until the earliest deadline (no interval
  // polling), racing against wake signals that fire whenever the active loop
  // set or any `endsAt` changes. On expiry, dispatch the same pre-checked
  // continue path; the decider then turns the loop off with `budget_duration`.
  const runDurationExpiryTimer = Effect.gen(function* () {
    while (true) {
      const deadlines = yield* Ref.get(durationDeadlinesRef);
      let nextWakeMs: number | null = null;
      for (const endsAtMs of deadlines.values()) {
        if (nextWakeMs === null || endsAtMs < nextWakeMs) {
          nextWakeMs = endsAtMs;
        }
      }
      if (nextWakeMs === null) {
        yield* Queue.take(timerWakeQueue);
        continue;
      }
      const delayMs = Math.max(0, nextWakeMs - Date.now());
      const outcome = yield* Effect.race(
        Queue.take(timerWakeQueue).pipe(Effect.as("reset" as const)),
        Effect.sleep(delayMs).pipe(Effect.as("expired" as const)),
      );
      if (outcome === "reset") {
        continue;
      }
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const expired = [...deadlines].filter(([, endsAtMs]) => endsAtMs <= nowMs);
      // Drop fired entries up front so a rejected dispatch cannot hot-loop the
      // timer; a subsequent thread.loop-set event re-adds any still-live loop.
      yield* Ref.update(durationDeadlinesRef, (current) => {
        const next = new Map(current);
        for (const [threadId] of expired) {
          next.delete(threadId);
        }
        return next;
      });
      for (const [threadId] of expired) {
        yield* continueThread(threadId, nowIso).pipe(
          Effect.catch((error) =>
            Effect.logWarning("loop duration expiry continue failed", {
              threadId,
              error: String(error),
            }),
          ),
        );
      }
    }
  });

  const start: LoopReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(runDurationExpiryTimer);
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "thread.loop-set") {
            yield* syncDurationDeadline(event.payload.threadId, event.payload.loop);
            yield* continueThread(event.payload.threadId, event.occurredAt);
            return;
          }

          if (event.type === "thread.loop-continued" || event.type === "thread.loop-off") {
            yield* syncDurationDeadline(event.payload.threadId, event.payload.loop);
            return;
          }

          if (event.type === "thread.activity-appended") {
            if (!isBlockerResolvedActivity(event.payload.activity)) {
              return;
            }
            // Startup turn reconciliation emits blocker-resolved activities for
            // stale pending requests. Ignore them here; restoreActiveLoops runs
            // after reconciliation and will continue eligible loops exactly once.
            if (isStartupReconciliationCommandId(String(event.commandId))) {
              return;
            }
            yield* continueThread(event.payload.threadId, event.occurredAt);
            return;
          }

          if (event.type === "thread.interaction-mode-set") {
            yield* continueThread(event.payload.threadId, event.occurredAt);
            return;
          }

          if (event.type === "thread.session-set") {
            if (isStartupReconciliationCommandId(String(event.commandId))) {
              // Do not continue during startup turn reconciliation; the orphaned
              // turn is being interrupted and projection is being rebuilt.
              // restoreActiveLoops runs after reconciliation and will issue the
              // single startup continue for this thread if still eligible.
              return;
            }
            yield* continueThread(event.payload.threadId, event.occurredAt);
            return;
          }

          if (event.type === "thread.archived" || event.type === "thread.deleted") {
            yield* syncDurationDeadline(event.payload.threadId, null);
            const loopOption = yield* projectionThreadLoopRepository.getByThreadId({
              threadId: event.payload.threadId,
            });
            if (Option.isNone(loopOption) || loopOption.value.loop.active !== true) {
              return;
            }
            const reason: LoopStopReason =
              event.type === "thread.archived" ? "thread_archived" : "thread_deleted";
            const command = {
              type: "thread.loop.off" as const,
              commandId: CommandId.makeUnsafe(
                `loop-off:${event.payload.threadId}:${String(event.sequence)}`,
              ),
              threadId: event.payload.threadId,
              reason,
              createdAt: event.occurredAt,
            } satisfies Extract<OrchestrationCommand, { type: "thread.loop.off" }>;
            yield* orchestrationEngine.dispatch(command).pipe(
              Effect.catch((error) =>
                Effect.logWarning("loop lifecycle off dispatch failed", {
                  threadId: event.payload.threadId,
                  eventType: event.type,
                  error: String(error),
                }),
              ),
            );
            return;
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("loop reactor event handler failed", {
              eventType: event.type,
              error: String(error),
            }),
          ),
        ),
      ),
    ).pipe(Effect.asVoid);
  });

  return {
    start,
    restoreActiveLoops,
  } satisfies LoopReactorShape;
});

export const LoopReactorLive = Layer.effect(LoopReactor, makeLoopReactor);
