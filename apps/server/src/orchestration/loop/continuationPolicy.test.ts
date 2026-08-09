import { LoopActivationId, type LoopUnsettledOutcome, type ThreadLoop } from "@synara/contracts";
import {
  LOOP_FIXTURE_ACTIVATION_ID,
  makeLoop as makeLoopFixture,
} from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { decideLoopContinuation, type LoopContinuationThreadView } from "./continuationPolicy";

const NOW = new Date("2026-07-19T12:00:00.000Z").getTime();
const ACTIVATION_ID = LOOP_FIXTURE_ACTIVATION_ID;

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return makeLoopFixture({
    prompt: "fix the tests",
    iteration: 0,
    maxIterations: null,
    createdAt: "2026-07-19T11:00:00.000Z",
    updatedAt: "2026-07-19T11:00:00.000Z",
    ...overrides,
  });
}

function makeThread(
  overrides: Partial<LoopContinuationThreadView> = {},
): LoopContinuationThreadView {
  return {
    deletedAt: null,
    archivedAt: null,
    parentThreadId: null,
    interactionMode: "default",
    sessionStatus: null,
    sessionActiveTurnId: null,
    latestTurnState: null,
    latestTurnPurpose: null,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    hasQueuedTurnStart: false,
    ...overrides,
  };
}

function settled(
  outcome: LoopUnsettledOutcome["outcome"],
  iteration: number,
  activationId: LoopActivationId = ACTIVATION_ID,
): LoopUnsettledOutcome {
  return {
    activationId,
    iteration,
    outcome,
    turnId: `turn-${iteration}`,
    messageId: `message-${iteration}`,
    settledAt: "2026-07-19T11:30:00.000Z",
  };
}

describe("decideLoopContinuation", () => {
  it("continues when prompt is present and thread is eligible", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 1,
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it.each<[string, Partial<ThreadLoop>, Partial<LoopContinuationThreadView>]>([
    ["the loop is inactive", { active: false }, {}],
    ["the prompt is missing", { prompt: "" }, {}],
    [
      "a turn is in flight",
      { iteration: 1 },
      {
        sessionActiveTurnId: "turn-1",
        latestTurnState: "running",
        latestTurnPurpose: { kind: "loop-iteration", activationId: ACTIVATION_ID, iteration: 1 },
      },
    ],
    [
      "the latest turn is still running without an active session turn",
      {},
      { latestTurnState: "running" },
    ],
    [
      "a stale-activation turn is still running",
      {},
      {
        latestTurnState: "running",
        latestTurnPurpose: {
          kind: "loop-iteration",
          activationId: LoopActivationId.makeUnsafe("stale-activation"),
          iteration: 1,
        },
      },
    ],
    ["a turn start is queued", {}, { hasQueuedTurnStart: true }],
    ["approval is pending", {}, { hasPendingApproval: true }],
    ["user input is pending", {}, { hasPendingUserInput: true }],
    ["plan mode is active", {}, { interactionMode: "plan" }],
    ["the session is starting", {}, { sessionStatus: "starting" }],
    ["the session is running", {}, { sessionStatus: "running" }],
    ["the session is stopping", {}, { sessionStatus: "stopping" }],
  ])("waits when %s", (_name, loopOverrides, threadOverrides) => {
    const result = decideLoopContinuation({
      loop: makeLoop(loopOverrides),
      nowMs: NOW,
      thread: makeThread(threadOverrides),
    });
    expect(result).toEqual({
      type: "wait",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it.each<[string, Partial<ThreadLoop>, Partial<LoopContinuationThreadView>, string]>([
    ["the thread is deleted", {}, { deletedAt: "2026-07-19T11:00:00.000Z" }, "thread_deleted"],
    ["the thread is archived", {}, { archivedAt: "2026-07-19T11:00:00.000Z" }, "thread_archived"],
    ["the thread is not top-level", {}, { parentThreadId: "thread-parent-1" }, "thread_unrunnable"],
    [
      "the duration budget has expired",
      { endsAt: "2026-07-19T11:59:59.000Z" },
      {},
      "budget_duration",
    ],
  ])("turns off when %s", (_name, loopOverrides, threadOverrides, reason) => {
    const result = decideLoopContinuation({
      loop: makeLoop(loopOverrides),
      nowMs: NOW,
      thread: makeThread(threadOverrides),
    });
    expect(result).toEqual({
      type: "off",
      reason,
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it("fails closed on a malformed endsAt", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ endsAt: "not-a-date" }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "budget_duration",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it("turns off on duration expiry even while blocked on approval or user input", () => {
    const expired = makeLoop({ endsAt: "2026-07-19T11:59:59.000Z" });
    for (const blocked of [
      makeThread({ hasPendingApproval: true }),
      makeThread({ hasPendingUserInput: true }),
    ]) {
      expect(decideLoopContinuation({ loop: expired, nowMs: NOW, thread: blocked })).toEqual({
        type: "off",
        reason: "budget_duration",
        nextConsecutiveErrors: 0,
        nextLastSettledIteration: 0,
        nextUnsettled: [],
      });
    }
  });

  it("turns off when the count budget is exhausted", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ maxIterations: 5, iteration: 5, lastSettledIteration: 5 }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "budget_iterations",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 5,
      nextUnsettled: [],
    });
  });

  it("accounts the final iteration before stopping at the count budget", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        maxIterations: 1,
        iteration: 1,
        lastSettledIteration: 0,
        unsettled: [settled("completed", 1)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "budget_iterations",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 1,
      nextUnsettled: [],
    });
  });

  it("accounts a settled iteration before stopping at duration expiry", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        endsAt: "2026-07-19T11:59:59.000Z",
        iteration: 1,
        lastSettledIteration: 0,
        unsettled: [settled("error", 1)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "budget_duration",
      nextConsecutiveErrors: 1,
      nextLastSettledIteration: 1,
      nextUnsettled: [],
    });
  });

  it("turns off when the hard cap is reached", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 100, lastSettledIteration: 100 }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "hard_cap",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 100,
      nextUnsettled: [],
    });
  });

  it("continues from a terminal error or stopped provider session", () => {
    for (const status of ["error", "stopped"] as const) {
      const result = decideLoopContinuation({
        loop: makeLoop(),
        nowMs: NOW,
        thread: makeThread({ sessionStatus: status }),
      });
      expect(result).toEqual({
        type: "continue",
        nextIteration: 1,
        nextConsecutiveErrors: 0,
        nextLastSettledIteration: 0,
        nextUnsettled: [],
      });
    }
  });

  it("continues after a completed loop-owned turn and resets the error counter", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 2,
        consecutiveErrors: 2,
        lastSettledIteration: 1,
        unsettled: [settled("completed", 2)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 3,
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 2,
      nextUnsettled: [],
    });
  });

  it.each([
    ["whitespace-only", "   ", 0],
    ["slash command", "/clear", 0],
    ["empty after the first iteration", "", 1],
  ] as const)("turns off for an invalid persisted %s prompt", (_name, prompt, iteration) => {
    const result = decideLoopContinuation({
      loop: makeLoop({ prompt, iteration }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "prompt_invalid",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it("waits for the first prompt when the persisted loop is exactly armed", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ prompt: "", iteration: 0 }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "wait",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it("continues with incremented errors after fewer than three consecutive loop-owned errors", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 2,
        consecutiveErrors: 1,
        lastSettledIteration: 1,
        unsettled: [settled("error", 2)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 3,
      nextConsecutiveErrors: 2,
      nextLastSettledIteration: 2,
      nextUnsettled: [],
    });
  });

  it("turns off after three consecutive loop-owned errors", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 3,
        consecutiveErrors: 2,
        lastSettledIteration: 2,
        unsettled: [settled("error", 3)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "consecutive_errors",
      nextConsecutiveErrors: 3,
      nextLastSettledIteration: 3,
      nextUnsettled: [],
    });
  });

  it("turns off exactly on the third error even when it settles across a replacement", () => {
    // Iterations 1..3 all errored; 2 and 3 arrive together (e.g. after a
    // restart or queue promotion). Accounting consumes them contiguously and
    // auto-off fires on the third, leaving no outcome skipped.
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 3,
        consecutiveErrors: 1,
        lastSettledIteration: 1,
        unsettled: [settled("error", 3), settled("error", 2)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "consecutive_errors",
      nextConsecutiveErrors: 3,
      nextLastSettledIteration: 3,
      nextUnsettled: [],
    });
  });

  it("buffers outcomes above a gap and never advances the watermark across it", () => {
    // Iteration 2's outcome is not yet observed: iteration 3's error stays
    // buffered and unaccounted until 2 settles.
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 3,
        consecutiveErrors: 1,
        lastSettledIteration: 1,
        unsettled: [settled("error", 3)],
      }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 4,
      nextConsecutiveErrors: 1,
      nextLastSettledIteration: 1,
      nextUnsettled: [settled("error", 3)],
    });
  });

  it("does not count errors for non-loop-owned turns", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 1, consecutiveErrors: 2 }),
      nowMs: NOW,
      thread: makeThread({ latestTurnState: "error", latestTurnPurpose: null }),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 2,
      nextConsecutiveErrors: 2,
      nextLastSettledIteration: 0,
      nextUnsettled: [],
    });
  });

  it("counts an unsettled older-iteration error exactly once while its replacement is queued (A errors while B is queued)", () => {
    // Replacement B (iteration 3) is queued when attempt A (iteration 2)
    // errors: A is accounted from the durable ledger and the queued B makes
    // the decision a wait — no extra iteration C is created.
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 3,
        consecutiveErrors: 1,
        lastSettledIteration: 1,
        unsettled: [settled("error", 2)],
      }),
      nowMs: NOW,
      thread: makeThread({ hasQueuedTurnStart: true }),
    });
    expect(result).toEqual({
      type: "wait",
      nextConsecutiveErrors: 2,
      nextLastSettledIteration: 2,
      nextUnsettled: [],
    });
  });

  it("resets errors when an unsettled older iteration completed while the next was queued", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 2,
        consecutiveErrors: 2,
        lastSettledIteration: 0,
        unsettled: [settled("completed", 1)],
      }),
      nowMs: NOW,
      thread: makeThread({ hasQueuedTurnStart: true }),
    });
    expect(result).toEqual({
      type: "wait",
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 1,
      nextUnsettled: [],
    });
  });

  it("does not auto-count an interrupted loop-owned turn as an error", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 1, unsettled: [settled("interrupted", 1)] }),
      nowMs: NOW,
      thread: makeThread(),
    });
    // User-stop interrupts turn the loop off in the decider; a surviving
    // interrupted turn (e.g. restart reconciliation) neither counts as an
    // error nor resets the counter.
    expect(result).toEqual({
      type: "continue",
      nextIteration: 2,
      nextConsecutiveErrors: 0,
      nextLastSettledIteration: 1,
      nextUnsettled: [],
    });
  });

  it("persists error accounting on a wait so a queued replacement cannot erase it", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({
        iteration: 2,
        consecutiveErrors: 1,
        lastSettledIteration: 0,
        unsettled: [settled("error", 1)],
      }),
      nowMs: NOW,
      thread: makeThread({ hasQueuedTurnStart: true }),
    });
    expect(result).toEqual({
      type: "wait",
      nextConsecutiveErrors: 2,
      nextLastSettledIteration: 1,
      nextUnsettled: [],
    });
  });
});
