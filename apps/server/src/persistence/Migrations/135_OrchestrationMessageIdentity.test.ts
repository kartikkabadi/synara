import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import OrchestrationEvents from "./001_OrchestrationEvents.ts";
import OrchestrationMessageIdentity from "./135_OrchestrationMessageIdentity.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("135_OrchestrationMessageIdentity", (it) => {
  it.effect(
    "indexes existing message history without changing it and seeks by thread and identity",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* OrchestrationEvents;
        yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES
          (1, 'first', 'thread', 'thread-a', 1, 'thread.message-sent', '2026-10-10T00:00:00.000Z', 'user', '{"messageId":"message","role":"user"}', '{}'),
          (2, 'edit', 'thread', 'thread-a', 2, 'thread.message-sent', '2026-10-10T00:00:00.000Z', 'user', '{"messageId":"message","role":"user"}', '{}'),
          (3, 'other-thread', 'thread', 'thread-b', 1, 'thread.message-sent', '2026-10-10T00:00:00.000Z', 'user', '{"messageId":"message","role":"user"}', '{}'),
          (4, 'assistant', 'thread', 'thread-a', 3, 'thread.message-sent', '2026-10-10T00:00:00.000Z', 'system', '{"messageId":"message","role":"assistant"}', '{}')
      `;
        yield* OrchestrationMessageIdentity;
        yield* OrchestrationMessageIdentity;
        const rows = yield* sql<{ sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = 'thread-a'
          AND event_type = 'thread.message-sent'
          AND json_extract(payload_json, '$.role') = 'user'
          AND json_extract(payload_json, '$.messageId') = 'message'
        ORDER BY sequence DESC LIMIT 1
      `;
        assert.deepStrictEqual(rows, [{ sequence: 2 }]);
        const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN SELECT sequence FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = 'thread-a'
          AND event_type = 'thread.message-sent'
          AND json_extract(payload_json, '$.role') = 'user'
          AND json_extract(payload_json, '$.messageId') = 'message'
        ORDER BY sequence DESC LIMIT 1
      `;
        assert.isTrue(
          plan.some(
            (row) =>
              row.detail.includes("SEARCH") &&
              row.detail.includes("idx_orch_events_message_identity"),
          ),
        );
        const count = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events`;
        assert.deepStrictEqual(count, [{ count: 4 }]);
      }),
  );
});
