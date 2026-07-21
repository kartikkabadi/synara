import type { ThreadLoop } from "@synara/contracts";
import {
  LOOP_FIXTURE_ACTIVATION_ID,
  makeLoop as makeLoopFixture,
} from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { decideLoopContinuation, type LoopContinuationThreadView } from "./loopDecision";

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

function loopOwnedTerminal(
  state: "completed" | "error" | "interrupted",
  iteration: number,
  activationId: LoopActivationId = ACTIVATION_ID,
): Partial<LoopContinuationThreadView> {
  return {
    latestTurnState: state,
    latestTurnPurpose: { kind: "loop-iteration", activationId, iteration },
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
    });
  });

  it.each<[string, Partial<ThreadLoop>, Partial<LoopContinuationThreadView>, string]>([
    ["the loop is inactive", { active: false }, {}, "loop_inactive"],
    ["the prompt is missing", { prompt: "" }, {}, "missing_prompt"],
    [
      "a turn is in flight",
      { iteration: 1 },
      {
        sessionActiveTurnId: "turn-1",
        latestTurnState: "running",
        latestTurnPurpose: { kind: "loop-iteration", activationId: ACTIVATION_ID, iteration: 1 },
      },
      "turn_in_flight",
    ],
    [
      "the latest turn is still running without an active session turn",
      {},
      { latestTurnState: "running" },
      "turn_in_flight",
    ],
    [
      "a stale-activation turn is still running",
      {},
      {
        latestTurnState: "running",
        latestTurnPurpose: {
          kind: "loop-iteration",
          activationId: "stale-activation",
          iteration: 1,
        },
      },
      "turn_in_flight",
    ],
    ["a turn start is queued", {}, { hasQueuedTurnStart: true }, "turn_start_pending"],
    ["approval is pending", {}, { hasPendingApproval: true }, "approval_pending"],
    ["user input is pending", {}, { hasPendingUserInput: true }, "user_input_pending"],
    ["plan mode is active", {}, { interactionMode: "plan" }, "plan_mode"],
    ["the session is starting", {}, { sessionStatus: "starting" }, "session_unavailable"],
    ["the session is running", {}, { sessionStatus: "running" }, "session_unavailable"],
    ["the session is stopping", {}, { sessionStatus: "stopping" }, "session_unavailable"],
  ])("waits when %s", (_name, loopOverrides, threadOverrides, why) => {
    const result = decideLoopContinuation({
      loop: makeLoop(loopOverrides),
      nowMs: NOW,
      thread: makeThread(threadOverrides),
    });
    expect(result).toEqual({ type: "wait", why, nextConsecutiveErrors: 0 });
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
    expect(result).toEqual({ type: "off", reason, nextConsecutiveErrors: 0 });
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
      });
    }
  });

  it("turns off when the count budget is exhausted", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ maxIterations: 5, iteration: 5 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("completed", 5)),
    });
    expect(result).toEqual({
      type: "off",
      reason: "budget_iterations",
      nextConsecutiveErrors: 0,
    });
  });

  it("turns off when the hard cap is reached", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 100 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("completed", 100)),
    });
    expect(result).toEqual({
      type: "off",
      reason: "hard_cap",
      nextConsecutiveErrors: 0,
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
      });
    }
  });

  it("continues after a completed loop-owned turn and resets the error counter", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 2, consecutiveErrors: 2 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("completed", 2)),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 3,
      nextConsecutiveErrors: 0,
    });
  });

  it("continues with incremented errors after fewer than three consecutive loop-owned errors", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 2, consecutiveErrors: 1 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("error", 2)),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 3,
      nextConsecutiveErrors: 2,
    });
  });

  it("turns off after three consecutive loop-owned errors", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 3, consecutiveErrors: 2 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("error", 3)),
    });
    expect(result).toEqual({
      type: "off",
      reason: "consecutive_errors",
      nextConsecutiveErrors: 3,
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
    });
  });

  it("does not reset errors for a non-loop-owned completed turn", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 2, consecutiveErrors: 1 }),
      nowMs: NOW,
      thread: makeThread({ latestTurnState: "completed", latestTurnPurpose: null }),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 3,
      nextConsecutiveErrors: 1,
    });
  });

  it("ignores stale-activation loop-owned terminal turns", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 0, consecutiveErrors: 2 }),
      nowMs: NOW,
      thread: makeThread(
        loopOwnedTerminal("error", 1, LoopActivationId.makeUnsafe("stale-activation")),
      ),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 1,
      nextConsecutiveErrors: 2,
    });
  });

  it("ignores loop-owned terminal turns from an older iteration", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 3, consecutiveErrors: 1 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("error", 2)),
    });
    expect(result).toEqual({
      type: "continue",
      nextIteration: 4,
      nextConsecutiveErrors: 1,
    });
  });

  it("does not auto-count an interrupted loop-owned turn as an error", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 1 }),
      nowMs: NOW,
      thread: makeThread(loopOwnedTerminal("interrupted", 1)),
    });
    // User-stop interrupts turn the loop off in the decider; a surviving
    // interrupted turn (e.g. restart reconciliation) neither counts as an
    // error nor resets the counter.
    expect(result).toEqual({
      type: "continue",
      nextIteration: 2,
      nextConsecutiveErrors: 0,
    });
  });

  it("carries derived error accounting into a blocked wait without persisting it", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 1, consecutiveErrors: 1 }),
      nowMs: NOW,
      thread: makeThread({
        ...loopOwnedTerminal("error", 1),
        hasQueuedTurnStart: true,
      }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "turn_start_pending",
      nextConsecutiveErrors: 2,
    });
  });
});
