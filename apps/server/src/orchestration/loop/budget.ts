// FILE: budget.ts
// Purpose: Shared budget/expiry math for `/loop` activations. Single owner of
//          the cap, stop-reason, and fail-closed expiry semantics so every
//          loop policy classifies budgets identically.
// Layer: Orchestration decision logic

import type { LoopStopReason, ThreadLoop } from "@synara/contracts";

export function effectiveCap(loop: ThreadLoop): number {
  // Explicit maxIterations is capped by the hard cap so a user-provided budget
  // can never exceed the global ceiling.
  return Math.min(loop.maxIterations ?? loop.hardCap, loop.hardCap);
}

export function chooseStopReason(loop: ThreadLoop): LoopStopReason {
  if (loop.maxIterations !== null && loop.iteration >= loop.maxIterations) {
    return "budget_iterations";
  }
  return "hard_cap";
}

// Fail closed: an unparseable endsAt must expire immediately, not never.
export function isLoopExpired(loop: ThreadLoop, nowMs: number): boolean {
  if (loop.endsAt === null) {
    return false;
  }
  const endsAtMs = Date.parse(loop.endsAt);
  return !Number.isFinite(endsAtMs) || nowMs >= endsAtMs;
}

export function isLoopBudgetExhausted(loop: ThreadLoop): boolean {
  return loop.iteration >= effectiveCap(loop);
}
