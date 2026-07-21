import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// No query filters or orders projection_thread_loop by updated_at; lookups are
// by thread_id (the primary key). Drop the unused index.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_loop_updated_at`;
});
