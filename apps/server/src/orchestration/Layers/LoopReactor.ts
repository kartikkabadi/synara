// FILE: LoopReactor.ts
// Purpose: Automatically continue `/loop` iterations on terminal settlement, arm, and duration expiry.
// Layer: Orchestration runtime reactor

import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadLoop,
} from "@synara/contracts";
import { Clock, Effect, Layer, Option, Queue, Ref, Schedule, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { classifyLoopReactorEvent } from "../loop/reactorTriggers.ts";
import { ProjectionThreadLoopRepository } from "../../persistence/Services/ProjectionThreadLoop.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { LoopReactor, type LoopReactorShape } from "../Services/LoopReactor.ts";

// Unique continuation identity per trigger: the command payload carries a
// `createdAt` timestamp, so the commandId must include it to avoid identity
// collisions when multiple settlement events (e.g. `thread.session-set` and
// `thread.activity-appended`) trigger `continueThread` for the same loop state.
// Idempotency is still guaranteed by `expectedUpdatedAt`/`expectedActivationId`
// in `decideLoopContinue`.
function makeLoopContinueCommandId(
  threadId: OrchestrationThread["id"],
  loop: ThreadLoop,
  createdAt: string,
): CommandId {
  return CommandId.makeUnsafe(
    `loop-continue:${threadId}:${loop.updatedAt}:${loop.iteration}:${createdAt}`,
  );
}

// Dispatches the deterministic continuation command. The decider is the single
// evaluation point: a wait outcome settles as a non-triggering
// `thread.loop-wait-noted` event rather than being pre-filtered here.
// Returns whether the dispatch succeeded so callers can re-arm/retry.
function dispatchLoopContinue(options: {
  orchestrationEngine: OrchestrationEngineShape;
  thread: OrchestrationThreadShell;
  loop: ThreadLoop;
  createdAt: string;
}): Effect.Effect<boolean, never> {
  const { orchestrationEngine, thread, loop, createdAt } = options;
  const threadId = thread.id;

  if (!loop.active) {
    return Effect.succeed(true);
  }

  const command = {
    type: "thread.loop.continue" as const,
    commandId: makeLoopContinueCommandId(threadId, loop, createdAt),
    threadId,
    expectedUpdatedAt: loop.updatedAt,
    expectedActivationId: loop.activationId,
    createdAt,
  } satisfies Extract<OrchestrationCommand, { type: "thread.loop.continue" }>;

  return orchestrationEngine.dispatch(command).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logWarning("loop continuation dispatch failed", {
        threadId,
        error: String(error),
      }).pipe(Effect.as(false)),
    ),
  );
}

// Failed duration-expiry dispatches re-arm with a short backoff instead of
// dropping the deadline permanently.
const EXPIRY_RETRY_BACKOFF_MS = 30_000;

const RESTORE_SNAPSHOT_RETRY_SCHEDULE = Schedule.exponential("250 millis").pipe(Schedule.take(3));
const RESTORE_DISPATCH_RETRY_SCHEDULE = Schedule.exponential("250 millis").pipe(Schedule.take(3));
const LIFECYCLE_OFF_RETRY_SCHEDULE = Schedule.exponential("250 millis").pipe(Schedule.take(3));
// Supervised restore retry: exponential backoff capped at 30s, unbounded. A
// count/unbounded loop has no timer and may receive no unrelated event, so a
// restore must keep retrying until the loop deactivates or its activation
// changes — never abandon it.
const RESTORE_SUPERVISED_RETRY_SCHEDULE = Schedule.either(
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
);

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

  // In-memory index of threads with an active loop so per-event triggers skip
  // the SQLite shell read for the (common) threads without loops. Loop events
  // keep it current; restoreActiveLoops seeds it from the projection. Until
  // seeded, membership is unknown and continueThread falls through to the read.
  const activeLoopThreadsRef = yield* Ref.make(new Set<OrchestrationThreadShell["id"]>());
  const activeLoopsSeededRef = yield* Ref.make(false);

  const trackLoopState = (threadId: OrchestrationThreadShell["id"], loop: ThreadLoop | null) =>
    Ref.update(activeLoopThreadsRef, (current) => {
      const active = loop?.active === true;
      if (current.has(threadId) === active) {
        return current;
      }
      const next = new Set(current);
      if (active) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return next;
    });

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

  // Returns whether the continuation is settled: false means a transient
  // failure (missing shell row or failed dispatch) that callers may retry.
  const continueThread = (threadId: OrchestrationThreadShell["id"], createdAt: string) =>
    Effect.gen(function* () {
      const seeded = yield* Ref.get(activeLoopsSeededRef);
      if (seeded) {
        const activeLoopThreads = yield* Ref.get(activeLoopThreadsRef);
        if (!activeLoopThreads.has(threadId)) {
          return true;
        }
      }
      const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(threadOption)) {
        return false;
      }
      const loop = threadOption.value.loop;
      if (loop?.active !== true) {
        return true;
      }
      return yield* dispatchLoopContinue({
        orchestrationEngine,
        thread: threadOption.value,
        loop,
        createdAt,
      });
    });

  // Keeps retrying a failed restore dispatch under capped backoff until it
  // succeeds, the loop becomes inactive, or its activation changes. Rechecks
  // authority from the projection on every attempt so a loop stopped or
  // reconfigured in the meantime is never re-driven.
  const superviseRestoreDispatch = (
    threadId: OrchestrationThreadShell["id"],
    activationId: ThreadLoop["activationId"],
  ) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(threadOption)) {
        return;
      }
      const loop = threadOption.value.loop;
      if (loop?.active !== true || loop.activationId !== activationId) {
        return;
      }
      const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const dispatched = yield* dispatchLoopContinue({
        orchestrationEngine,
        thread: threadOption.value,
        loop,
        createdAt,
      });
      if (!dispatched) {
        return yield* Effect.fail(new Error("supervised restore dispatch failed"));
      }
    }).pipe(
      Effect.retry(RESTORE_SUPERVISED_RETRY_SCHEDULE),
      Effect.catch((error) =>
        Effect.logWarning("supervised loop restore retry failed", {
          threadId,
          error: String(error),
        }),
      ),
    );

  const superviseLifecycleOffDispatch = (input: {
    readonly command: Extract<OrchestrationCommand, { type: "thread.loop.off" }>;
    readonly activationId: ThreadLoop["activationId"];
    readonly eventType: string;
  }) =>
    Effect.gen(function* () {
      const loopOption = yield* projectionThreadLoopRepository.getByThreadId({
        threadId: input.command.threadId,
      });
      if (
        Option.isNone(loopOption) ||
        loopOption.value.loop.active !== true ||
        loopOption.value.loop.activationId !== input.activationId
      ) {
        return;
      }
      const dispatched = yield* orchestrationEngine.dispatch(input.command).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("supervised loop lifecycle off dispatch failed", {
            threadId: input.command.threadId,
            eventType: input.eventType,
            error: String(error),
          }).pipe(Effect.as(false)),
        ),
      );
      if (!dispatched) {
        return yield* Effect.fail(new Error("supervised lifecycle off dispatch failed"));
      }
    }).pipe(
      Effect.retry(RESTORE_SUPERVISED_RETRY_SCHEDULE),
      Effect.catch((error) =>
        Effect.logWarning("supervised loop lifecycle off retry failed", {
          threadId: input.command.threadId,
          eventType: input.eventType,
          error: String(error),
        }),
      ),
    );

  const restoreActiveLoops: LoopReactorShape["restoreActiveLoops"] = Effect.gen(function* () {
    // Projection/query infrastructure failures must propagate: silently
    // treating them as an empty snapshot would skip loop restoration and
    // strand active loops after a restart. A bounded retry absorbs transient
    // read failures before giving up.
    const readModel = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.retry(RESTORE_SNAPSHOT_RETRY_SCHEDULE), Effect.orDie);
    const activeThreads = readModel.threads.filter((thread) => thread.loop?.active === true);
    yield* Ref.set(activeLoopThreadsRef, new Set(activeThreads.map((thread) => thread.id)));
    yield* Ref.set(activeLoopsSeededRef, true);
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    for (const thread of activeThreads) {
      const loop = thread.loop;
      if (loop?.active !== true) {
        continue;
      }
      yield* syncDurationDeadline(thread.id, loop);
      // A failed restore dispatch strands the loop until the next unrelated
      // trigger; retry with bounded backoff inline, then hand persistent
      // failures to a supervised background retry so startup still completes.
      const dispatched = yield* dispatchLoopContinue({
        orchestrationEngine,
        thread,
        loop,
        createdAt: now,
      }).pipe(
        Effect.flatMap((ok) =>
          ok ? Effect.succeed(true) : Effect.fail(new Error("restore dispatch failed")),
        ),
        Effect.retry(RESTORE_DISPATCH_RETRY_SCHEDULE),
        Effect.catch(() =>
          Effect.logWarning("loop restore dispatch failed after retries; supervising", {
            threadId: thread.id,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!dispatched) {
        yield* Effect.forkDetach(superviseRestoreDispatch(thread.id, loop.activationId));
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
      const nowMs = yield* Clock.currentTimeMillis;
      const delayMs = Math.max(0, nextWakeMs - nowMs);
      const outcome = yield* Effect.race(
        Queue.take(timerWakeQueue).pipe(Effect.as("reset" as const)),
        Effect.sleep(delayMs).pipe(Effect.as("expired" as const)),
      );
      if (outcome === "reset") {
        continue;
      }
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
        const settled = yield* continueThread(threadId, nowIso).pipe(
          Effect.catch((error) =>
            Effect.logWarning("loop duration expiry continue failed", {
              threadId,
              error: String(error),
            }).pipe(Effect.as(false)),
          ),
        );
        if (!settled) {
          // Re-arm with a short backoff so a transient dispatch failure does
          // not permanently drop the deadline for a still-live loop.
          yield* Ref.update(durationDeadlinesRef, (current) => {
            const next = new Map(current);
            if (!next.has(threadId)) {
              next.set(threadId, nowMs + EXPIRY_RETRY_BACKOFF_MS);
            }
            return next;
          });
          yield* Queue.offer(timerWakeQueue, undefined);
        }
      }
    }
  });

  const start: LoopReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(runDurationExpiryTimer);
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          const trigger = classifyLoopReactorEvent(event);
          switch (trigger.kind) {
            case "ignore":
              return;
            case "sync": {
              yield* trackLoopState(trigger.threadId, trigger.loop);
              yield* syncDurationDeadline(trigger.threadId, trigger.loop);
              return;
            }
            case "sync-and-continue": {
              yield* trackLoopState(trigger.threadId, trigger.loop);
              yield* syncDurationDeadline(trigger.threadId, trigger.loop);
              yield* continueThread(trigger.threadId, event.occurredAt);
              return;
            }
            case "continue": {
              yield* continueThread(trigger.threadId, event.occurredAt);
              return;
            }
            case "lifecycle-off": {
              yield* trackLoopState(trigger.threadId, null);
              yield* syncDurationDeadline(trigger.threadId, null);
              const loopOption = yield* projectionThreadLoopRepository.getByThreadId({
                threadId: trigger.threadId,
              });
              if (Option.isNone(loopOption) || loopOption.value.loop.active !== true) {
                return;
              }
              const command = {
                type: "thread.loop.off" as const,
                commandId: CommandId.makeUnsafe(
                  `loop-off:${trigger.threadId}:${String(event.sequence)}`,
                ),
                threadId: trigger.threadId,
                reason: trigger.reason,
                createdAt: event.occurredAt,
              } satisfies Extract<OrchestrationCommand, { type: "thread.loop.off" }>;
              const dispatched = yield* orchestrationEngine.dispatch(command).pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("loop lifecycle off dispatch failed", {
                    threadId: trigger.threadId,
                    eventType: event.type,
                    error: String(error),
                  }).pipe(Effect.as(false)),
                ),
                Effect.flatMap((ok) =>
                  ok
                    ? Effect.succeed(true)
                    : Effect.fail(new Error("lifecycle off dispatch failed")),
                ),
                Effect.retry(LIFECYCLE_OFF_RETRY_SCHEDULE),
                Effect.catch((error) =>
                  Effect.logWarning("loop lifecycle off dispatch failed after retries", {
                    threadId: trigger.threadId,
                    eventType: event.type,
                    error: String(error),
                  }).pipe(Effect.as(false)),
                ),
              );
              if (!dispatched) {
                yield* Effect.forkDetach(
                  superviseLifecycleOffDispatch({
                    command,
                    activationId: loopOption.value.loop.activationId,
                    eventType: event.type,
                  }),
                );
              }
              return;
            }
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
