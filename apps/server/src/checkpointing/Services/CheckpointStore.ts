/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef, type ThreadId } from "@synara/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /**
   * Treat an already-existing ref as success and skip the capture.
   *
   * Used for pre-turn baseline refs where the first snapshot must win:
   * overwriting an existing baseline with a later capture would record a
   * working tree the agent may already have modified.
   */
  readonly skipIfExists?: boolean;
}

export interface CopyCheckpointRefInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly maxOutputBytes?: number;
}

export interface ReverseCheckpointDiffInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly maxOutputBytes?: number;
}

export interface CaptureRescueCheckpointInput {
  readonly cwd: string;
  readonly threadId: ThreadId;
  /**
   * Durable saga/job identity the rescue snapshot belongs to. Retries of the
   * same saga deterministically target the same rescue ref.
   */
  readonly sagaId: string;
}

export interface RestoreRescueCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface DeleteRescueRefInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface ListRescueRefsInput {
  readonly cwd: string;
  /**
   * Restrict the listing to rescue refs belonging to one thread.
   */
  readonly threadId?: ThreadId;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   *
   * Uses an isolated temporary Git index and writes a hidden ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Copy an existing checkpoint commit to another hidden ref.
   *
   * Used to bind a pre-send message snapshot to the provider turn id once known.
   */
  readonly copyCheckpointRef: (
    input: CopyCheckpointRefInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint refs.
   *
   * Can optionally treat missing "from" ref as `HEAD`.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Reverse only the changes between two checkpoints onto the current workspace.
   */
  readonly reverseCheckpointDiff: (
    input: ReverseCheckpointDiffInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Best-effort delete: missing refs are tolerated.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Capture a rescue checkpoint of the workspace before a revert mutates it.
   *
   * Returns the rescue ref the snapshot was stored at so the caller can later
   * restore or delete it.
   */
  readonly captureRescueCheckpoint: (
    input: CaptureRescueCheckpointInput,
  ) => Effect.Effect<CheckpointRef, CheckpointStoreError>;

  /**
   * Restore the workspace to a previously captured rescue checkpoint.
   *
   * Never falls back to `HEAD`: returns false when the rescue ref is missing.
   */
  readonly restoreRescueCheckpoint: (
    input: RestoreRescueCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Delete a rescue ref once the revert saga no longer needs it.
   *
   * Best-effort delete: a missing ref is tolerated.
   */
  readonly deleteRescueRef: (
    input: DeleteRescueRefInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Enumerate existing rescue refs so a reconciliation pass can restore or
   * clean up refs leaked by a crash between capture and delete.
   */
  readonly listRescueRefs: (
    input: ListRescueRefsInput,
  ) => Effect.Effect<ReadonlyArray<CheckpointRef>, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "synara/checkpointing/Services/CheckpointStore",
) {}
