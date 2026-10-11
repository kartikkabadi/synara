/**
 * ThreadCompactionOperationRepository - Repository interface for durable
 * compaction operations.
 *
 * Owns a history row per request so the
 * reactor can reconcile in-flight passes after a restart.
 *
 * @module ThreadCompactionOperationRepository
 */
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  ProviderCompactionResult,
  ThreadCompactionSettings,
  ThreadTokenUsageSnapshot,
} from "@synara/contracts";

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
  readonly requestFingerprint?: string | null;
  readonly result?: ProviderCompactionResult | null;
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
  readonly setSettings: (
    threadId: string,
    settings: ThreadCompactionSettings,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listSettings: () => Effect.Effect<
    ReadonlyArray<{ readonly threadId: string; readonly settings: ThreadCompactionSettings }>,
    PersistenceSqlError
  >;

  /** Insert or advance one request without replacing earlier history. */
  readonly upsert: (
    operation: ThreadCompactionOperation,
  ) => Effect.Effect<void, PersistenceSqlError>;

  readonly getByRequestId: (
    requestId: string,
  ) => Effect.Effect<Option.Option<ThreadCompactionOperation>, PersistenceSqlError>;

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
