import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.SYNARA_HOME
  ? `${process.env.SYNARA_HOME}/dev/state.sqlite`
  : "/home/ubuntu/.synara/dev/state.sqlite";

const dir = dirname(dbPath);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const db = new Database(dbPath);

db.run(`CREATE TABLE IF NOT EXISTS orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  actor_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
)`);

const projectId = randomUUID();
const now = new Date().toISOString();

db.run(
  `INSERT OR IGNORE INTO orchestration_events
    (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    `event-${projectId}`,
    "project",
    projectId,
    1,
    "project.created",
    now,
    "cmd-seed-project",
    null,
    null,
    "user",
    JSON.stringify({
      projectId,
      kind: "project",
      title: "Home",
      workspaceRoot: "/home/ubuntu",
      scripts: [],
      createdAt: now,
      updatedAt: now,
    }),
    "{}",
  ],
);

db.close();
console.log(`Seeded project.created event ${projectId} at ${dbPath}`);
