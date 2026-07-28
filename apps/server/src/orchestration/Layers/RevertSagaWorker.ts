/**
 * RevertSagaWorkerLive - Shadow-mode revert saga recording over the kernel.
 *
 * Event trail per saga, on stream `revert-saga/<sagaId>`:
 *   1. `thread.revert.started`   (armed; job enqueued in the same commit)
 *   2. `thread.revert.step`      (one per legacy step)
 *   3. terminal: `thread.revert.completed` (job acked in the same commit),
 *      `thread.revert.aborted` (nothing mutated, job acked), or
 *      `thread.revert.uncertain` (job left unacked so it surfaces as
 *      uncertain instead of silently retrying).
 *
 * @module RevertSagaWorkerLive
 */
import { Effect, Layer, Option } from "effect";

import {
  ControlPlaneKernel,
  type ControlPlaneKernelShape,
} from "../../persistence/Services/ControlPlaneKernel.ts";
import {
  REVERT_SAGA_QUEUE,
  RevertSagaWorker,
  type ArmShadowSagaInput,
  type RevertSagaShadowHandle,
  type RevertSagaWorkerShape,
} from "../Services/RevertSagaWorker.ts";

const SHADOW_WORKER_ID = "checkpoint-reactor-shadow";
const SHADOW_CLAIM_LEASE_MS = 30_000;

const encodePayload = (payload: object): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(payload));

const sagaStreamId = (sagaId: string): string => `revert-saga/${sagaId}`;

const logKernelFailure = (operation: string) => (error: { readonly message: string }) =>
  Effect.logWarning("revert saga shadow recording failed", {
    operation,
    detail: error.message,
  });

function makeHandle(
  kernel: ControlPlaneKernelShape,
  input: ArmShadowSagaInput,
  sagaId: string,
  jobId: string,
): RevertSagaShadowHandle {
  const appendEvent = (eventType: string, payload: object) =>
    kernel
      .commit({
        committedAtMs: Date.now(),
        events: [
          {
            streamId: sagaStreamId(sagaId),
            eventType,
            occurredAtMs: Date.now(),
            payload: encodePayload(payload),
          },
        ],
      })
      .pipe(Effect.asVoid, Effect.catch(logKernelFailure(eventType)));

  // Claim this saga's job deterministically — scoped to its thread
  // partition with limit 1 — and acknowledge it in the same kernel
  // transaction as the terminal event. The partition claim leases only the
  // per-thread FIFO head (this saga's job under the thread revert lease),
  // so settlement can never lease or mutate another saga's job.
  const settleJob = (eventType: string, payload: object) =>
    Effect.gen(function* () {
      const claim = yield* kernel.claimJobs({
        queue: REVERT_SAGA_QUEUE,
        workerId: SHADOW_WORKER_ID,
        nowMs: Date.now(),
        leaseMs: SHADOW_CLAIM_LEASE_MS,
        limit: 1,
        partitionKey: `thread:${input.threadId}`,
      });
      const claimedJob = claim.jobs.find((job) => job.jobId === jobId);
      if (!claimedJob) {
        yield* Effect.logWarning("revert saga shadow job missing at settlement", {
          sagaId,
          jobId,
          threadId: input.threadId,
          claimedJobIds: claim.jobs.map((job) => job.jobId),
        });
        return;
      }
      yield* kernel.commit({
        committedAtMs: Date.now(),
        events: [
          {
            streamId: sagaStreamId(sagaId),
            eventType,
            occurredAtMs: Date.now(),
            payload: encodePayload(payload),
          },
        ],
        ackJobs: [{ jobId: claimedJob.jobId, leaseToken: claimedJob.leaseToken }],
      });
    }).pipe(Effect.catch(logKernelFailure(eventType)));

  const verifyTrail = Effect.gen(function* () {
    const streamVersion = yield* kernel.streamVersion(sagaStreamId(sagaId));
    // Complete trail is at least armed + terminal.
    if (streamVersion < 2) {
      yield* Effect.logWarning("revert saga shadow trail incomplete", {
        sagaId,
        threadId: input.threadId,
        streamVersion,
      });
    }
  }).pipe(Effect.catch(logKernelFailure("verifyTrail")));

  return {
    sagaId,
    recordStep: (stepId, detail) =>
      appendEvent("thread.revert.step", {
        sagaId,
        threadId: input.threadId,
        turnCount: input.turnCount,
        stepId,
        ...(detail === undefined ? {} : { detail }),
      }),
    recordUncertain: (stepId, detail) =>
      appendEvent("thread.revert.uncertain", {
        sagaId,
        threadId: input.threadId,
        turnCount: input.turnCount,
        stepId,
        detail,
      }),
    abort: (detail) =>
      settleJob("thread.revert.aborted", {
        sagaId,
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail,
      }),
    complete: () =>
      settleJob("thread.revert.completed", {
        sagaId,
        threadId: input.threadId,
        turnCount: input.turnCount,
      }).pipe(Effect.andThen(verifyTrail)),
  };
}

export const makeRevertSagaWorker = (kernel: ControlPlaneKernelShape): RevertSagaWorkerShape => ({
  armShadowSaga: (input) =>
    kernel.mode === "off"
      ? Effect.succeedNone
      : Effect.gen(function* () {
          const sagaId = yield* kernel.newId();
          const jobId = yield* kernel.newId();
          yield* kernel.commit({
            committedAtMs: Date.now(),
            events: [
              {
                streamId: sagaStreamId(sagaId),
                eventType: "thread.revert.started",
                occurredAtMs: Date.now(),
                payload: encodePayload({
                  sagaId,
                  threadId: input.threadId,
                  turnCount: input.turnCount,
                  targetCheckpointRef: input.targetCheckpointRef,
                  cwd: input.cwd,
                }),
              },
            ],
            enqueueJobs: [
              {
                jobId,
                queue: REVERT_SAGA_QUEUE,
                partitionKey: `thread:${input.threadId}`,
                payload: encodePayload({
                  sagaId,
                  threadId: input.threadId,
                  turnCount: input.turnCount,
                  targetCheckpointRef: input.targetCheckpointRef,
                }),
              },
            ],
          });
          return Option.some(makeHandle(kernel, input, sagaId, jobId));
        }).pipe(
          Effect.catch((error) =>
            logKernelFailure("armShadowSaga")(error).pipe(Effect.as(Option.none())),
          ),
        ),
});

export const RevertSagaWorkerLive = Layer.effect(RevertSagaWorker)(
  Effect.map(Effect.service(ControlPlaneKernel), makeRevertSagaWorker),
);
