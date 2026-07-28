/**
 * Operator surface over the control-plane kernel for uncertain
 * checkpoint-revert jobs: paginated listing, single lookup, and resolution
 * (retry / markSucceeded / markDead). When the kernel rollout flag is off,
 * listing degrades to an empty result and mutations fail with the kernel's
 * typed "KernelDisabled" error instead of crashing.
 *
 * @module controlPlaneOperator
 */
import { Effect } from "effect";

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

export const getControlPlaneJob = (
  kernel: ControlPlaneKernelShape,
  input: { readonly jobId: string },
): Effect.Effect<ControlPlaneGetJobResult, ControlPlaneKernelError> =>
  kernel.job(input.jobId).pipe(Effect.map((job) => ({ job })));

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
  input: { readonly jobId: string; readonly resolution: ControlPlaneJobResolution },
  nowMs: number = Date.now(),
): Effect.Effect<ControlPlaneResolveUncertainJobResult, ControlPlaneKernelError> =>
  kernel.job(input.jobId).pipe(
    Effect.flatMap((job) => {
      if (job === null) {
        return Effect.fail(invalidResolutionTarget(`Job ${input.jobId} does not exist.`));
      }
      if (
        job.queue !== CHECKPOINT_REVERT_QUEUE ||
        !job.partitionKey.startsWith(THREAD_PARTITION_PREFIX)
      ) {
        return Effect.fail(
          invalidResolutionTarget(`Job ${input.jobId} is not a checkpoint-revert job.`),
        );
      }
      if (job.state !== UNCERTAIN_JOB_STATE) {
        return Effect.fail(
          invalidResolutionTarget(`Job ${input.jobId} is in state "${job.state}", not uncertain.`),
        );
      }
      return kernel.resolveUncertainJobs({
        committedAtMs: nowMs,
        resolutions: [{ jobId: input.jobId, resolution: input.resolution }],
      });
    }),
    Effect.andThen(kernel.job(input.jobId)),
    Effect.map((job) => ({ job })),
  );
