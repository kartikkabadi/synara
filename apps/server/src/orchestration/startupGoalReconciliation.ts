/**
 * startupGoalReconciliation - resume active goals after a server restart.
 *
 * Goal state persists in SQLite, but the GoalContinuationReactor only fires on
 * domain events. After a restart, an active goal with an idle session stalls
 * indefinitely until a manual message or session event triggers the reactor.
 *
 * This module runs once at boot (after `reconcileRestartStuckTurns` heals orphaned
 * turns, before `markCommandReady` unblocks clients) and enqueues every thread
 * with an active goal into the reactor's worker. The reactor's per-thread handler
 * re-checks all guards (session idle, no pending input, plan mode, etc.) before
 * dispatching a continuation, so this is safe to call on any thread — non-goal or
 * paused threads early return. The reactor staggers dispatches (500ms apart) to
 * avoid a load spike if multiple goals survived restart.
 *
 * @module startupGoalReconciliation
 */
import { Effect } from "effect";

import { GoalContinuationReactor } from "./Services/GoalContinuationReactor.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const reconcileRestartActiveGoals: Effect.Effect<
  void,
  never,
  GoalContinuationReactor | ProjectionSnapshotQuery
> = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const goalReactor = yield* GoalContinuationReactor;

  const readModel = yield* snapshotQuery.getCommandReadModel().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restart goal reconciliation skipped: failed to read command snapshot", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (readModel === null) {
    return;
  }

  const activeGoalThreadIds = readModel.threads
    .filter((thread) => thread.goal?.status === "active")
    .map((thread) => thread.id);

  if (activeGoalThreadIds.length === 0) {
    return;
  }

  yield* Effect.logInfo("reconciling restart-active goals", {
    threadCount: activeGoalThreadIds.length,
    threadIds: activeGoalThreadIds,
  });

  yield* goalReactor
    .reconcile(activeGoalThreadIds)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("restart goal reconciliation failed to enqueue threads", { cause }),
      ),
    );
});
