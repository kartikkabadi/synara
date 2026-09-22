import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("109_ProjectionThreadsGoalPursuit", () => {
  it.effect("adds goal pursuit columns and safely accepts pre-existing columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_paused_reason TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_token_budget INTEGER`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_tokens_used INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_tokens_observed_json TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_budget_limited_at TEXT`;

      yield* runMigrations({ toMigrationInclusive: 109 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      const names = columns.map((column) => column.name);
      for (const expected of [
        "goal_paused_reason",
        "goal_token_budget",
        "goal_tokens_used",
        "goal_tokens_observed_json",
        "goal_budget_limited_at",
      ]) {
        assert.strictEqual(
          names.filter((name) => name === expected).length,
          1,
          `expected exactly one ${expected} column`,
        );
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
