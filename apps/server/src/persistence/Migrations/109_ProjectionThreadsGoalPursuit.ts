import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "goal_paused_reason"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_paused_reason TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "goal_token_budget"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_token_budget INTEGER
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "goal_tokens_used"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_tokens_used INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "goal_tokens_observed_json"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_tokens_observed_json TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "goal_budget_limited_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_budget_limited_at TEXT
    `;
  }
});
