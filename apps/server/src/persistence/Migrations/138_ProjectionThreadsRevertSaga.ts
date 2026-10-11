import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "revert_saga_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN revert_saga_json TEXT`;
    yield* sql`DELETE FROM projection_state WHERE projector = 'projection.threads'`;
  }
});
