// FILE: 109_AutomationEventTriggers.ts
// Purpose: Event-triggered automations (durable event claims + seen items), run
// trigger payloads, missed-run grace windows, and per-thread reminders.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "event_triggers_json"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN event_triggers_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "missed_run_grace_seconds"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN missed_run_grace_seconds INTEGER
      CHECK (
        missed_run_grace_seconds IS NULL
        OR missed_run_grace_seconds >= 1
      )
    `;
  }

  // Event runs carry the full AutomationTrigger (source/event/key + display context);
  // trigger_type stays the coarse discriminant used by the scheduled-run dedup index.
  if (!(yield* columnExists(sql, "automation_runs", "trigger_json"))) {
    yield* sql`
      ALTER TABLE automation_runs
      ADD COLUMN trigger_json TEXT
    `;
  }

  // Idempotent event dispatch: one row per (automation, event) forever, so a
  // re-observed inbox item can never double-fire an automation.
  if (!(yield* tableExists(sql, "automation_event_claims"))) {
    yield* sql`
      CREATE TABLE automation_event_claims (
        automation_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (automation_id, event_key)
      )
    `;
    yield* sql`
      CREATE INDEX idx_automation_event_claims_key
      ON automation_event_claims(event_key)
    `;
  }

  // Items the event watcher has already observed, keyed by source-scoped event key
  // (e.g. github:pr:owner/repo:123). Seeding a repo's inbox marks existing items so
  // only items that appear afterwards dispatch runs.
  if (!(yield* tableExists(sql, "automation_event_seen"))) {
    yield* sql`
      CREATE TABLE automation_event_seen (
        event_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        repository TEXT NOT NULL,
        seen_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX idx_automation_event_seen_repository
      ON automation_event_seen(source, repository)
    `;
  }

  if (!(yield* tableExists(sql, "thread_reminders"))) {
    yield* sql`
      CREATE TABLE thread_reminders (
        thread_id TEXT PRIMARY KEY,
        due_at TEXT NOT NULL,
        fired_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX idx_thread_reminders_due
      ON thread_reminders(fired_at, due_at)
    `;
  }
});
