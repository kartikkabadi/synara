import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
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
        resolveUncertainRevertJob(kernel, { jobId: "a".repeat(32), resolution: "retry" }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "KernelDisabled");
    }),
  );
});

// Runs wherever the native addon is resolvable (locally via
// SYNARA_CONTROL_PLANE_ADDON_PATH) and is skipped elsewhere.
const addonAvailable = typeof loadControlPlaneAddon() !== "string";

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
        committedAtMs: nowMs,
        enqueueJobs: [
          {
            jobId,
            queue: CHECKPOINT_REVERT_QUEUE,
            partitionKey: `thread:${jobId}`,
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
        assert.equal(looked.job?.partitionKey, `thread:${jobId}`);

        const resolved = yield* resolveUncertainRevertJob(
          kernel,
          { jobId, resolution: "markSucceeded" },
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
          resolveUncertainRevertJob(kernel, { jobId: "f".repeat(32), resolution: "retry" }),
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
          resolveUncertainRevertJob(kernel, { jobId, resolution: "markDead" }, now + 2_000),
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
          resolveUncertainRevertJob(kernel, { jobId, resolution: "markSucceeded" }, now + 1),
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
          resolveUncertainJobs: (input) =>
            kernel
              .resolveUncertainJobs({
                committedAtMs: input.committedAtMs,
                resolutions: [{ jobId, resolution: "markSucceeded" }],
              })
              .pipe(Effect.andThen(kernel.resolveUncertainJobs(input))),
        };

        const exit = yield* Effect.exit(
          resolveUncertainRevertJob(racingKernel, { jobId, resolution: "markDead" }, now + 2_000),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.equal((yield* getControlPlaneJob(kernel, { jobId })).job?.state, "succeeded");
      }),
    ),
  );
});
