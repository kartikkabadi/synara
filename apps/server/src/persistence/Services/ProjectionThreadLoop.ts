import { OrchestrationLoop, ThreadId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadLoop = Schema.Struct({
  threadId: ThreadId,
  loop: OrchestrationLoop,
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

export interface ProjectionThreadLoopRepositoryShape {
  readonly upsert: (row: ProjectionThreadLoop) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByThreadId: (
    input: GetProjectionThreadLoopInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadLoop>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadLoopInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadLoopRepository extends ServiceMap.Service<
  ProjectionThreadLoopRepository,
  ProjectionThreadLoopRepositoryShape
>()("t3/persistence/Services/ProjectionThreadLoop/ProjectionThreadLoopRepository") {}
