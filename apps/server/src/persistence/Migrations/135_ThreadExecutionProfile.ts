import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: remote execution scope survives reload and server restart.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_sessions)`;
  if (!columns.some((column) => column.name === "execution_profile_json")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN execution_profile_json TEXT`;
  }
});
