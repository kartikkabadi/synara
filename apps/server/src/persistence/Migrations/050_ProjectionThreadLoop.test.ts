import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const tableColumns = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_loop')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

describe("050_ProjectionThreadLoop", () => {
  it.effect("creates the projection_thread_loop table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });

      const beforeRows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_loop'
      `;
      assert.lengthOf(beforeRows, 0);

      yield* runMigrations({ toMigrationInclusive: 50 });

      const afterRows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_loop'
      `;
      assert.lengthOf(afterRows, 1);

      const columns = yield* tableColumns(sql);
      assert.includeMembers(columns, ["thread_id", "loop_json", "updated_at"]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("is idempotent when the table already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_loop'
      `;
      assert.lengthOf(rows, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
