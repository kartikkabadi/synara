// FILE: settlement.ts
// Purpose: Pure per-attempt settlement ledger for `/loop` iterations. Terminal
//          outcomes are recorded exactly once on the ThreadLoop row (durable
//          via the loop projection), then consumed in contiguous iteration
//          order so the `lastSettledIteration` watermark can never skip an
//          unaccounted attempt — regardless of queue-promotion scheduling,
//          duplicate/out-of-order terminal notifications, or restarts.
// Layer: Orchestration decision logic

import type { LoopUnsettledOutcome, ThreadLoop, ThreadTurnPurpose } from "@synara/contracts";
import { LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD } from "@synara/contracts";

export interface LoopSettlementRecord {
  readonly purpose: ThreadTurnPurpose;
  readonly outcome: LoopUnsettledOutcome["outcome"];
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly settledAt: string;
}

/**
 * Records one observed terminal outcome on the loop's unaccounted settlement
 * set. Idempotent per iteration: a duplicate or out-of-order terminal
 * notification for an already-recorded or already-accounted iteration returns
 * null (no change). Records only outcomes belonging to the loop's current
 * activation — a reconfigured loop never inherits a previous activation's
 * attempts.
 */
export function recordLoopSettlement(
  loop: ThreadLoop,
  record: LoopSettlementRecord,
): ThreadLoop | null {
  if (record.purpose.kind !== "loop-iteration") {
    return null;
  }
  if (record.purpose.activationId !== loop.activationId) {
    return null;
  }
  const iteration = record.purpose.iteration;
  if (iteration <= loop.lastSettledIteration) {
    return null;
  }
  if (loop.unsettled.some((entry) => entry.iteration === iteration)) {
    return null;
  }
  const unsettled = [
    ...loop.unsettled,
    {
      activationId: record.purpose.activationId,
      iteration,
      outcome: record.outcome,
      turnId: record.turnId,
      messageId: record.messageId,
      settledAt: record.settledAt,
    },
  ].toSorted((left, right) => left.iteration - right.iteration);
  return { ...loop, unsettled };
}

export interface LoopSettlementAccounting {
  readonly nextConsecutiveErrors: number;
  readonly nextLastSettledIteration: number;
  readonly nextUnsettled: ReadonlyArray<LoopUnsettledOutcome>;
  // True when the consumed outcomes reach the consecutive-error threshold.
  readonly errorThresholdReached: boolean;
}

/**
 * Consumes unaccounted outcomes strictly in contiguous iteration order from
 * the watermark. A gap stops consumption (later outcomes stay buffered until
 * the missing iteration settles), so the watermark advances only across
 * contiguous accounted outcomes and an attempt's result can never be skipped.
 * `completed` resets the error streak, `error` increments it, `interrupted`
 * advances the watermark without touching the streak (user interrupts turn
 * the loop off in the decider before accounting runs; non-user interruptions
 * are infrastructure events, not model failures).
 */
export function consumeLoopSettlements(loop: ThreadLoop): LoopSettlementAccounting {
  let consecutiveErrors = loop.consecutiveErrors;
  let watermark = loop.lastSettledIteration;
  let errorThresholdReached = false;
  const remaining: LoopUnsettledOutcome[] = [];
  const ordered = loop.unsettled.toSorted((left, right) => left.iteration - right.iteration);
  for (const entry of ordered) {
    if (entry.iteration <= watermark) {
      continue;
    }
    if (errorThresholdReached || entry.iteration !== watermark + 1) {
      remaining.push(entry);
      continue;
    }
    watermark = entry.iteration;
    if (entry.outcome === "completed") {
      consecutiveErrors = 0;
    } else if (entry.outcome === "error") {
      consecutiveErrors += 1;
      if (consecutiveErrors >= LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD) {
        // Auto-off fires exactly on the threshold error; later buffered
        // outcomes stay unaccounted with the retired activation.
        errorThresholdReached = true;
      }
    }
  }
  return {
    nextConsecutiveErrors: consecutiveErrors,
    nextLastSettledIteration: watermark,
    nextUnsettled: remaining,
    errorThresholdReached,
  };
}
