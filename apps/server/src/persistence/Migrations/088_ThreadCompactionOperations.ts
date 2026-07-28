import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_compaction_operations (
      thread_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'uncertain')),
      owner TEXT NOT NULL CHECK (owner IN ('provider', 'synara')),
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'provider-auto', 'synara-auto')),
      session_effect TEXT CHECK (session_effect IN ('same-session', 'session-rollover', 'runtime-restart')),
      failure_kind TEXT,
      detail TEXT,
      retryable INTEGER,
      outcome_known INTEGER,
      before_usage_json TEXT,
      after_usage_json TEXT,
      requested_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_compaction_operations_status
    ON thread_compaction_operations(status)
  `;
});
