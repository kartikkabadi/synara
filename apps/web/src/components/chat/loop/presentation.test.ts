import { describe, expect, it } from "vitest";

import { LoopActivationId, type LoopStopReason, type ThreadLoop } from "@synara/contracts";
import { makeLoop, makeRunningLoopTurn } from "@synara/shared/loopTestFixtures";

import {
  type DeriveLoopPresentationStateInput,
  deriveLoopPresentationState,
  deriveLoopProgress,
  formatDuration,
  formatDurationBudget,
  formatLoopRemainingTime,
  formatLoopStopReason,
  formatLoopStopReasonShort,
  getLoopTickIntervalMs,
  isAnyLoopOwnedTurnRunning,
} from "./presentation";

const NOW = new Date("2026-01-01T12:00:00.000Z").getTime();

function derive(
  overrides: Partial<DeriveLoopPresentationStateInput> = {},
): ReturnType<typeof deriveLoopPresentationState> {
  return deriveLoopPresentationState({
    loop: makeLoop(),
    latestTurn: null,
    interactionMode: "default",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    now: NOW,
    ...overrides,
  });
}

describe("deriveLoopPresentationState", () => {
  it("returns null when there is no loop", () => {
    expect(derive({ loop: null })).toBeNull();
  });

  it("returns null for an inactive loop without a stop reason", () => {
    expect(derive({ loop: makeLoop({ active: false, lastStopReason: null }) })).toBeNull();
  });

  it("returns armed for an active loop with an empty prompt", () => {
    const presentation = derive({ loop: makeLoop({ prompt: "" }) });
    expect(presentation?.state).toEqual({ kind: "armed" });
    expect(presentation?.label).toBe("Loop ready");
    expect(presentation?.detail).toBe("Add a prompt to start");
    expect(presentation?.color).toBe("neutral");
    expect(presentation?.progress).toBeNull();
  });

  it("returns starting for an active loop before the first iteration", () => {
    const presentation = derive({ loop: makeLoop({ iteration: 0 }) });
    expect(presentation?.state).toEqual({ kind: "starting" });
    expect(presentation?.label).toBe("Starting loop");
    expect(presentation?.detail).toBeNull();
  });

  it("returns running when the latest turn matches the current activation", () => {
    const presentation = derive({ latestTurn: makeRunningLoopTurn() });
    expect(presentation?.state).toEqual({ kind: "running", iteration: 2 });
    expect(presentation?.label).toBe("Loop running");
    expect(presentation?.detail).toBe("2/5");
    expect(presentation?.color).toBe("running");
  });

  it("ignores an unrelated running turn without a loop purpose", () => {
    const latestTurn = makeRunningLoopTurn({ purpose: undefined });
    const presentation = derive({ latestTurn });
    expect(presentation?.state).toEqual({ kind: "ready" });
    expect(presentation?.label).toBe("Loop on");
    expect(presentation?.detail).toBe("Starting the next turn…");
  });

  it("ignores a running turn from a stale activation", () => {
    const latestTurn = makeRunningLoopTurn({
      purpose: {
        kind: "loop-iteration",
        activationId: LoopActivationId.makeUnsafe("activation-stale"),
        iteration: 7,
      },
    });
    const presentation = derive({ latestTurn });
    expect(presentation?.state).toEqual({ kind: "ready" });
  });

  it("returns waiting-approval when approvals are pending", () => {
    const presentation = derive({
      latestTurn: makeRunningLoopTurn(),
      hasPendingApprovals: true,
    });
    expect(presentation?.state).toEqual({ kind: "waiting-approval" });
    expect(presentation?.label).toBe("Loop waiting");
    expect(presentation?.detail).toBe("Approval required");
    expect(presentation?.color).toBe("waiting");
  });

  it("returns waiting-input when user input is pending", () => {
    const presentation = derive({ hasPendingUserInput: true });
    expect(presentation?.state).toEqual({ kind: "waiting-input" });
    expect(presentation?.detail).toBe("Your input is required");
    expect(presentation?.color).toBe("waiting");
  });

  it("returns waiting-plan when plan mode is active", () => {
    const presentation = derive({ interactionMode: "plan" });
    expect(presentation?.state).toEqual({ kind: "waiting-plan" });
    expect(presentation?.label).toBe("Loop waiting");
    expect(presentation?.detail).toBe("Plan mode is active");
    expect(presentation?.color).toBe("waiting");
    expect(presentation?.progress).toBeNull();
  });

  it("returns ending while a matching turn outlives a toggled-off loop", () => {
    const presentation = derive({
      loop: makeLoop({ active: false, lastStopReason: "toggled_off" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(presentation?.state).toEqual({ kind: "ending" });
    expect(presentation?.label).toBe("Loop ending");
    expect(presentation?.detail).toBe("Current turn will finish");
  });

  it("calls out a duration expiry while the current turn finishes", () => {
    const presentation = derive({
      loop: makeLoop({ active: false, lastStopReason: "budget_duration" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(presentation?.state).toEqual({ kind: "ending" });
    expect(presentation?.detail).toBe("Time budget reached · current turn finishing");
  });

  it("returns stopping while a matching turn outlives a user stop", () => {
    const presentation = derive({
      loop: makeLoop({ active: false, lastStopReason: "user_stop" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(presentation?.state).toEqual({ kind: "stopping" });
    expect(presentation?.label).toBe("Stopping loop");
    expect(presentation?.detail).toBeNull();
  });

  it("returns ended once no matching turn is running", () => {
    const presentation = derive({
      loop: makeLoop({ active: false, iteration: 5, lastStopReason: "budget_iterations" }),
    });
    expect(presentation?.state).toEqual({ kind: "ended", reason: "budget_iterations" });
    expect(presentation?.label).toBe("Loop completed");
    expect(presentation?.detail).toBe("5 of 5 turns · Budget reached");
    expect(presentation?.color).toBe("neutral");
    expect(presentation?.progress).toBeNull();
  });

  it("uses the error tone for error-class stop reasons", () => {
    const presentation = derive({
      loop: makeLoop({ active: false, lastStopReason: "consecutive_errors" }),
    });
    expect(presentation?.color).toBe("error");
  });
});

describe("isAnyLoopOwnedTurnRunning", () => {
  it("treats a running loop-owned turn from a stale activation as loop-owned", () => {
    // Edit Loop mints a fresh activation while the previous attempt is still
    // running: Stop now must still interrupt that concrete turn.
    const latestTurn = makeRunningLoopTurn({
      purpose: {
        kind: "loop-iteration",
        activationId: LoopActivationId.makeUnsafe("activation-stale"),
        iteration: 7,
      },
    });
    expect(isAnyLoopOwnedTurnRunning(latestTurn)).toBe(true);
  });

  it("ignores running turns without a loop purpose and non-running turns", () => {
    expect(isAnyLoopOwnedTurnRunning(makeRunningLoopTurn({ purpose: undefined }))).toBe(false);
    expect(isAnyLoopOwnedTurnRunning(null)).toBe(false);
  });
});

describe("deriveLoopProgress", () => {
  it("renders one segment per turn for small count budgets", () => {
    const progress = deriveLoopProgress(makeLoop({ iteration: 2, maxIterations: 5 }), NOW);
    expect(progress.kind).toBe("count");
    expect(progress.segments).toEqual([1, 1, 0, 0, 0]);
    expect(progress.counterText).toBe("2/5");
    expect(progress.ariaValueMin).toBe(0);
    expect(progress.ariaValueMax).toBe(5);
    expect(progress.ariaValueNow).toBe(2);
    expect(progress.ariaValueText).toBe("Turn 2 of 5");
    expect(progress.tickIntervalMs).toBeNull();
  });

  it("renders one exact segment per turn up to the twelve-segment visual cap", () => {
    const progress = deriveLoopProgress(makeLoop({ iteration: 3, maxIterations: 10 }), NOW);
    expect(progress.segments).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(progress.counterText).toBe("3/10");
    expect(progress.ariaValueText).toBe("Turn 3 of 10");
  });

  it("spreads large count budgets proportionally across twelve segments", () => {
    // 17/50 = 34%: four full segments plus a fractional boundary segment.
    const progress = deriveLoopProgress(makeLoop({ iteration: 17, maxIterations: 50 }), NOW);
    expect(progress.segments).toHaveLength(12);
    expect(progress.segments.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(progress.segments[4]).toBeCloseTo(0.08, 5);
    expect(progress.segments.slice(5)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(progress.counterText).toBe("17/50");
    expect(progress.ariaValueText).toBe("Turn 17 of 50");
  });

  it("only fills every segment once a count budget completes", () => {
    const partial = deriveLoopProgress(makeLoop({ iteration: 49, maxIterations: 50 }), NOW);
    expect(partial.segments.some((fill) => fill < 1)).toBe(true);
    const complete = deriveLoopProgress(makeLoop({ iteration: 50, maxIterations: 50 }), NOW);
    expect(complete.segments).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("derives duration progress from elapsed time", () => {
    // 30-minute budget with 18 minutes left on the clock.
    const loop = makeLoop({
      maxIterations: null,
      durationSeconds: 30 * 60,
      endsAt: new Date(NOW + 18 * 60_000).toISOString(),
    });
    const progress = deriveLoopProgress(loop, NOW);
    expect(progress.kind).toBe("duration");
    // 40% elapsed across twelve segments: 4.8 filled.
    expect(progress.segments).toHaveLength(12);
    expect(progress.segments.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(progress.segments[4]).toBeCloseTo(0.8, 5);
    expect(progress.segments.slice(5)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(progress.counterText).toBe("18m left");
    expect(progress.tooltipText).toBe("12 minutes elapsed of 30 minutes");
    expect(progress.ariaValueText).toBe("18 minutes remaining");
    expect(progress.ariaValueNow).toBe(40);
    expect(progress.tickIntervalMs).toBe(30_000);
  });

  it("shows no strip and the safety limit for no-budget loops", () => {
    const progress = deriveLoopProgress(
      makeLoop({ maxIterations: null, endsAt: null, durationSeconds: null }),
      NOW,
    );
    expect(progress.kind).toBe("none");
    expect(progress.segments).toEqual([]);
    expect(progress.counterText).toBe("2 turns");
    expect(progress.detailText).toBe("Safety limit 100");
    expect(progress.ariaValueText).toBe("Loop has run 2 turns; no explicit user budget");
    expect(progress.ariaValueMax).toBeNull();
  });
});

describe("formatLoopStopReason", () => {
  const cases: ReadonlyArray<
    [LoopStopReason, Partial<ThreadLoop>, number, string, string, string | null]
  > = [
    ["user_stop", {}, 5, "Loop stopped", "5 turns", "Stopped by you"],
    ["toggled_off", {}, 5, "Loop stopped", "5 turns", "Future iterations disabled"],
    ["prompt_invalid", {}, 5, "Loop stopped", "The saved objective was invalid", null],
    [
      "attachments_not_supported",
      {},
      5,
      "Loop stopped",
      "Attachments aren't supported in loops",
      "Your message ran as a normal turn instead",
    ],
    [
      "replaced_by_manual_policy",
      {},
      5,
      "Loop stopped",
      "5 turns",
      "Your message ran as a normal turn instead",
    ],
    ["thread_archived", {}, 5, "Loop stopped", "This thread was archived", null],
    ["thread_deleted", {}, 5, "Loop stopped", "This thread was deleted", null],
    ["thread_unrunnable", {}, 5, "Loop stopped", "This thread is not available", null],
    [
      "budget_iterations",
      { maxIterations: 5 },
      5,
      "Loop completed",
      "5 of 5 turns",
      "Budget reached",
    ],
    [
      "budget_duration",
      {
        maxIterations: null,
        durationSeconds: 30 * 60,
        endsAt: new Date(NOW).toISOString(),
      },
      4,
      "Loop completed",
      "Ran until the time budget ended",
      "30-minute budget reached",
    ],
    [
      "budget_duration",
      {
        maxIterations: null,
        durationSeconds: 60 * 60,
        endsAt: new Date(NOW).toISOString(),
      },
      4,
      "Loop completed",
      "Ran until the time budget ended",
      "1-hour budget reached",
    ],
    [
      "budget_duration",
      {
        maxIterations: null,
        durationSeconds: 10,
        endsAt: new Date(NOW).toISOString(),
      },
      2,
      "Loop completed",
      "Ran until the time budget ended",
      "10-second budget reached",
    ],
    ["hard_cap", { hardCap: 100 }, 100, "Loop stopped", "100 turns", "Safety limit reached"],
    [
      "consecutive_errors",
      { consecutiveErrors: 3 },
      7,
      "Loop stopped",
      "3 consecutive errors",
      "Review the latest error before restarting",
    ],
  ];

  it.each(cases)("maps %s", (reason, overrides, turns, title, summary, reasonLine) => {
    expect(formatLoopStopReason(reason, makeLoop(overrides), turns)).toEqual({
      title,
      summary,
      reason: reasonLine,
    });
  });

  it("pluralizes single-turn summaries", () => {
    expect(formatLoopStopReason("user_stop", makeLoop(), 1).summary).toBe("1 turn");
  });
});

describe("adaptive time formatting", () => {
  it("formats remaining time across ranges", () => {
    expect(formatLoopRemainingTime(0)).toBe("Time budget reached");
    expect(formatLoopRemainingTime(42)).toBe("42s left");
    expect(formatLoopRemainingTime(18 * 60)).toBe("18m left");
    expect(formatLoopRemainingTime(60 * 60)).toBe("1h left");
    expect(formatLoopRemainingTime(80 * 60)).toBe("1h 20m left");
  });

  it("uses an adaptive tick interval", () => {
    expect(getLoopTickIntervalMs(20 * 60)).toBe(30_000);
    expect(getLoopTickIntervalMs(4 * 60)).toBe(10_000);
    expect(getLoopTickIntervalMs(45)).toBe(1_000);
  });
});

describe("formatDuration", () => {
  it("formats duration budgets for humans", () => {
    expect(formatDuration(10)).toBe("10 seconds");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(30 * 60)).toBe("30 minutes");
    expect(formatDuration(60 * 60)).toBe("1 hour");
    expect(formatDuration(80 * 60)).toBe("1h 20m");
    expect(formatDuration(null)).toBe("0 seconds");
  });
});

describe("formatDurationBudget", () => {
  it("formats duration budget stop reasons", () => {
    expect(formatDurationBudget(10)).toBe("10-second budget reached");
    expect(formatDurationBudget(60)).toBe("1-minute budget reached");
    expect(formatDurationBudget(30 * 60)).toBe("30-minute budget reached");
    expect(formatDurationBudget(60 * 60)).toBe("1-hour budget reached");
    expect(formatDurationBudget(80 * 60)).toBe("1h 20m budget reached");
    expect(formatDurationBudget(null)).toBe("Time budget reached");
  });
});

describe("formatLoopStopReasonShort", () => {
  it("provides context-free copy for exceptional stops only", () => {
    expect(formatLoopStopReasonShort("consecutive_errors")).toEqual({
      title: "Loop stopped after repeated errors",
      description: "Review the latest error before restarting.",
      tone: "error",
    });
    expect(formatLoopStopReasonShort("prompt_invalid")).toEqual({
      title: "Loop stopped",
      description: "The saved objective was invalid.",
      tone: "error",
    });
    expect(formatLoopStopReasonShort("thread_unrunnable")).toEqual({
      title: "Loop stopped",
      description: "This thread is not available.",
      tone: "error",
    });
    expect(formatLoopStopReasonShort("user_stop")).toBeNull();
    expect(formatLoopStopReasonShort("budget_iterations")).toBeNull();
  });

  it("toasts replaced-by-manual stops with a warning tone", () => {
    const expected = {
      title: "Loop stopped",
      description: "Your message was sent as a normal message.",
      tone: "warning",
    };
    expect(formatLoopStopReasonShort("attachments_not_supported")).toEqual(expected);
    expect(formatLoopStopReasonShort("replaced_by_manual_policy")).toEqual(expected);
  });
});
