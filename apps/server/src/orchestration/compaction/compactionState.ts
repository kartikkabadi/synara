/**
 * compactionState - Pure compaction control state machine.
 *
 * Models one thread's compaction lifecycle as a durable control state driven
 * exclusively by canonical `ThreadCompactionLifecycleEvent`s. The reducer is
 * pure so the reactor can replay persisted rows and live events identically.
 *
 * @module compactionState
 */
import type { ThreadCompactionLifecycleEvent, ThreadTokenUsageSnapshot } from "@synara/contracts";

export type CompactionControlState =
  | { readonly status: "idle" }
  | {
      readonly status: "pending";
      readonly requestId: string;
      readonly trigger: "manual" | "synara-auto";
      readonly reason: string;
      readonly requestedAt: string;
    }
  | {
      readonly status: "running";
      readonly requestId: string;
      readonly owner: "provider" | "synara";
      readonly trigger: "manual" | "provider-auto" | "synara-auto";
      readonly startedAt: string;
      readonly beforeUsage?: ThreadTokenUsageSnapshot;
    }
  | {
      readonly status: "uncertain";
      readonly requestId: string;
      readonly detail: string;
      readonly since: string;
    }
  | {
      readonly status: "suspended";
      readonly reason: string;
      readonly detail?: string;
      readonly since: string;
    };

export const IDLE_COMPACTION_STATE: CompactionControlState = { status: "idle" };

export const PENDING_ACTIVE_TURN_REASON = "waiting-for-active-turn";

type DistributivePick<T, K extends keyof T> = T extends unknown ? Pick<T, K> : never;

export type CompactionLifecycleInput = DistributivePick<
  ThreadCompactionLifecycleEvent,
  "type" | "payload"
>;

/**
 * Advance the compaction control state for one lifecycle event.
 *
 * Terminal outcomes for a different request id than the one currently
 * pending/running are ignored so a stale provider echo cannot clobber a newer
 * operation. `uncertain` is sticky for everything except a fresh start or an
 * explicit terminal event for the same request.
 */
export function compactionReducer(
  state: CompactionControlState,
  event: CompactionLifecycleInput,
): CompactionControlState {
  switch (event.type) {
    case "thread.compaction-requested": {
      if (state.status === "running" || state.status === "pending") {
        return state;
      }
      return {
        status: "pending",
        requestId: event.payload.requestId,
        trigger: event.payload.trigger,
        reason: PENDING_ACTIVE_TURN_REASON,
        requestedAt: event.payload.createdAt,
      };
    }
    case "thread.compaction-started": {
      if (state.status === "running" && state.requestId !== event.payload.requestId) {
        return state;
      }
      return {
        status: "running",
        requestId: event.payload.requestId,
        owner: event.payload.owner,
        trigger: event.payload.trigger,
        startedAt: event.payload.createdAt,
        ...(event.payload.beforeUsage !== undefined
          ? { beforeUsage: event.payload.beforeUsage }
          : {}),
      };
    }
    case "thread.compaction-completed": {
      if (!matchesCurrentRequest(state, event.payload.requestId)) {
        return state;
      }
      return IDLE_COMPACTION_STATE;
    }
    case "thread.compaction-failed": {
      if (!matchesCurrentRequest(state, event.payload.requestId)) {
        return state;
      }
      if (!event.payload.outcomeKnown) {
        return {
          status: "uncertain",
          requestId: event.payload.requestId,
          detail: event.payload.detail ?? event.payload.failureKind,
          since: event.payload.createdAt,
        };
      }
      return IDLE_COMPACTION_STATE;
    }
    case "thread.compaction-suspended": {
      return {
        status: "suspended",
        reason: event.payload.reason,
        ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
        since: event.payload.createdAt,
      };
    }
  }
}

function matchesCurrentRequest(state: CompactionControlState, requestId: string): boolean {
  switch (state.status) {
    case "pending":
    case "running":
    case "uncertain":
      return state.requestId === requestId;
    case "idle":
    case "suspended":
      return false;
  }
}
