/**
 * Failure drills for the durable checkpoint-revert saga (kernel PR 5).
 *
 * Each drill simulates a crash at one boundary of the saga and asserts the
 * recovery invariants from the integration plan:
 * - no duplicate provider-rollback executions,
 * - no effects from indeterminate claims,
 * - ambiguous outcomes become Uncertain and are only resolved explicitly.
 *
 * All drills run against a real kernel store and skip when the native addon
 * is unavailable (same gating as ControlPlaneKernel.test.ts).
 */
import { CheckpointRef, ThreadId } from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadControlPlaneAddon,
  makeControlPlaneKernelAtPath,
} from "../../persistence/Layers/ControlPlaneKernel.ts";
import type { ControlPlaneKernelShape } from "../../persistence/Services/ControlPlaneKernel.ts";
import { makeRevertSagaWorker } from "./RevertSagaWorker.ts";
import { REVERT_SAGA_QUEUE, type RevertSagaShadowHandle } from "../Services/RevertSagaWorker.ts";

const threadId = ThreadId.makeUnsafe("thread-revert-drills");
const targetCheckpointRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/x/turn/1");

const LEASE_MS = 60_000;

const addonAvailable = typeof loadControlPlaneAddon() !== "string";

describe.skipIf(!addonAvailable)("revert saga failure drills", () => {
  const withKernel = <A, E>(use: (kernel: ControlPlaneKernelShape) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), "synara-revert-drills-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const kernel = yield* makeControlPlaneKernelAtPath(path.join(dir, "control-plane.db"), "on");
      return yield* use(kernel);
    }).pipe(Effect.scoped);

  const armSaga = (kernel: ControlPlaneKernelShape) =>
    makeRevertSagaWorker(kernel)
      .armShadowSaga({ threadId, turnCount: 1, targetCheckpointRef, cwd: "/tmp/workspace" })
      .pipe(
        Effect.map((handle): RevertSagaShadowHandle => {
          assert.isTrue(Option.isSome(handle));
          return Option.getOrThrow(handle);
        }),
      );

  const jobIdsByState = (kernel: ControlPlaneKernelShape, state: string) =>
    kernel
      .jobs({ queue: REVERT_SAGA_QUEUE, state, limit: 10 })
      .pipe(Effect.map((jobs) => jobs.map((job) => job.jobId)));

  it.effect("drill 1: crash after arming leaves the job reclaimable at step 1", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        yield* armSaga(kernel);
        // Crash before any claim or effect: nothing holds a lease.

        const pending = yield* jobIdsByState(kernel, "pending");
        assert.equal(pending.length, 1);

        // A recovery worker claims the job fresh and would resume at step 1.
        const outcome = yield* kernel.claimJobs({
          queue: REVERT_SAGA_QUEUE,
          workerId: "recovery-worker",
          nowMs: Date.now(),
          leaseMs: LEASE_MS,
          limit: 10,
        });
        assert.equal(outcome.jobs.length, 1);
        assert.equal(outcome.jobs[0]?.attempt, 1);

        // Only the armed intent is on the trail: no effect was recorded.
        const events = yield* kernel.eventsAfter({ after: 0, limit: 10 });
        assert.deepEqual(
          events.map((event) => event.eventType),
          ["thread.revert.started"],
        );
      }),
    ),
  );

  it.effect("drill 2: an indeterminate claim is recovered, not re-executed", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        yield* armSaga(kernel);

        // The executor claims the job, then crashes before persisting the
        // lease token anywhere (the claim outcome is indeterminate).
        const claim = yield* kernel.claimJobs({
          queue: REVERT_SAGA_QUEUE,
          workerId: "executor",
          nowMs: Date.now(),
          leaseMs: LEASE_MS,
          limit: 10,
        });
        assert.equal(claim.jobs.length, 1);
        const transactionId = claim.transactionId;
        assert.isDefined(transactionId);

        // Recovery reconstructs the same lease instead of claiming again.
        const recovered = yield* kernel.recoverClaim({
          transactionId: transactionId ?? "",
          nowMs: Date.now(),
        });
        assert.equal(recovered.kind, "committed");
        assert.equal(recovered.jobs.length, 1);
        assert.equal(recovered.jobs[0]?.jobId, claim.jobs[0]?.jobId);
        assert.equal(recovered.jobs[0]?.attempt, claim.jobs[0]?.attempt);
        assert.deepEqual(recovered.staleJobs, []);

        // The recovered token acknowledges the job: exactly one execution.
        const job = recovered.jobs[0];
        assert.isDefined(job);
        if (job) {
          yield* kernel.commit({
            committedAtMs: Date.now(),
            ackJobs: [{ jobId: job.jobId, leaseToken: job.leaseToken }],
          });
        }
        assert.deepEqual(yield* jobIdsByState(kernel, "succeeded"), [job?.jobId]);

        // No second claimable execution exists.
        const second = yield* kernel.claimJobs({
          queue: REVERT_SAGA_QUEUE,
          workerId: "executor-2",
          nowMs: Date.now(),
          leaseMs: LEASE_MS,
          limit: 10,
        });
        assert.equal(second.jobs.length, 0);
      }),
    ),
  );

  it.effect(
    "drill 3: an ambiguous provider rollback becomes Uncertain and resolves only explicitly",
    () =>
      withKernel((kernel) =>
        Effect.gen(function* () {
          const handle = yield* armSaga(kernel);
          assert.isTrue(yield* handle.claim());
          yield* handle.recordStep("rescue-checkpoint");
          yield* handle.recordStep("filesystem-restore");

          // The provider call fails ambiguously: the lease is deliberately
          // left to expire instead of acking, failing, or retrying.
          yield* handle.recordUncertain("provider-rollback", "socket closed mid-call");

          // After lease expiry the reconcilable job is NOT silently
          // reclaimed: the sweep transitions it to Uncertain.
          const afterExpiry = yield* kernel.claimJobs({
            queue: REVERT_SAGA_QUEUE,
            workerId: "sweeper",
            nowMs: Date.now() + LEASE_MS + 1,
            leaseMs: LEASE_MS,
            limit: 10,
          });
          assert.equal(afterExpiry.jobs.length, 0);
          const uncertain = yield* jobIdsByState(kernel, "uncertain");
          assert.equal(uncertain.length, 1);

          // The uncertainty is on the durable trail.
          const events = yield* kernel.eventsAfter({ after: 0, limit: 10 });
          assert.isTrue(events.some((event) => event.eventType === "thread.revert.uncertain"));

          // Only an explicit operator resolution moves the job again:
          // retry returns it to pending for a fresh attempt.
          const jobId = uncertain[0];
          assert.isDefined(jobId);
          if (jobId !== undefined) {
            yield* kernel.commit({
              committedAtMs: Date.now(),
              resolveUncertainJobs: [{ jobId, resolution: "retry" }],
            });
          }
          assert.deepEqual(yield* jobIdsByState(kernel, "uncertain"), []);
          assert.deepEqual(yield* jobIdsByState(kernel, "pending"), [jobId]);
        }),
      ),
  );

  it.effect("drill 4: recoverTransaction distinguishes committed from absent outcomes", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        const transactionId = yield* kernel.newId();

        // Crash before the commit reached the store: absent means it is
        // safe to resubmit the exact same batch.
        const before = yield* kernel.recoverTransaction(transactionId);
        assert.equal(before.kind, "absent");

        const batch = {
          transactionId,
          committedAtMs: Date.now(),
          events: [
            {
              streamId: "revert-saga/drill-4",
              eventType: "thread.revert.completed",
              occurredAtMs: Date.now(),
              payload: new TextEncoder().encode("{}"),
            },
          ],
        };
        yield* kernel.commit(batch);

        // Crash after the commit: committed means done, do not re-run.
        const after = yield* kernel.recoverTransaction(transactionId);
        assert.equal(after.kind, "committed");
        assert.equal(after.receipt?.transactionId, transactionId);

        // Exactly one event was recorded despite the recovery round trip.
        assert.equal(yield* kernel.streamVersion("revert-saga/drill-4"), 1);
      }),
    ),
  );

  it.effect("drill 5: a crashed GC step is resolved and re-run without duplicate effects", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        const handle = yield* armSaga(kernel);
        assert.isTrue(yield* handle.claim());
        yield* handle.recordStep("checkpoint-ref-gc", "refs:2");
        // Crash before acknowledgement: the lease expires and the job goes
        // Uncertain (ref deletion effects may or may not have happened).
        const sweep = yield* kernel.claimJobs({
          queue: REVERT_SAGA_QUEUE,
          workerId: "sweeper",
          nowMs: Date.now() + LEASE_MS + 1,
          leaseMs: LEASE_MS,
          limit: 10,
        });
        assert.equal(sweep.jobs.length, 0);
        const uncertain = yield* jobIdsByState(kernel, "uncertain");
        assert.equal(uncertain.length, 1);

        // Ref deletion is idempotent, so the operator resolves to retry;
        // the fresh attempt claims the job and settles it exactly once.
        const jobId = uncertain[0];
        if (jobId !== undefined) {
          yield* kernel.commit({
            committedAtMs: Date.now(),
            resolveUncertainJobs: [{ jobId, resolution: "retry" }],
          });
        }
        const retry = yield* kernel.claimJobs({
          queue: REVERT_SAGA_QUEUE,
          workerId: "executor-2",
          nowMs: Date.now() + LEASE_MS + 2,
          leaseMs: LEASE_MS,
          limit: 10,
        });
        assert.equal(retry.jobs.length, 1);
        const retriedJob = retry.jobs[0];
        assert.isDefined(retriedJob);
        if (retriedJob) {
          yield* kernel.commit({
            committedAtMs: Date.now(),
            events: [
              {
                streamId: `revert-saga/${handle.sagaId}`,
                eventType: "thread.revert.completed",
                occurredAtMs: Date.now(),
                payload: new TextEncoder().encode("{}"),
              },
            ],
            ackJobs: [{ jobId: retriedJob.jobId, leaseToken: retriedJob.leaseToken }],
          });
        }
        assert.deepEqual(yield* jobIdsByState(kernel, "succeeded"), [retriedJob?.jobId]);
        assert.deepEqual(yield* jobIdsByState(kernel, "uncertain"), []);
      }),
    ),
  );
});
