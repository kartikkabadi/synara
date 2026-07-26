// FILE: continuationPolicy.ts
// Purpose: Pure continuation policy for thread-local `/loop` mode.
// Layer: Orchestration decision logic
// Depends on: @synara/contracts loop types

import type {
  LoopStopReason,
  LoopUnsettledOutcome,
  OrchestrationThreadShell,
  ThreadLoop,
  ThreadTurnPurpose,
} from "@synara/contracts";

import { chooseStopReason, isLoopBudgetExhausted, isLoopExpired } from "./budget.ts";
import { consumeLoopSettlements } from "./settlement.ts";

export type LoopDecision =
  | {
      type: "off";
      reason: LoopStopReason;
      nextConsecutiveErrors: number;
      nextLastSettledIteration: number;
      nextUnsettled: ReadonlyArray<LoopUnsettledOutcome>;
    }
  | {
      // Waits persist settlement accounting too: a terminal outcome observed
      // while the next iteration is already queued must still be counted
      // exactly once, not deferred until the loop happens to continue.
      type: "wait";
      nextConsecutiveErrors: number;
      nextLastSettledIteration: number;
      nextUnsettled: ReadonlyArray<LoopUnsettledOutcome>;
    }
  | {
      type: "continue";
      nextIteration: number;
      nextConsecutiveErrors: number;
      nextLastSettledIteration: number;
      nextUnsettled: ReadonlyArray<LoopUnsettledOutcome>;
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
 * decision proposes `loop.iteration + 1`. Consecutive-error accounting
 * consumes the loop's durable unaccounted settlement ledger in contiguous
 * iteration order, and only commits when a wait/continue/off decision is
 * persisted.
 */
export function decideLoopContinuation(input: {
  loop: ThreadLoop;
  nowMs: number;
  thread: LoopContinuationThreadView;
}): LoopDecision {
  const { loop, nowMs, thread } = input;
  const unchanged = {
    nextConsecutiveErrors: loop.consecutiveErrors,
    nextLastSettledIteration: loop.lastSettledIteration,
    nextUnsettled: loop.unsettled,
  };

  if (!loop.active) {
    return { type: "wait", ...unchanged };
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
    return { type: "wait", ...unchanged };
  }

  // Error accounting consumes the loop's durable per-attempt settlement
  // ledger, not the mutable `latestTurn`: a queued replacement that becomes
  // latest before an earlier attempt is accounted can never erase that
  // attempt's outcome, duplicate or out-of-order terminal notifications never
  // recount a settled attempt, and the watermark only advances across
  // contiguous accounted outcomes (a gap is never skipped).
  const accounting = consumeLoopSettlements(loop);
  const nextConsecutiveErrors = accounting.nextConsecutiveErrors;
  const nextLastSettledIteration = accounting.nextLastSettledIteration;
  const nextUnsettled = accounting.nextUnsettled;
  if (accounting.errorThresholdReached) {
    return {
      type: "off",
      reason: "consecutive_errors",
      nextConsecutiveErrors,
      nextLastSettledIteration,
      nextUnsettled,
    };
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
    return { type: "wait", nextConsecutiveErrors, nextLastSettledIteration, nextUnsettled };
  }

  return {
    type: "continue",
    nextIteration: loop.iteration + 1,
    nextConsecutiveErrors,
    nextLastSettledIteration,
    nextUnsettled,
  };
}
