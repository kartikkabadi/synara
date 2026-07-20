import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Queued-turn promotion rows carry loop-purpose identity so off/reconfigure
// can cancel queued loop-owned turns by activation without scanning events.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('queued_turn_promotions')
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("activation_id")) {
    yield* sql`ALTER TABLE queued_turn_promotions ADD COLUMN activation_id TEXT`;
  }
  if (!names.has("iteration")) {
    yield* sql`ALTER TABLE queued_turn_promotions ADD COLUMN iteration INTEGER`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_turn_promotions_thread_activation
    ON queued_turn_promotions(thread_id, activation_id)
  `;
});
