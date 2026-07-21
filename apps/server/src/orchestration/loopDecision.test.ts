import { LoopActivationId, type ThreadLoop } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { decideLoopContinuation, type LoopContinuationThreadView } from "./loopDecision";

const NOW = new Date("2026-07-19T12:00:00.000Z").getTime();
const ACTIVATION_ID = LoopActivationId.makeUnsafe("test-activation");

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return {
    active: true,
    prompt: "fix the tests",
    iteration: 0,
    maxIterations: null,
    endsAt: null,
    hardCap: 100,
    consecutiveErrors: 0,
    lastStopReason: null,
    activationId: ACTIVATION_ID,
    createdAt: "2026-07-19T11:00:00.000Z",
    updatedAt: "2026-07-19T11:00:00.000Z",
    ...overrides,
  };
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

  it("waits when the loop is inactive", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ active: false }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "wait",
      why: "loop_inactive",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits when the prompt is missing", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ prompt: "" }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "wait",
      why: "missing_prompt",
      nextConsecutiveErrors: 0,
    });
  });

  it("turns off when the thread is deleted", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ deletedAt: "2026-07-19T11:00:00.000Z" }),
    });
    expect(result).toEqual({
      type: "off",
      reason: "thread_deleted",
      nextConsecutiveErrors: 0,
    });
  });

  it("turns off when the thread is archived", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ archivedAt: "2026-07-19T11:00:00.000Z" }),
    });
    expect(result).toEqual({
      type: "off",
      reason: "thread_archived",
      nextConsecutiveErrors: 0,
    });
  });

  it("turns off when the thread is not top-level", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ parentThreadId: "thread-parent-1" }),
    });
    expect(result).toEqual({
      type: "off",
      reason: "thread_unrunnable",
      nextConsecutiveErrors: 0,
    });
  });

  it("turns off when the duration budget has expired", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ endsAt: "2026-07-19T11:59:59.000Z" }),
      nowMs: NOW,
      thread: makeThread(),
    });
    expect(result).toEqual({
      type: "off",
      reason: "budget_duration",
      nextConsecutiveErrors: 0,
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

  it("waits when a turn is in flight", () => {
    const result = decideLoopContinuation({
      loop: makeLoop({ iteration: 1 }),
      nowMs: NOW,
      thread: makeThread({
        sessionActiveTurnId: "turn-1",
        latestTurnState: "running",
        latestTurnPurpose: { kind: "loop-iteration", activationId: ACTIVATION_ID, iteration: 1 },
      }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "turn_in_flight",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits when the latest turn is still running without an active session turn", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ latestTurnState: "running" }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "turn_in_flight",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits when a turn start is queued", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ hasQueuedTurnStart: true }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "turn_start_pending",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits when approval is pending", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ hasPendingApproval: true }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "approval_pending",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits when user input is pending", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ hasPendingUserInput: true }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "user_input_pending",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits in plan mode", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({ interactionMode: "plan" }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "plan_mode",
      nextConsecutiveErrors: 0,
    });
  });

  it("waits when the session is starting, running, or stopping", () => {
    for (const status of ["starting", "running", "stopping"] as const) {
      const result = decideLoopContinuation({
        loop: makeLoop(),
        nowMs: NOW,
        thread: makeThread({ sessionStatus: status }),
      });
      expect(result).toEqual({
        type: "wait",
        why: "session_unavailable",
        nextConsecutiveErrors: 0,
      });
    }
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

  it("blocks on a stale-activation running turn", () => {
    const result = decideLoopContinuation({
      loop: makeLoop(),
      nowMs: NOW,
      thread: makeThread({
        latestTurnState: "running",
        latestTurnPurpose: {
          kind: "loop-iteration",
          activationId: LoopActivationId.makeUnsafe("stale-activation"),
          iteration: 1,
        },
      }),
    });
    expect(result).toEqual({
      type: "wait",
      why: "turn_in_flight",
      nextConsecutiveErrors: 0,
    });
  });
});
