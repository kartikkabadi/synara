import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep turn admission independent of transcript rollback and windowing. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_message_identity
    ON orchestration_events(stream_id, json_extract(payload_json, '$.messageId'), sequence)
    WHERE aggregate_kind = 'thread' AND event_type = 'thread.message-sent'
      AND json_extract(payload_json, '$.role') = 'user'
  `;
});
