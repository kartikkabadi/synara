/**
 * Operator surface over the control-plane kernel for uncertain
 * checkpoint-revert jobs: paginated listing, single lookup, and resolution
 * (retry / markSucceeded / markDead). When the kernel rollout flag is off,
 * listing degrades to an empty result and mutations fail with the kernel's
 * typed "KernelDisabled" error instead of crashing.
 *
 * @module controlPlaneOperator
 */
import { Effect, Schema } from "effect";

import { ControlPlaneRevertContext } from "@synara/contracts";

import type {
  ControlPlaneGetJobResult,
  ControlPlaneJobResolution,
  ControlPlaneListUncertainRevertJobsResult,
  ControlPlaneResolveUncertainJobResult,
} from "@synara/contracts";

import { ControlPlaneKernelError } from "./persistence/Services/ControlPlaneKernel.ts";
import type { ControlPlaneKernelShape } from "./persistence/Services/ControlPlaneKernel.ts";

export const CHECKPOINT_REVERT_QUEUE = "checkpoint-revert";
export const UNCERTAIN_JOB_STATE = "uncertain";

const DEFAULT_PAGE_LIMIT = 50;

export const listUncertainRevertJobs = (
  kernel: ControlPlaneKernelShape,
  input: {
    readonly afterSequence?: number | undefined;
    readonly limit?: number | undefined;
  },
): Effect.Effect<ControlPlaneListUncertainRevertJobsResult, ControlPlaneKernelError> => {
  const afterSequence = input.afterSequence ?? 0;
  if (kernel.mode === "off") {
    return Effect.succeed({ kernelEnabled: false, jobs: [], nextAfterSequence: afterSequence });
  }
  return kernel
    .jobsPage({
      queue: CHECKPOINT_REVERT_QUEUE,
      state: UNCERTAIN_JOB_STATE,
      afterSequence,
      limit: input.limit ?? DEFAULT_PAGE_LIMIT,
    })
    .pipe(Effect.map((page) => ({ kernelEnabled: true, ...page })));
};

const getRevertContext = (kernel: ControlPlaneKernelShape, jobId: string) =>
  kernel
    .projectionGet({ projection: `revert-job/${jobId}`, key: new TextEncoder().encode("context") })
    .pipe(
      Effect.flatMap((bytes) =>
        bytes === null
          ? Effect.succeed(null)
          : Schema.decodeUnknownEffect(Schema.fromJsonString(ControlPlaneRevertContext))(
              new TextDecoder().decode(bytes),
            ).pipe(
              Effect.mapError(() =>
                invalidResolutionTarget(
                  "The recorded revert context is invalid; keep the job for manual inspection.",
                ),
              ),
            ),
      ),
    );

export const getControlPlaneJob = (
  kernel: ControlPlaneKernelShape,
  input: { readonly jobId: string },
): Effect.Effect<ControlPlaneGetJobResult, ControlPlaneKernelError> =>
  Effect.gen(function* () {
    const job = yield* kernel.job(input.jobId);
    const context =
      job?.queue === CHECKPOINT_REVERT_QUEUE ? yield* getRevertContext(kernel, input.jobId) : null;
    return { job, context };
  });

export const THREAD_PARTITION_PREFIX = "thread:";

const invalidResolutionTarget = (detail: string) =>
  new ControlPlaneKernelError({
    operation: "resolveUncertainRevertJob",
    code: "InvalidResolutionTarget",
    detail,
  });

/**
 * Resolves one uncertain checkpoint-revert job. The target is validated
 * server-side first (it must exist, live on the checkpoint-revert queue with a
 * `thread:` partition key, and still be uncertain) so this endpoint can never
 * resolve jobs belonging to other control-plane queues. The kernel itself only
 * resolves jobs that are still uncertain at commit time, so a state change
 * between this read and the commit fails there rather than being applied.
 */
export const resolveUncertainRevertJob = (
  kernel: ControlPlaneKernelShape,
  input: {
    readonly jobId: string;
    readonly resolution: ControlPlaneJobResolution;
    readonly reason: string;
  },
  nowMs: number = Date.now(),
): Effect.Effect<ControlPlaneResolveUncertainJobResult, ControlPlaneKernelError> =>
  kernel.job(input.jobId).pipe(
    Effect.flatMap((job) =>
      Effect.gen(function* () {
        if (job === null) {
          return yield* Effect.fail(invalidResolutionTarget(`Job ${input.jobId} does not exist.`));
        }
        if (
          job.queue !== CHECKPOINT_REVERT_QUEUE ||
          !job.partitionKey.startsWith(THREAD_PARTITION_PREFIX) ||
          job.partitionKey.length === THREAD_PARTITION_PREFIX.length
        ) {
          return yield* Effect.fail(
            invalidResolutionTarget(`Job ${input.jobId} is not a checkpoint-revert job.`),
          );
        }
        if (job.state !== UNCERTAIN_JOB_STATE) {
          return yield* Effect.fail(
            invalidResolutionTarget(
              `Job ${input.jobId} is in state "${job.state}", not uncertain.`,
            ),
          );
        }
        if (input.resolution === "retry") {
          return yield* Effect.fail(
            invalidResolutionTarget(
              "Retry is unavailable: there is no durable revert executor. No provider action was scheduled.",
            ),
          );
        }
        const reason = input.reason.trim();
        if (reason.length === 0 || reason.length > 2000) {
          return yield* Effect.fail(
            invalidResolutionTarget("A reason of 1 to 2000 characters is required."),
          );
        }
        const context = yield* getRevertContext(kernel, input.jobId);
        if (
          context === null ||
          job.partitionKey !== `thread:${context.threadId}/saga:${context.sagaId}`
        ) {
          return yield* Effect.fail(
            invalidResolutionTarget(
              "Only recorded shadow observations can be resolved here. Legacy or authoritative jobs require manual recovery.",
            ),
          );
        }
        const transactionId = yield* kernel.newId();
        const batch = {
          transactionId,
          committedAtMs: nowMs,
          resolveUncertainJobs: [{ jobId: input.jobId, resolution: input.resolution }],
          events: [
            {
              streamId: `revert-saga/${context.sagaId}`,
              eventType: "thread.revert.operator-resolved",
              occurredAtMs: nowMs,
              payload: new TextEncoder().encode(
                JSON.stringify({
                  jobId: input.jobId,
                  resolution: input.resolution,
                  reason,
                  mode: "shadow",
                }),
              ),
            },
          ],
        };
        return yield* kernel
          .commit(batch)
          .pipe(
            Effect.catch((error) =>
              error.code !== "CommitIndeterminate"
                ? Effect.fail(error)
                : kernel
                    .recoverTransaction(transactionId)
                    .pipe(
                      Effect.flatMap((recovery) =>
                        recovery.kind === "committed" && recovery.receipt
                          ? Effect.succeed(recovery.receipt)
                          : Effect.fail(error),
                      ),
                    ),
            ),
          );
      }),
    ),
    Effect.andThen(kernel.job(input.jobId)),
    Effect.map((job) => ({ job })),
  );
