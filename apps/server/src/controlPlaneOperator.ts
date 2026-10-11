/** Owner-only inspection and audited closure of shadow revert observations. */
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
      afterSequence,
      limit: input.limit ?? DEFAULT_PAGE_LIMIT,
    })
    .pipe(
      Effect.flatMap((page) =>
        Effect.gen(function* () {
          const jobs = yield* Effect.forEach(
            page.jobs,
            (job) =>
              job.state === UNCERTAIN_JOB_STATE
                ? Effect.succeed(job)
                : getRevertContext(kernel, job.jobId).pipe(
                    Effect.map((context) =>
                      context?.status === "uncertain" &&
                      (job.state === "pending" || job.state === "leased")
                        ? job
                        : null,
                    ),
                  ),
            { concurrency: 4 },
          );
          return {
            kernelEnabled: true,
            jobs: jobs.filter((job) => job !== null),
            nextAfterSequence: page.nextAfterSequence,
          };
        }),
      ),
    );
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
 * Close a verified shadow observation without changing domain or provider state.
 * A native uncertain job is resolved conditionally; a pending observation must
 * first acquire its own partition's lease. Audit and context updates are atomic.
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
        const projection = `revert-job/${input.jobId}`;
        const expectedVersion = yield* kernel.projectionVersion(projection);
        const context = yield* getRevertContext(kernel, input.jobId);
        if (
          context === null ||
          context.status !== "uncertain" ||
          job.partitionKey !== `thread:${context.threadId}/saga:${context.sagaId}`
        ) {
          return yield* Effect.fail(
            invalidResolutionTarget(
              "Only recorded shadow observations can be resolved here. Legacy or authoritative jobs require manual recovery.",
            ),
          );
        }
        if (!["uncertain", "pending"].includes(job.state)) {
          return yield* Effect.fail(
            invalidResolutionTarget(
              `Job ${input.jobId} is in state "${job.state}", not available for a decision.`,
            ),
          );
        }
        let leaseToken: string | undefined;
        if (job.state === "pending") {
          const claim = yield* kernel.claimJobs({
            queue: CHECKPOINT_REVERT_QUEUE,
            partitionKey: job.partitionKey,
            workerId: "shadow-observation-operator",
            nowMs,
            leaseMs: 30_000,
            limit: 1,
          });
          leaseToken = claim.jobs.find((claimed) => claimed.jobId === input.jobId)?.leaseToken;
          if (!leaseToken)
            return yield* Effect.fail(
              invalidResolutionTarget(
                "The observation could not be claimed; reload it before recording a decision.",
              ),
            );
        }
        const transactionId = yield* kernel.newId();
        const batch = {
          transactionId,
          committedAtMs: nowMs,
          ...(leaseToken
            ? { ackJobs: [{ jobId: input.jobId, leaseToken }] }
            : { resolveUncertainJobs: [{ jobId: input.jobId, resolution: input.resolution }] }),
          projectionPatches: [
            {
              projection,
              expectedVersion,
              puts: [
                {
                  key: new TextEncoder().encode("context"),
                  value: new TextEncoder().encode(
                    JSON.stringify({ ...context, status: "resolved" }),
                  ),
                },
              ],
            },
          ],
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
