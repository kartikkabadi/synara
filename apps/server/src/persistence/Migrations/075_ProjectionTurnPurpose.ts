import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const exists = yield* columnExists(sql, "projection_turns", "purpose_json");
  if (!exists) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN purpose_json TEXT
    `;
  }
});
