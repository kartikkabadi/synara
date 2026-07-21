import type { ThreadTokenUsageSnapshot } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadCompactionOperationRepository,
  type ThreadCompactionOperation,
  type ThreadCompactionOperationRepositoryShape,
} from "../Services/ThreadCompactionOperations.ts";

interface ThreadCompactionOperationRow {
  readonly threadId: string;
  readonly requestId: string;
  readonly status: ThreadCompactionOperation["status"];
  readonly owner: ThreadCompactionOperation["owner"];
  readonly trigger: ThreadCompactionOperation["trigger"];
  readonly sessionEffect: ThreadCompactionOperation["sessionEffect"];
  readonly failureKind: string | null;
  readonly detail: string | null;
  readonly retryable: number | null;
  readonly outcomeKnown: number | null;
  readonly beforeUsageJson: string | null;
  readonly afterUsageJson: string | null;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const columns = (sql: SqlClient.SqlClient) => sql`
  thread_id AS "threadId",
  request_id AS "requestId",
  status,
  owner,
  trigger,
  session_effect AS "sessionEffect",
  failure_kind AS "failureKind",
  detail,
  retryable,
  outcome_known AS "outcomeKnown",
  before_usage_json AS "beforeUsageJson",
  after_usage_json AS "afterUsageJson",
  requested_at AS "requestedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  updated_at AS "updatedAt"
`;

function parseUsage(json: string | null): ThreadTokenUsageSnapshot | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as ThreadTokenUsageSnapshot;
  } catch {
    return null;
  }
}

function toBooleanFlag(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function fromRow(row: ThreadCompactionOperationRow): ThreadCompactionOperation {
  return {
    threadId: row.threadId,
    requestId: row.requestId,
    status: row.status,
    owner: row.owner,
    trigger: row.trigger,
    sessionEffect: row.sessionEffect,
    failureKind: row.failureKind,
    detail: row.detail,
    retryable: toBooleanFlag(row.retryable),
    outcomeKnown: toBooleanFlag(row.outcomeKnown),
    beforeUsage: parseUsage(row.beforeUsageJson),
    afterUsage: parseUsage(row.afterUsageJson),
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert: ThreadCompactionOperationRepositoryShape["upsert"] = (operation) =>
    sql`
      INSERT INTO thread_compaction_operations (
        thread_id, request_id, status, owner, trigger, session_effect,
        failure_kind, detail, retryable, outcome_known,
        before_usage_json, after_usage_json,
        requested_at, started_at, completed_at, updated_at
      ) VALUES (
        ${operation.threadId}, ${operation.requestId}, ${operation.status},
        ${operation.owner}, ${operation.trigger}, ${operation.sessionEffect},
        ${operation.failureKind}, ${operation.detail},
        ${operation.retryable === null ? null : operation.retryable ? 1 : 0},
        ${operation.outcomeKnown === null ? null : operation.outcomeKnown ? 1 : 0},
        ${operation.beforeUsage === null ? null : JSON.stringify(operation.beforeUsage)},
        ${operation.afterUsage === null ? null : JSON.stringify(operation.afterUsage)},
        ${operation.requestedAt}, ${operation.startedAt}, ${operation.completedAt},
        ${operation.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        request_id = excluded.request_id,
        status = excluded.status,
        owner = excluded.owner,
        trigger = excluded.trigger,
        session_effect = excluded.session_effect,
        failure_kind = excluded.failure_kind,
        detail = excluded.detail,
        retryable = excluded.retryable,
        outcome_known = excluded.outcome_known,
        before_usage_json = excluded.before_usage_json,
        after_usage_json = excluded.after_usage_json,
        requested_at = excluded.requested_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ThreadCompactionOperation.upsert")),
    );

  const getByThreadId: ThreadCompactionOperationRepositoryShape["getByThreadId"] = (threadId) =>
    sql<ThreadCompactionOperationRow>`
      SELECT ${columns(sql)}
      FROM thread_compaction_operations
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(fromRow))),
      Effect.mapError(toPersistenceSqlError("ThreadCompactionOperation.getByThreadId")),
    );

  const listUnsettled: ThreadCompactionOperationRepositoryShape["listUnsettled"] = () =>
    sql<ThreadCompactionOperationRow>`
      SELECT ${columns(sql)}
      FROM thread_compaction_operations
      WHERE status IN ('pending', 'running')
      ORDER BY thread_id ASC
    `.pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.mapError(toPersistenceSqlError("ThreadCompactionOperation.listUnsettled")),
    );

  return {
    upsert,
    getByThreadId,
    listUnsettled,
  } satisfies ThreadCompactionOperationRepositoryShape;
});

export const ThreadCompactionOperationRepositoryLive = Layer.effect(
  ThreadCompactionOperationRepository,
  make,
);
