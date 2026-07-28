/**
 * RevertSagaWorker - Durable shadow recording for checkpoint reverts.
 *
 * While `SYNARA_CONTROL_PLANE_KERNEL` is "shadow" (or "on" before the PR 5
 * flip), the legacy revert path in CheckpointReactor stays authoritative and
 * executes all effects. This service records the same revert as a durable
 * saga in the control-plane kernel: an armed intent (event + queued job on
 * `checkpoint-revert`, partitioned per thread), one durable event per step,
 * and an atomic completion that acknowledges the job in the same kernel
 * transaction as the completion event.
 *
 * Every operation is infallible from the caller's perspective: kernel
 * failures are logged, never propagated, so shadow recording can never
 * perturb the legacy path.
 *
 * @module RevertSagaWorker
 */
import type { CheckpointRef, ThreadId } from "@synara/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

export const REVERT_SAGA_QUEUE = "checkpoint-revert";

export interface ArmShadowSagaInput {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly targetCheckpointRef: CheckpointRef;
  readonly cwd: string;
}

/**
 * Handle for one armed shadow saga. Step identifiers mirror the legacy
 * revert sequence: "filesystem-restore", "provider-rollback",
 * "checkpoint-ref-gc".
 */
export interface RevertSagaShadowHandle {
  readonly sagaId: string;

  /**
   * Take a lease on the queued job before executing effects (kernel-
   * authoritative "on" mode). Returns false (logged) when the claim fails;
   * the saga then falls back to settlement by scan. While the lease is
   * held, an uncertain outcome simply leaves it to expire, which is what
   * transitions the reconcilable job to Uncertain.
   */
  readonly claim: () => Effect.Effect<boolean>;

  /** Record one completed step of the legacy revert. */
  readonly recordStep: (stepId: string, detail?: string) => Effect.Effect<void>;

  /**
   * Record an ambiguous step outcome (e.g. a provider rollback whose effect
   * is unknown). The queued job is left unacknowledged so it surfaces as
   * uncertain instead of silently retrying or assuming failure.
   */
  readonly recordUncertain: (stepId: string, detail: string) => Effect.Effect<void>;

  /**
   * Record that the legacy revert stopped before mutating anything; the
   * queued job is acknowledged since there is nothing left to do.
   */
  readonly abort: (detail: string) => Effect.Effect<void>;

  /**
   * Atomically record completion and acknowledge the queued job in one
   * kernel transaction, then verify the recorded trail and log mismatches.
   */
  readonly complete: () => Effect.Effect<void>;
}

/**
 * RevertSagaWorkerShape - Service API for shadow-recording revert sagas.
 */
export interface RevertSagaWorkerShape {
  /** Effective rollout mode of the backing kernel. */
  readonly mode: "off" | "shadow" | "on";

  /**
   * Arm a shadow saga before the legacy revert mutates anything. Returns
   * `Option.none()` when the kernel is off or arming fails (logged).
   */
  readonly armShadowSaga: (
    input: ArmShadowSagaInput,
  ) => Effect.Effect<Option.Option<RevertSagaShadowHandle>>;
}

/**
 * RevertSagaWorker - Service tag.
 */
export class RevertSagaWorker extends ServiceMap.Service<RevertSagaWorker, RevertSagaWorkerShape>()(
  "synara/orchestration/Services/RevertSagaWorker",
) {}
