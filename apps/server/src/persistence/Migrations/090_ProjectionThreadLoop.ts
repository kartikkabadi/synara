import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

// /loop projection state: loop snapshot per thread, purpose identity on
// messages/turns, and loop identity on queued-turn promotions so off and
// reconfigure can cancel queued loop-owned turns by activation without
// scanning events.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_loop (
      thread_id TEXT PRIMARY KEY,
      loop_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const messagePurposeExists = yield* columnExists(
    sql,
    "projection_thread_messages",
    "purpose_json",
  );
  if (!messagePurposeExists) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN purpose_json TEXT
    `;
  }

  const turnPurposeExists = yield* columnExists(sql, "projection_turns", "purpose_json");
  if (!turnPurposeExists) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN purpose_json TEXT
    `;
  }

  const activationIdExists = yield* columnExists(sql, "queued_turn_promotions", "activation_id");
  if (!activationIdExists) {
    yield* sql`ALTER TABLE queued_turn_promotions ADD COLUMN activation_id TEXT`;
  }
  const iterationExists = yield* columnExists(sql, "queued_turn_promotions", "iteration");
  if (!iterationExists) {
    yield* sql`ALTER TABLE queued_turn_promotions ADD COLUMN iteration INTEGER`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_turn_promotions_thread_activation
    ON queued_turn_promotions(thread_id, activation_id)
  `;
});
