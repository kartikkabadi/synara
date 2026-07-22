import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { controlPlaneKernelMode } from "../../config.ts";
import type { ControlPlaneKernelShape } from "../Services/ControlPlaneKernel.ts";
import { loadControlPlaneAddon, makeControlPlaneKernelAtPath } from "./ControlPlaneKernel.ts";

describe("controlPlaneKernelMode", () => {
  it("defaults to off", () => {
    expect(controlPlaneKernelMode({})).toBe("off");
    expect(controlPlaneKernelMode({ SYNARA_CONTROL_PLANE_KERNEL: "" })).toBe("off");
    expect(controlPlaneKernelMode({ SYNARA_CONTROL_PLANE_KERNEL: "bogus" })).toBe("off");
  });

  it("parses shadow and on, tolerating case and whitespace", () => {
    expect(controlPlaneKernelMode({ SYNARA_CONTROL_PLANE_KERNEL: "shadow" })).toBe("shadow");
    expect(controlPlaneKernelMode({ SYNARA_CONTROL_PLANE_KERNEL: " ON " })).toBe("on");
  });
});

// The native minisqlite-node addon is not packaged as an npm dependency yet;
// these smoke tests run wherever the addon is resolvable (locally via
// SYNARA_CONTROL_PLANE_ADDON_PATH) and are skipped elsewhere.
const addonAvailable = typeof loadControlPlaneAddon() !== "string";

describe.skipIf(!addonAvailable)("ControlPlaneKernel (native addon smoke)", () => {
  const withTempKernel = <A, E>(use: (kernel: ControlPlaneKernelShape) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), "synara-control-plane-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const kernel = yield* makeControlPlaneKernelAtPath(
        path.join(dir, "control-plane.db"),
        "shadow",
      );
      return yield* use(kernel);
    }).pipe(Effect.scoped);

  it.effect("opens a store, commits atomically, claims and acks a job", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = Date.now();
        const payload = new TextEncoder().encode(JSON.stringify({ step: "rescue-checkpoint" }));

        yield* kernel.commit({
          committedAtMs: now,
          expectedStreamVersions: [{ streamId: "threads/t-1", version: 0 }],
          events: [
            {
              streamId: "threads/t-1",
              eventType: "thread.revert.started",
              occurredAtMs: now,
              payload,
            },
          ],
          projectionPatches: [
            {
              projection: "thread-revert",
              expectedVersion: 0,
              puts: [{ key: new TextEncoder().encode("t-1"), value: payload }],
            },
          ],
          enqueueJobs: [
            {
              queue: "checkpoint-revert",
              partitionKey: "thread:t-1",
              payload,
            },
          ],
        });

        assert.equal(yield* kernel.streamVersion("threads/t-1"), 1);
        assert.equal(yield* kernel.projectionVersion("thread-revert"), 1);
        const entry = yield* kernel.projectionGet({
          projection: "thread-revert",
          key: new TextEncoder().encode("t-1"),
        });
        assert.isNotNull(entry);

        const claim = yield* kernel.claimJobs({
          queue: "checkpoint-revert",
          workerId: "worker-test",
          nowMs: now,
          leaseMs: 30_000,
          limit: 1,
        });
        assert.equal(claim.jobs.length, 1);
        const job = claim.jobs[0]!;

        yield* kernel.extendLease({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          newExpiryMs: now + 60_000,
          nowMs: now,
        });

        yield* kernel.commit({
          committedAtMs: now + 1,
          ackJobs: [{ jobId: job.jobId, leaseToken: job.leaseToken }],
        });

        const succeeded = yield* kernel.jobs({
          queue: "checkpoint-revert",
          state: "succeeded",
          limit: 10,
        });
        assert.equal(succeeded.length, 1);

        const events = yield* kernel.eventsAfter({ after: 0, limit: 10 });
        assert.equal(events.length, 1);
        assert.equal(events[0]?.eventType, "thread.revert.started");

        const id = yield* kernel.newId();
        assert.match(id, /^[0-9a-f]{32}$/);
      }),
    ),
  );

  it.effect("looks up jobs, pages them, and resolves uncertain jobs", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = 1_000;
        const payload = new TextEncoder().encode("{}");
        const enqueue = (jobId: string) =>
          kernel.commit({
            committedAtMs: now,
            enqueueJobs: [{ jobId, queue: "checkpoint-revert", partitionKey: jobId, payload }],
          });
        const first = yield* kernel.newId();
        const second = yield* kernel.newId();
        yield* enqueue(first);
        yield* enqueue(second);

        const missing = yield* kernel.job(yield* kernel.newId());
        assert.isNull(missing);

        const pageOne = yield* kernel.jobsPage({
          queue: "checkpoint-revert",
          afterSequence: 0,
          limit: 1,
        });
        assert.deepEqual(
          pageOne.jobs.map((job) => job.jobId),
          [first],
        );
        const pageTwo = yield* kernel.jobsPage({
          queue: "checkpoint-revert",
          afterSequence: pageOne.nextAfterSequence,
          limit: 1,
        });
        assert.deepEqual(
          pageTwo.jobs.map((job) => job.jobId),
          [second],
        );

        // Let both leases expire so maintenance marks the jobs uncertain.
        yield* kernel.claimJobs({
          queue: "checkpoint-revert",
          workerId: "worker-1",
          nowMs: now,
          leaseMs: 100,
          limit: 2,
        });
        yield* kernel.claimJobs({
          queue: "checkpoint-revert",
          workerId: "worker-2",
          nowMs: now + 1_000,
          leaseMs: 100,
          limit: 1,
        });
        const uncertain = yield* kernel.jobsPage({
          queue: "checkpoint-revert",
          state: "uncertain",
          afterSequence: 0,
          limit: 10,
        });
        assert.deepEqual(
          uncertain.jobs.map((job) => job.jobId).sort(),
          [first, second].sort(),
        );

        yield* kernel.resolveUncertainJobs({
          committedAtMs: now + 1_000,
          resolutions: [
            { jobId: first, resolution: "markSucceeded" },
            { jobId: second, resolution: "markDead" },
          ],
        });
        assert.equal((yield* kernel.job(first))?.state, "succeeded");
        assert.equal((yield* kernel.job(second))?.state, "dead");
      }),
    ),
  );

  it.effect("surfaces optimistic-concurrency conflicts as typed errors", () =>
    withTempKernel((kernel) =>
      Effect.gen(function* () {
        const now = Date.now();
        const exit = yield* Effect.exit(
          kernel.commit({
            committedAtMs: now,
            expectedStreamVersions: [{ streamId: "threads/t-1", version: 7 }],
            events: [
              {
                streamId: "threads/t-1",
                eventType: "thread.revert.started",
                occurredAtMs: now,
              },
            ],
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "Conflict");
      }),
    ),
  );
});
