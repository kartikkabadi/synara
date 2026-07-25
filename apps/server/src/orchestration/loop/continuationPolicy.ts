// FILE: continuationPolicy.ts
// Purpose: Pure continuation policy for thread-local `/loop` mode.
// Layer: Orchestration decision logic
// Depends on: @synara/contracts loop types

import {
  LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD,
  type LoopStopReason,
  type OrchestrationThreadShell,
  type ThreadLoop,
  type ThreadTurnPurpose,
} from "@synara/contracts";

import { chooseStopReason, isLoopBudgetExhausted, isLoopExpired } from "./budget.ts";

export type LoopDecision =
  | {
      type: "off";
      reason: LoopStopReason;
      nextConsecutiveErrors: number;
    }
  | { type: "wait" }
  | {
      type: "continue";
      nextIteration: number;
      nextConsecutiveErrors: number;
    };

export interface LoopContinuationThreadView {
  deletedAt: string | null;
  archivedAt: string | null;
  parentThreadId: string | null;
  interactionMode: "default" | "plan" | string;
  sessionStatus: string | null;
  sessionActiveTurnId: string | null;
  latestTurnState: "running" | "completed" | "error" | "interrupted" | null;
  latestTurnPurpose: ThreadTurnPurpose | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  hasQueuedTurnStart: boolean;
}

export function buildLoopContinuationThreadView(
  thread: OrchestrationThreadShell,
): LoopContinuationThreadView {
  const latestTurn = thread.latestTurn;
  const session = thread.session;
  return {
    deletedAt: thread.deletedAt ?? null,
    archivedAt: thread.archivedAt ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    interactionMode: thread.interactionMode,
    sessionStatus: session?.status ?? null,
    sessionActiveTurnId: session?.activeTurnId ?? null,
    latestTurnState: latestTurn?.state ?? null,
    latestTurnPurpose: latestTurn?.purpose ?? null,
    hasPendingApproval: thread.hasPendingApprovals ?? false,
    hasPendingUserInput: thread.hasPendingUserInput ?? false,
    hasQueuedTurnStart: thread.hasPendingTurnStart ?? false,
  };
}

// Busy session states that own the provider and cannot accept a new loop turn.
// Terminal/restartable states (ready, idle, error, stopped, interrupted) are not
// in this set because a loop turn must be able to restart the provider the same
// way a manual turn can.
export const RUNNING_SESSION_STATUSES = new Set(["starting", "running", "stopping"]);

/**
 * Pure continue-on-yield policy (issue #49 section 6). `loop.iteration` counts
 * loop-owned turns already accepted/dispatched in this activation; a continue
 * decision proposes `loop.iteration + 1`. Consecutive-error accounting derives
 * from the latest loop-owned terminal turn of the current activation, and only
 * commits when a continue/off decision is persisted.
 */
export function decideLoopContinuation(input: {
  loop: ThreadLoop;
  nowMs: number;
  thread: LoopContinuationThreadView;
}): LoopDecision {
  const { loop, nowMs, thread } = input;
  const unchanged = { nextConsecutiveErrors: loop.consecutiveErrors };

  if (!loop.active) {
    return { type: "wait" };
  }
  if (thread.deletedAt !== null) {
    return { type: "off", reason: "thread_deleted", ...unchanged };
  }
  if (thread.archivedAt !== null) {
    return { type: "off", reason: "thread_archived", ...unchanged };
  }
  if (thread.parentThreadId !== null) {
    return { type: "off", reason: "thread_unrunnable", ...unchanged };
  }
  if (isLoopExpired(loop, nowMs)) {
    return { type: "off", reason: "budget_duration", ...unchanged };
  }
  if (isLoopBudgetExhausted(loop)) {
    return { type: "off", reason: chooseStopReason(loop), ...unchanged };
  }
  if (loop.prompt === "") {
    return { type: "wait" };
  }

  // Error accounting from the latest loop-owned terminal turn of this
  // activation. The turn was dispatched as iteration `loop.iteration`, so a
  // later continue (which advances `iteration`) never recounts it.
  let nextConsecutiveErrors = loop.consecutiveErrors;
  const purpose = thread.latestTurnPurpose;
  const settledCurrentIteration =
    purpose !== null &&
    purpose.kind === "loop-iteration" &&
    purpose.activationId === loop.activationId &&
    purpose.iteration === loop.iteration;
  if (settledCurrentIteration) {
    if (thread.latestTurnState === "completed") {
      nextConsecutiveErrors = 0;
    } else if (thread.latestTurnState === "error") {
      // Interrupted settlements deliberately do not count: user interrupts
      // turn the loop off in the decider before this policy sees them, and
      // non-user interruptions (crash-restart reconciliation, provider aborts)
      // are infrastructure events, not model failures — counting them could
      // wrongly kill healthy loops across restarts. They neither increment
      // nor reset the consecutive-error counter.
      nextConsecutiveErrors = loop.consecutiveErrors + 1;
      if (nextConsecutiveErrors >= LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD) {
        return { type: "off", reason: "consecutive_errors", nextConsecutiveErrors };
      }
    }
  }
  if (
    thread.sessionActiveTurnId !== null ||
    thread.latestTurnState === "running" ||
    thread.hasQueuedTurnStart ||
    thread.hasPendingApproval ||
    thread.hasPendingUserInput ||
    thread.interactionMode === "plan" ||
    (thread.sessionStatus !== null && RUNNING_SESSION_STATUSES.has(thread.sessionStatus))
  ) {
    return { type: "wait" };
  }

  return {
    type: "continue",
    nextIteration: loop.iteration + 1,
    nextConsecutiveErrors,
  };
}
