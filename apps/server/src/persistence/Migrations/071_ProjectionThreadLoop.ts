import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_loop (
      thread_id TEXT PRIMARY KEY,
      loop_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
