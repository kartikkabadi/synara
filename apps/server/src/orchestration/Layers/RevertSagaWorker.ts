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
const EXECUTOR_WORKER_ID = "checkpoint-revert-executor";
const SHADOW_CLAIM_LEASE_MS = 30_000;
const EXECUTOR_LEASE_MS = 60_000;
const SHADOW_CLAIM_LIMIT = 8;

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
  let heldLeaseToken: string | null = null;

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

  const claim = () =>
    Effect.gen(function* () {
      const outcome = yield* kernel.claimJobs({
        queue: REVERT_SAGA_QUEUE,
        workerId: EXECUTOR_WORKER_ID,
        nowMs: Date.now(),
        leaseMs: EXECUTOR_LEASE_MS,
        limit: SHADOW_CLAIM_LIMIT,
      });
      const claimedJob = outcome.jobs.find((job) => job.jobId === jobId);
      if (!claimedJob) {
        yield* Effect.logWarning("revert saga job could not be claimed", {
          sagaId,
          jobId,
          threadId: input.threadId,
          claimedJobIds: outcome.jobs.map((job) => job.jobId),
        });
        return false;
      }
      heldLeaseToken = claimedJob.leaseToken;
      return true;
    }).pipe(Effect.catch((error) => logKernelFailure("claim")(error).pipe(Effect.as(false))));

  // Acknowledge this saga's job in the same kernel transaction as the
  // terminal event, using the held lease when the executor claimed the job
  // up front, otherwise claiming by scan (shadow mode). Jobs claimed
  // alongside that belong to other sagas are left to lease-expire; shadow
  // mode never executes anything, so an expiring shadow lease is only log
  // noise.
  const settleJob = (eventType: string, payload: object) =>
    Effect.gen(function* () {
      let leaseToken = heldLeaseToken;
      if (leaseToken === null) {
        const outcome = yield* kernel.claimJobs({
          queue: REVERT_SAGA_QUEUE,
          workerId: SHADOW_WORKER_ID,
          nowMs: Date.now(),
          leaseMs: SHADOW_CLAIM_LEASE_MS,
          limit: SHADOW_CLAIM_LIMIT,
        });
        const claimedJob = outcome.jobs.find((job) => job.jobId === jobId);
        if (!claimedJob) {
          yield* Effect.logWarning("revert saga shadow job missing at settlement", {
            sagaId,
            jobId,
            threadId: input.threadId,
            claimedJobIds: outcome.jobs.map((job) => job.jobId),
          });
          return;
        }
        leaseToken = claimedJob.leaseToken;
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
        ackJobs: [{ jobId, leaseToken }],
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
    claim,
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
  mode: kernel.mode,
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
