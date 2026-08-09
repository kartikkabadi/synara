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
import { LoopPrompt } from "@synara/contracts";
import { Schema } from "effect";

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

function isPersistedLoopPromptValid(loop: ThreadLoop): boolean {
  // An empty prompt is the only valid armed state, and it cannot survive the
  // first accepted iteration. Persisted non-empty prompts use the same schema
  // as new loop commands so legacy rows cannot dispatch invalid turn bodies.
  if (loop.prompt === "") {
    return loop.iteration === 0;
  }
  try {
    Schema.decodeUnknownSync(LoopPrompt)(loop.prompt);
    return true;
  } catch {
    return false;
  }
}

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

  // Account every observed terminal outcome before expiry, final-budget, or
  // prompt decisions. A final iteration can settle just as the duration or
  // count boundary is reached; retiring it without carrying the ledger fields
  // would lose the outcome and make the next activation inherit stale state.
  const accounting = consumeLoopSettlements(loop);
  const accounted = {
    nextConsecutiveErrors: accounting.nextConsecutiveErrors,
    nextLastSettledIteration: accounting.nextLastSettledIteration,
    nextUnsettled: accounting.nextUnsettled,
  };
  if (isLoopExpired(loop, nowMs)) {
    return { type: "off", reason: "budget_duration", ...accounted };
  }
  if (isLoopBudgetExhausted(loop)) {
    return { type: "off", reason: chooseStopReason(loop), ...accounted };
  }
  if (!isPersistedLoopPromptValid(loop)) {
    return { type: "off", reason: "prompt_invalid", ...accounted };
  }

  if (accounting.errorThresholdReached) {
    return {
      type: "off",
      reason: "consecutive_errors",
      ...accounted,
    };
  }
  if (loop.prompt === "") {
    return { type: "wait", ...accounted };
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
    return { type: "wait", ...accounted };
  }

  return {
    type: "continue",
    nextIteration: loop.iteration + 1,
    ...accounted,
  };
}
