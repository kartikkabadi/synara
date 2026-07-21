/**
 * CompactionReactor - Service interface for durable compaction orchestration.
 *
 * Owns the compaction lifecycle for every thread: admission of manual and
 * synara-auto requests, observation of provider-native compaction, and startup
 * reconciliation of interrupted operations.
 *
 * @module CompactionReactor
 */
import type {
  ProviderCompactionRequest,
  ProviderCompactionResult,
  ProviderSetCompactionSettingsInput,
  ThreadId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { CompactionControlState } from "../compaction/compactionState.ts";

export interface CompactionReactorShape {
  /** Reconcile persisted operations, then subscribe to runtime events. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** Resolve when accepted runtime events have been processed. */
  readonly drain: Effect.Effect<void>;

  /**
   * Dispatch a compaction request through the durable lifecycle.
   *
   * Deduplicates by `requestId`, defers behind an active turn, and resolves
   * with the provider result once the operation settles.
   */
  readonly request: (
    input: ProviderCompactionRequest,
  ) => Effect.Effect<ProviderCompactionResult, ProviderServiceError>;

  /** Read the current in-memory control state for a thread. */
  readonly getControlState: (threadId: ThreadId) => Effect.Effect<CompactionControlState>;

  /**
   * Update the thread's Synara-managed auto-compaction policy and republish
   * the runtime status so clients see the new owner/trigger immediately.
   */
  readonly setThreadSettings: (input: ProviderSetCompactionSettingsInput) => Effect.Effect<void>;
}

export class CompactionReactor extends ServiceMap.Service<
  CompactionReactor,
  CompactionReactorShape
>()("synara/orchestration/Services/CompactionReactor") {}
