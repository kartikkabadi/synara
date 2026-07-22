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
import {
  ControlPlaneKernelError,
  type ControlPlaneKernelShape,
} from "../../persistence/Services/ControlPlaneKernel.ts";
import { makeRevertSagaWorker } from "./RevertSagaWorker.ts";
import { REVERT_SAGA_QUEUE, type RevertSagaShadowHandle } from "../Services/RevertSagaWorker.ts";

const threadId = ThreadId.makeUnsafe("thread-revert-saga-test");
const targetCheckpointRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/x/turn/2");

const decodeTrail = (kernel: ControlPlaneKernelShape) =>
  kernel
    .eventsAfter({ after: 0, limit: 100 })
    .pipe(Effect.map((events) => events.map((event) => event.eventType)));

const armHandle = (worker: ReturnType<typeof makeRevertSagaWorker>) =>
  worker.armShadowSaga({ threadId, turnCount: 2, targetCheckpointRef, cwd: "/tmp/workspace" }).pipe(
    Effect.map((handle): RevertSagaShadowHandle => {
      assert.isTrue(Option.isSome(handle));
      return Option.getOrThrow(handle);
    }),
  );

const jobStates = (kernel: ControlPlaneKernelShape, state: string) =>
  kernel.jobs({ queue: REVERT_SAGA_QUEUE, state, limit: 10 });

const addonAvailable = typeof loadControlPlaneAddon() !== "string";

describe.skipIf(!addonAvailable)("RevertSagaWorker (shadow mode)", () => {
  const withKernel = <A, E>(use: (kernel: ControlPlaneKernelShape) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), "synara-revert-saga-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const kernel = yield* makeControlPlaneKernelAtPath(
        path.join(dir, "control-plane.db"),
        "shadow",
      );
      return yield* use(kernel);
    }).pipe(Effect.scoped);

  it.effect("records a complete saga trail and settles the job atomically", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        const worker = makeRevertSagaWorker(kernel);
        const handle = yield* armHandle(worker);

        assert.equal((yield* jobStates(kernel, "pending")).length, 1);

        yield* handle.recordStep("filesystem-restore");
        yield* handle.recordStep("provider-rollback", "numTurns:1");
        yield* handle.recordStep("checkpoint-ref-gc", "refs:2");
        yield* handle.complete();

        assert.deepEqual(yield* decodeTrail(kernel), [
          "thread.revert.started",
          "thread.revert.step",
          "thread.revert.step",
          "thread.revert.step",
          "thread.revert.completed",
        ]);
        assert.equal((yield* jobStates(kernel, "succeeded")).length, 1);
        assert.equal((yield* jobStates(kernel, "pending")).length, 0);
      }),
    ),
  );

  it.effect("leaves the job unsettled when a step outcome is uncertain", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        const worker = makeRevertSagaWorker(kernel);
        const handle = yield* armHandle(worker);

        yield* handle.recordStep("filesystem-restore");
        yield* handle.recordUncertain("provider-rollback", "socket closed mid-call");

        assert.deepEqual(yield* decodeTrail(kernel), [
          "thread.revert.started",
          "thread.revert.step",
          "thread.revert.uncertain",
        ]);
        assert.equal((yield* jobStates(kernel, "pending")).length, 1);
        assert.equal((yield* jobStates(kernel, "succeeded")).length, 0);
      }),
    ),
  );

  it.effect("acks the job on abort before any mutation", () =>
    withKernel((kernel) =>
      Effect.gen(function* () {
        const worker = makeRevertSagaWorker(kernel);
        const handle = yield* armHandle(worker);

        yield* handle.abort("target checkpoint unavailable; nothing was mutated");

        assert.deepEqual(yield* decodeTrail(kernel), [
          "thread.revert.started",
          "thread.revert.aborted",
        ]);
        assert.equal((yield* jobStates(kernel, "succeeded")).length, 1);
      }),
    ),
  );
});

describe("RevertSagaWorker (kernel off)", () => {
  const disabled = (operation: string) => () =>
    Effect.fail(new ControlPlaneKernelError({ operation, code: "KernelDisabled", detail: "test" }));
  const disabledKernel: ControlPlaneKernelShape = {
    mode: "off",
    commit: disabled("commit"),
    claimJobs: disabled("claimJobs"),
    extendLease: disabled("extendLease"),
    recoverClaim: disabled("recoverClaim"),
    recoverTransaction: disabled("recoverTransaction"),
    jobs: disabled("jobs"),
    projectionGet: disabled("projectionGet"),
    projectionVersion: disabled("projectionVersion"),
    streamVersion: disabled("streamVersion"),
    eventsAfter: disabled("eventsAfter"),
    newId: disabled("newId"),
  };

  it.effect("arms nothing when the kernel is disabled", () =>
    Effect.gen(function* () {
      const worker = makeRevertSagaWorker(disabledKernel);
      const handle = yield* worker.armShadowSaga({
        threadId,
        turnCount: 2,
        targetCheckpointRef,
        cwd: "/tmp/workspace",
      });
      assert.isTrue(Option.isNone(handle));
    }),
  );
});
