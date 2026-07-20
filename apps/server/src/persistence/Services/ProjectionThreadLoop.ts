/**
 * ProjectionThreadLoopRepository - Repository interface for thread loop state.
 *
 * Owns persistence operations for the projected `/loop` state on a thread.
 *
 * @module ProjectionThreadLoopRepository
 */
import { IsoDateTime, ThreadId, ThreadLoop } from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadLoop = Schema.Struct({
  threadId: ThreadId,
  loop: ThreadLoop,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadLoop = typeof ProjectionThreadLoop.Type;

export const GetProjectionThreadLoopInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadLoopInput = typeof GetProjectionThreadLoopInput.Type;

export const DeleteProjectionThreadLoopInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadLoopInput = typeof DeleteProjectionThreadLoopInput.Type;

/**
 * ProjectionThreadLoopRepositoryShape - Service API for projected thread loop state.
 */
export interface ProjectionThreadLoopRepositoryShape {
  /**
   * Insert or replace the projected loop row for a thread.
   */
  readonly upsert: (row: ProjectionThreadLoop) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projected loop state by thread id.
   */
  readonly getByThreadId: (
    input: GetProjectionThreadLoopInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadLoop>, ProjectionRepositoryError>;

  /**
   * Delete projected loop state by thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadLoopInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadLoopRepository - Service tag for thread-loop persistence.
 */
export class ProjectionThreadLoopRepository extends ServiceMap.Service<
  ProjectionThreadLoopRepository,
  ProjectionThreadLoopRepositoryShape
>()("synara/persistence/Services/ProjectionThreadLoop/ProjectionThreadLoopRepository") {}
