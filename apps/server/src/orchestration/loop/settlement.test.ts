import { LoopActivationId, type LoopUnsettledOutcome, type ThreadLoop } from "@synara/contracts";
import {
  LOOP_FIXTURE_ACTIVATION_ID,
  makeLoop as makeLoopFixture,
} from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { consumeLoopSettlements, recordLoopSettlement } from "./settlement";

const ACTIVATION_ID = LOOP_FIXTURE_ACTIVATION_ID;

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return makeLoopFixture({ prompt: "fix the tests", ...overrides });
}

function record(
  outcome: LoopUnsettledOutcome["outcome"],
  iteration: number,
  activationId: LoopActivationId = ACTIVATION_ID,
) {
  return {
    purpose: { kind: "loop-iteration" as const, activationId, iteration },
    outcome,
    turnId: `turn-${iteration}`,
    messageId: `message-${iteration}`,
    settledAt: "2026-07-19T11:30:00.000Z",
  };
}

describe("recordLoopSettlement", () => {
  it("writes a terminal outcome exactly once per iteration", () => {
    const first = recordLoopSettlement(makeLoop({ iteration: 1 }), record("error", 1));
    expect(first?.unsettled).toHaveLength(1);
    // Duplicate terminal notification for the same iteration: no change.
    expect(recordLoopSettlement(first!, record("error", 1))).toBeNull();
    expect(recordLoopSettlement(first!, record("completed", 1))).toBeNull();
  });

  it("keeps out-of-order outcomes sorted by iteration", () => {
    const withThree = recordLoopSettlement(makeLoop({ iteration: 3 }), record("error", 3));
    const withBoth = recordLoopSettlement(withThree!, record("completed", 2));
    expect(withBoth?.unsettled.map((entry) => entry.iteration)).toEqual([2, 3]);
  });

  it("ignores outcomes already below the settlement watermark", () => {
    expect(
      recordLoopSettlement(makeLoop({ iteration: 3, lastSettledIteration: 2 }), record("error", 2)),
    ).toBeNull();
  });

  it("ignores outcomes from a different activation", () => {
    expect(
      recordLoopSettlement(
        makeLoop({ iteration: 1 }),
        record("error", 1, LoopActivationId.makeUnsafe("stale-activation")),
      ),
    ).toBeNull();
  });
});

describe("consumeLoopSettlements", () => {
  it("consumes contiguous outcomes in iteration order and advances the watermark", () => {
    const loop = makeLoop({
      iteration: 3,
      lastSettledIteration: 0,
      unsettled: (
        [
          [2, "error"],
          [1, "completed"],
          [3, "error"],
        ] as const
      ).map(([iteration, outcome]) => ({
        activationId: ACTIVATION_ID,
        iteration,
        outcome,
        turnId: `turn-${iteration}`,
        messageId: `message-${iteration}`,
        settledAt: "2026-07-19T11:30:00.000Z",
      })),
    });
    const accounting = consumeLoopSettlements(loop);
    expect(accounting.nextLastSettledIteration).toBe(3);
    expect(accounting.nextConsecutiveErrors).toBe(2);
    expect(accounting.nextUnsettled).toEqual([]);
    expect(accounting.errorThresholdReached).toBe(false);
  });

  it("stops at a gap so an unobserved outcome is never skipped", () => {
    const loop = makeLoop({
      iteration: 3,
      lastSettledIteration: 1,
      unsettled: [
        {
          activationId: ACTIVATION_ID,
          iteration: 3,
          outcome: "error",
          turnId: "turn-3",
          messageId: "message-3",
          settledAt: "2026-07-19T11:30:00.000Z",
        },
      ],
    });
    const accounting = consumeLoopSettlements(loop);
    expect(accounting.nextLastSettledIteration).toBe(1);
    expect(accounting.nextConsecutiveErrors).toBe(0);
    expect(accounting.nextUnsettled).toHaveLength(1);
  });

  it("reaches the three-error threshold exactly on the third contiguous error", () => {
    const loop = makeLoop({
      iteration: 3,
      consecutiveErrors: 0,
      lastSettledIteration: 0,
      unsettled: [1, 2, 3].map((iteration) => ({
        activationId: ACTIVATION_ID,
        iteration,
        outcome: "error" as const,
        turnId: `turn-${iteration}`,
        messageId: `message-${iteration}`,
        settledAt: "2026-07-19T11:30:00.000Z",
      })),
    });
    const accounting = consumeLoopSettlements(loop);
    expect(accounting.errorThresholdReached).toBe(true);
    expect(accounting.nextConsecutiveErrors).toBe(3);
    expect(accounting.nextLastSettledIteration).toBe(3);
  });

  it("resets the error streak on a completed outcome between errors", () => {
    const loop = makeLoop({
      iteration: 3,
      consecutiveErrors: 2,
      lastSettledIteration: 0,
      unsettled: [
        {
          activationId: ACTIVATION_ID,
          iteration: 1,
          outcome: "completed" as const,
          turnId: "turn-1",
          messageId: "message-1",
          settledAt: "2026-07-19T11:30:00.000Z",
        },
        {
          activationId: ACTIVATION_ID,
          iteration: 2,
          outcome: "error" as const,
          turnId: "turn-2",
          messageId: "message-2",
          settledAt: "2026-07-19T11:31:00.000Z",
        },
      ],
    });
    const accounting = consumeLoopSettlements(loop);
    expect(accounting.nextConsecutiveErrors).toBe(1);
    expect(accounting.nextLastSettledIteration).toBe(2);
  });

  it("advances past interrupted outcomes without touching the error streak", () => {
    const loop = makeLoop({
      iteration: 2,
      consecutiveErrors: 2,
      lastSettledIteration: 0,
      unsettled: [
        {
          activationId: ACTIVATION_ID,
          iteration: 1,
          outcome: "interrupted" as const,
          turnId: null,
          messageId: "message-1",
          settledAt: "2026-07-19T11:30:00.000Z",
        },
      ],
    });
    const accounting = consumeLoopSettlements(loop);
    expect(accounting.nextConsecutiveErrors).toBe(2);
    expect(accounting.nextLastSettledIteration).toBe(1);
    expect(accounting.nextUnsettled).toEqual([]);
  });
});
