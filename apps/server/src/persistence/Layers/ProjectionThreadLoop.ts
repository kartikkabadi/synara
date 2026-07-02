import { OrchestrationLoop } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadLoopInput,
  GetProjectionThreadLoopInput,
  ProjectionThreadLoop,
  ProjectionThreadLoopRepository,
  type ProjectionThreadLoopRepositoryShape,
} from "../Services/ProjectionThreadLoop.ts";

const ProjectionThreadLoopDbRow = ProjectionThreadLoop.mapFields(
  Struct.assign({ loop: Schema.fromJsonString(OrchestrationLoop) }),
);

const makeProjectionThreadLoopRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadLoopRow = SqlSchema.void({
    Request: ProjectionThreadLoop,
    execute: (row) => sql`
      INSERT INTO projection_thread_loop (
        thread_id,
        loop_json,
        updated_at
      )
      VALUES (
        ${row.threadId},
        ${JSON.stringify(row.loop)},
        ${row.loop.updatedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        loop_json = excluded.loop_json,
        updated_at = excluded.updated_at
    `,
  });

  const getProjectionThreadLoopRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadLoopInput,
    Result: ProjectionThreadLoopDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        loop_json AS "loop"
      FROM projection_thread_loop
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadLoopRow = SqlSchema.void({
    Request: DeleteProjectionThreadLoopInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_loop
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadLoopRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadLoopRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadLoopRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadLoopRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadLoopRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadLoopRepository.getByThreadId:query")),
    );

  const deleteByThreadId: ProjectionThreadLoopRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadLoopRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadLoopRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadLoopRepositoryShape;
});

export const ProjectionThreadLoopRepositoryLive = Layer.effect(
  ProjectionThreadLoopRepository,
  makeProjectionThreadLoopRepository,
);
