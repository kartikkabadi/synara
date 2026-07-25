// FILE: reactorTriggers.ts
// Purpose: Pure classification of orchestration events into loop-reactor
//          triggers, so which events re-trigger continuation vs. only sync
//          tracked loop state is declared in one place.
// Layer: Orchestration decision logic

import type {
  LoopStopReason,
  OrchestrationEvent,
  ThreadId,
  ThreadLoop,
} from "@synara/contracts";

export type LoopReactorTrigger =
  | { kind: "sync"; threadId: ThreadId; loop: ThreadLoop }
  | { kind: "sync-and-continue"; threadId: ThreadId; loop: ThreadLoop }
  | { kind: "continue"; threadId: ThreadId }
  | { kind: "lifecycle-off"; threadId: ThreadId; reason: LoopStopReason }
  | { kind: "ignore" };

function isStartupReconciliationCommandId(commandId: OrchestrationEvent["commandId"]): boolean {
  return String(commandId).startsWith("restart-reconcile:");
}

const BLOCKER_RESOLVED_ACTIVITY_KINDS = new Set(["approval.resolved", "user-input.resolved"]);

export function classifyLoopReactorEvent(event: OrchestrationEvent): LoopReactorTrigger {
  switch (event.type) {
    case "thread.loop-set":
      return {
        kind: "sync-and-continue",
        threadId: event.payload.threadId,
        loop: event.payload.loop,
      };
    case "thread.loop-continued":
    case "thread.loop-off":
    // Wait-noted is deliberately non-triggering: a wait outcome must not feed
    // back into another continuation dispatch. Only the tracked loop state
    // (updatedAt rotation) is kept current.
    case "thread.loop-wait-noted":
      return { kind: "sync", threadId: event.payload.threadId, loop: event.payload.loop };
    case "thread.activity-appended": {
      if (!BLOCKER_RESOLVED_ACTIVITY_KINDS.has(event.payload.activity.kind)) {
        return { kind: "ignore" };
      }
      // Startup turn reconciliation emits blocker-resolved activities for
      // stale pending requests. Ignore them here; restoreActiveLoops runs
      // after reconciliation and will continue eligible loops exactly once.
      if (isStartupReconciliationCommandId(event.commandId)) {
        return { kind: "ignore" };
      }
      return { kind: "continue", threadId: event.payload.threadId };
    }
    case "thread.interaction-mode-set":
      return { kind: "continue", threadId: event.payload.threadId };
    case "thread.session-set": {
      // Do not continue during startup turn reconciliation; the orphaned
      // turn is being interrupted and projection is being rebuilt.
      // restoreActiveLoops runs after reconciliation and will issue the
      // single startup continue for this thread if still eligible.
      if (isStartupReconciliationCommandId(event.commandId)) {
        return { kind: "ignore" };
      }
      return { kind: "continue", threadId: event.payload.threadId };
    }
    case "thread.archived":
      return { kind: "lifecycle-off", threadId: event.payload.threadId, reason: "thread_archived" };
    case "thread.deleted":
      return { kind: "lifecycle-off", threadId: event.payload.threadId, reason: "thread_deleted" };
    default:
      return { kind: "ignore" };
  }
}
