import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isControlPlaneAddonFailure,
  loadControlPlaneAddon,
  makeControlPlaneKernelAtPath,
  makeDisabledKernel,
} from "./persistence/Layers/ControlPlaneKernel.ts";
import type { ControlPlaneKernelShape } from "./persistence/Services/ControlPlaneKernel.ts";
import {
  CHECKPOINT_REVERT_QUEUE,
  getControlPlaneJob,
  listUncertainRevertJobs,
  resolveUncertainRevertJob,
} from "./controlPlaneOperator.ts";

describe("controlPlaneOperator (kernel off)", () => {
  const kernel = makeDisabledKernel("SYNARA_CONTROL_PLANE_KERNEL is off.");

  it.effect("listUncertainRevertJobs returns an empty page without touching the kernel", () =>
    Effect.gen(function* () {
      const result = yield* listUncertainRevertJobs(kernel, {});
      expect(result).toEqual({ kernelEnabled: false, jobs: [], nextAfterSequence: 0 });
      const paged = yield* listUncertainRevertJobs(kernel, { afterSequence: 7 });
      expect(paged.nextAfterSequence).toBe(7);
    }),
  );

  it.effect("getControlPlaneJob fails with the typed KernelDisabled error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(getControlPlaneJob(kernel, { jobId: "a".repeat(32) }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "KernelDisabled");
    }),
  );

  it.effect("resolveUncertainRevertJob fails with the typed KernelDisabled error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolveUncertainRevertJob(kernel, {
          jobId: "a".repeat(32),
          resolution: "retry",
          reason: "Verified by the owner",
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "KernelDisabled");
    }),
  );
});

// Runs wherever the native addon is resolvable (locally via
// SYNARA_CONTROL_PLANE_ADDON_PATH) and is skipped elsewhere.
const addonAvailable = !isControlPlaneAddonFailure(loadControlPlaneAddon());

describe.skipIf(!addonAvailable)("controlPlaneOperator (native addon)", () => {
  const withTempKernel = <A, E>(use: (kernel: ControlPlaneKernelShape) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), "synara-control-plane-operator-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const kernel = yield* makeControlPlaneKernelAtPath(
        path.join(dir, "control-plane.db"),
        "shadow",
      );
      return yield* use(kernel);
    }).pipe(Effect.scoped);

  const makeUncertainJob = (kernel: ControlPlaneKernelShape, nowMs: number) =>
    Effect.gen(function* () {
      const jobId = yield* kernel.newId();
      yield* kernel.commit({
        projectionPatches: [
          {
            projection: `revert-job/${jobId}`,
            expectedVersion: 0,
            puts: [
              {
                key: new TextEncoder().encode("context"),
                value: new TextEncoder().encode(
                  JSON.stringify({
                    mode: "shadow",
                    sagaId: jobId,
                    threadId: jobId,
                    turnCount: 1,
                    targetCheckpointRef: "refs/test/target",
                  }),
                ),
              },
            ],
          },
        ],
        committedAtMs: nowMs,
        enqueueJobs: [
          {
            jobId,
            queue: CHECKPOINT_REVERT_QUEUE,
            partitionKey: `thread:${jobId}/saga:${jobId}`,
            payload: new TextEncoder().encode("{}"),
          },
        ],
      });
      yield* kernel.claimJobs({
        queue: CHECKPOINT_REVERT_QUEUE,
        workerId: "worker-1",
        nowMs,
        leaseMs: 100,
        limit: 1,
      });
      // Expired lease; the next claim's maintenance marks the job uncertain.
      yield* kernel.claimJobs({
        queue: CHECKPOINT_REVERT_QUEUE,
        workerId: "worker-2",
        nowMs: nowMs + 1_000,
        leaseMs: 100,
        limit: 1,
      });
      return jobId;
    });

  it.effect("lists uncertain revert jobs and resolves one", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = 1_000;
        const jobId = yield* makeUncertainJob(kernel, now);

        const listed = yield* listUncertainRevertJobs(kernel, {});
        assert.isTrue(listed.kernelEnabled);
        assert.deepEqual(
          listed.jobs.map((job) => job.jobId),
          [jobId],
        );
        assert.equal(listed.jobs[0]?.state, "uncertain");

        const looked = yield* getControlPlaneJob(kernel, { jobId });
        assert.equal(looked.job?.partitionKey, `thread:${jobId}/saga:${jobId}`);

        const resolved = yield* resolveUncertainRevertJob(
          kernel,
          { jobId, resolution: "markSucceeded", reason: "Verified by the owner" },
          now + 2_000,
        );
        assert.equal(resolved.job?.state, "succeeded");

        const after = yield* listUncertainRevertJobs(kernel, {});
        assert.deepEqual(after.jobs, []);
      }),
    ),
  );

  it.effect("rejects resolving a job that does not exist", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          resolveUncertainRevertJob(kernel, {
            jobId: "f".repeat(32),
            resolution: "retry",
            reason: "Verified by the owner",
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "InvalidResolutionTarget");
        assert.include(String(exit), "does not exist");
      }),
    ),
  );

  it.effect("rejects resolving an uncertain job from another queue", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = 1_000;
        const jobId = yield* kernel.newId();
        yield* kernel.commit({
          committedAtMs: now,
          enqueueJobs: [
            {
              jobId,
              queue: "other-queue",
              partitionKey: `thread:${jobId}`,
              payload: new TextEncoder().encode("{}"),
            },
          ],
        });
        yield* kernel.claimJobs({
          queue: "other-queue",
          workerId: "worker-1",
          nowMs: now,
          leaseMs: 100,
          limit: 1,
        });
        yield* kernel.claimJobs({
          queue: "other-queue",
          workerId: "worker-2",
          nowMs: now + 1_000,
          leaseMs: 100,
          limit: 1,
        });
        assert.equal((yield* getControlPlaneJob(kernel, { jobId })).job?.state, "uncertain");

        const exit = yield* Effect.exit(
          resolveUncertainRevertJob(
            kernel,
            { jobId, resolution: "markDead", reason: "Verified by the owner" },
            now + 2_000,
          ),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "InvalidResolutionTarget");
        assert.include(String(exit), "not a checkpoint-revert job");
        assert.equal((yield* getControlPlaneJob(kernel, { jobId })).job?.state, "uncertain");
      }),
    ),
  );

  it.effect("rejects resolving a job that is not uncertain", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = 1_000;
        const jobId = yield* kernel.newId();
        yield* kernel.commit({
          committedAtMs: now,
          enqueueJobs: [
            {
              jobId,
              queue: CHECKPOINT_REVERT_QUEUE,
              partitionKey: `thread:${jobId}`,
              payload: new TextEncoder().encode("{}"),
            },
          ],
        });

        const exit = yield* Effect.exit(
          resolveUncertainRevertJob(
            kernel,
            { jobId, resolution: "markSucceeded", reason: "Verified by the owner" },
            now + 1,
          ),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "InvalidResolutionTarget");
        assert.include(String(exit), "not uncertain");
      }),
    ),
  );

  it.effect("fails in the kernel if the job leaves uncertain between read and resolution", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = 1_000;
        const jobId = yield* makeUncertainJob(kernel, now);
        // Simulate a concurrent resolution between validation and commit.
        const racingKernel: ControlPlaneKernelShape = {
          ...kernel,
          commit: (input) =>
            kernel
              .resolveUncertainJobs({
                committedAtMs: input.committedAtMs,
                resolutions: [{ jobId, resolution: "markSucceeded" }],
              })
              .pipe(Effect.andThen(kernel.commit(input))),
        };

        const exit = yield* Effect.exit(
          resolveUncertainRevertJob(
            racingKernel,
            { jobId, resolution: "markDead", reason: "Verified by the owner" },
            now + 2_000,
          ),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.equal((yield* getControlPlaneJob(kernel, { jobId })).job?.state, "succeeded");
      }),
    ),
  );
});

describe("operator decision boundaries without a native addon", () => {
  const jobId = "a".repeat(32);
  const context = {
    mode: "shadow",
    sagaId: "saga",
    threadId: "thread",
    turnCount: 1,
    targetCheckpointRef: "refs/target",
  };
  const job = {
    jobId,
    queue: CHECKPOINT_REVERT_QUEUE,
    partitionKey: "thread:thread/saga:saga",
    state: "uncertain",
    attempt: 1,
  };

  it.effect("commits the operator reason and terminal observation in one batch", () =>
    Effect.gen(function* () {
      const batches: import("./persistence/Services/ControlPlaneKernel.ts").KernelCommitBatch[] =
        [];
      const kernel: ControlPlaneKernelShape = {
        ...makeDisabledKernel("unused"),
        mode: "shadow",
        job: () => Effect.succeed(job),
        projectionGet: () => Effect.succeed(new TextEncoder().encode(JSON.stringify(context))),
        newId: () => Effect.succeed("b".repeat(32)),
        commit: (batch) =>
          Effect.sync(() => {
            batches.push(batch);
            return { transactionId: "b".repeat(32), transactionSequence: 1, committedAtMs: 10 };
          }),
      };
      yield* resolveUncertainRevertJob(
        kernel,
        { jobId, resolution: "markDead", reason: "  Provider history inspected  " },
        10,
      );
      assert.equal(batches.length, 1);
      assert.deepEqual(batches[0]?.resolveUncertainJobs, [{ jobId, resolution: "markDead" }]);
      assert.equal(batches[0]?.events?.[0]?.eventType, "thread.revert.operator-resolved");
      const audit = JSON.parse(new TextDecoder().decode(batches[0]?.events?.[0]?.payload));
      assert.equal(audit.reason, "Provider history inspected");
      assert.equal(audit.mode, "shadow");
    }),
  );

  it.effect("rejects retry, absent shadow context, and empty reasons without committing", () =>
    Effect.gen(function* () {
      let commits = 0;
      const kernel: ControlPlaneKernelShape = {
        ...makeDisabledKernel("unused"),
        mode: "shadow",
        job: () => Effect.succeed(job),
        projectionGet: () => Effect.succeed(null),
        commit: () =>
          Effect.sync(() => {
            commits += 1;
            return { transactionId: "b".repeat(32), transactionSequence: 1, committedAtMs: 0 };
          }),
      };
      for (const input of [
        { jobId, resolution: "retry" as const, reason: "Try again" },
        { jobId, resolution: "markDead" as const, reason: "No context" },
        { jobId, resolution: "markSucceeded" as const, reason: " " },
      ]) {
        const exit = yield* Effect.exit(resolveUncertainRevertJob(kernel, input));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "InvalidResolutionTarget");
      }
      assert.equal(commits, 0);
    }),
  );
});
