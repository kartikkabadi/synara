/**
 * ThreadCompactionOperationRepository - Repository interface for durable
 * compaction operations.
 *
 * Owns one row per thread describing the latest compaction operation so the
 * reactor can reconcile in-flight passes after a restart.
 *
 * @module ThreadCompactionOperationRepository
 */
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ThreadTokenUsageSnapshot } from "@synara/contracts";

import type { PersistenceSqlError } from "../Errors.ts";

export type ThreadCompactionOperationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";

export interface ThreadCompactionOperation {
  readonly threadId: string;
  readonly requestId: string;
  readonly status: ThreadCompactionOperationStatus;
  readonly owner: "provider" | "synara";
  readonly trigger: "manual" | "provider-auto" | "synara-auto";
  readonly sessionEffect: "same-session" | "session-rollover" | "runtime-restart" | null;
  readonly failureKind: string | null;
  readonly detail: string | null;
  readonly retryable: boolean | null;
  readonly outcomeKnown: boolean | null;
  readonly beforeUsage: ThreadTokenUsageSnapshot | null;
  readonly afterUsage: ThreadTokenUsageSnapshot | null;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface ThreadCompactionOperationRepositoryShape {
  /** Insert or replace the latest compaction operation row for a thread. */
  readonly upsert: (
    operation: ThreadCompactionOperation,
  ) => Effect.Effect<void, PersistenceSqlError>;

  /** Read the latest compaction operation for a thread. */
  readonly getByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<ThreadCompactionOperation>, PersistenceSqlError>;

  /** List operations still marked pending/running (restart reconciliation input). */
  readonly listUnsettled: () => Effect.Effect<
    ReadonlyArray<ThreadCompactionOperation>,
    PersistenceSqlError
  >;

  /** List settled operations (completed/failed/uncertain) for status hydration. */
  readonly listSettled: () => Effect.Effect<
    ReadonlyArray<ThreadCompactionOperation>,
    PersistenceSqlError
  >;
}

export class ThreadCompactionOperationRepository extends ServiceMap.Service<
  ThreadCompactionOperationRepository,
  ThreadCompactionOperationRepositoryShape
>()("synara/persistence/Services/ThreadCompactionOperations/ThreadCompactionOperationRepository") {}
