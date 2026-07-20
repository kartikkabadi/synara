// FILE: LoopReactor.ts
// Purpose: Automatically continue `/loop` iterations on terminal settlement and arm.
// Layer: Orchestration runtime reactor

import {
  CommandId,
  type LoopStopReason,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadLoop,
} from "@synara/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
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
  threadId: OrchestrationThread["id"];
  loop: ThreadLoop;
  createdAt: string;
}): Effect.Effect<void, never> {
  const { orchestrationEngine, threadId, loop, createdAt } = options;

  if (!loop.active) {
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

  const continueThread = (threadId: OrchestrationThreadShell["id"], createdAt: string) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(threadOption)) {
        return;
      }
      const loop = threadOption.value.loop;
      if (loop?.active === true) {
        yield* dispatchLoopContinue({ orchestrationEngine, threadId, loop, createdAt });
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
        yield* dispatchLoopContinue({
          orchestrationEngine,
          threadId: thread.id,
          loop: thread.loop,
          createdAt: now,
        });
      }
    }
  });

  const start: LoopReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "thread.loop-set") {
            yield* continueThread(event.payload.threadId, event.occurredAt);
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
