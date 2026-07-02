/**
 * startupLoopReconciliation - resume active loops after a server restart.
 *
 * Loop state persists in SQLite, but the LoopReactor's in-memory wake-up fibers
 * are lost on restart. Without reconciliation, an active loop stalls indefinitely
 * until a manual message or session event triggers the reactor.
 *
 * This module runs once at boot (after `reconcileRestartActiveGoals`) and enqueues
 * every thread with an active loop into the reactor's worker. The reactor's
 * per-thread handler re-checks all guards (session idle, no pending input, plan
 * mode, interval elapsed, etc.) before dispatching, so this is safe to call on
 * any thread — non-loop or paused threads early return. Stagger dispatches to
 * avoid a load spike if multiple loops survived restart.
 *
 * @module startupLoopReconciliation
 */
import { Effect } from "effect";

import { LoopReactor } from "./Services/LoopReactor.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const reconcileRestartActiveLoops: Effect.Effect<
  void,
  never,
  LoopReactor | ProjectionSnapshotQuery
> = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const loopReactor = yield* LoopReactor;

  const readModel = yield* snapshotQuery.getCommandReadModel().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restart loop reconciliation skipped: failed to read command snapshot", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (readModel === null) {
    return;
  }

  const activeLoopThreadIds = readModel.threads
    .filter((thread) => thread.loop?.status === "active")
    .map((thread) => thread.id);

  if (activeLoopThreadIds.length === 0) {
    return;
  }

  yield* Effect.logInfo("reconciling restart-active loops", {
    threadCount: activeLoopThreadIds.length,
    threadIds: activeLoopThreadIds,
  });

  yield* loopReactor
    .reconcile(activeLoopThreadIds)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("restart loop reconciliation failed to enqueue threads", { cause }),
      ),
    );
});
