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

import type {
  ControlPlaneKernelError,
  ControlPlaneKernelShape,
} from "./persistence/Services/ControlPlaneKernel.ts";

export const CHECKPOINT_REVERT_QUEUE = "checkpoint-revert";
export const UNCERTAIN_JOB_STATE = "uncertain";

const DEFAULT_PAGE_LIMIT = 50;

export const listUncertainRevertJobs = (
  kernel: ControlPlaneKernelShape,
  input: { readonly afterSequence?: number; readonly limit?: number },
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

export const resolveUncertainRevertJob = (
  kernel: ControlPlaneKernelShape,
  input: { readonly jobId: string; readonly resolution: ControlPlaneJobResolution },
  nowMs: number = Date.now(),
): Effect.Effect<ControlPlaneResolveUncertainJobResult, ControlPlaneKernelError> =>
  kernel
    .resolveUncertainJobs({
      committedAtMs: nowMs,
      resolutions: [{ jobId: input.jobId, resolution: input.resolution }],
    })
    .pipe(
      Effect.andThen(kernel.job(input.jobId)),
      Effect.map((job) => ({ job })),
    );
