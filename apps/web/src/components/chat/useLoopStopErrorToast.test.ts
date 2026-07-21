// FILE: useLoopStopErrorToast.test.ts
// Purpose: Guards the exceptional-stop toast policy (spec §14) — errors toast, routine stops don't.
// Layer: Pure logic tests

import type { ThreadLoop } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { getLoopStopErrorToastCopy, shouldToastLoopStop } from "./useLoopStopErrorToast";

function makeLoop(overrides: Partial<ThreadLoop>): ThreadLoop {
  return {
    activationId: "act-1",
    active: false,
    prompt: "fix the tests",
    iteration: 3,
    maxIterations: 5,
    endsAt: null,
    hardCap: 100,
    consecutiveErrors: 0,
    lastStopReason: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:10:00.000Z",
    ...overrides,
  } as ThreadLoop;
}

describe("getLoopStopErrorToastCopy", () => {
  it("returns copy only for exceptional stop reasons", () => {
    expect(getLoopStopErrorToastCopy("consecutive_errors")).toEqual({
      title: "Loop stopped after repeated errors",
      description: "Review the latest error before restarting.",
    });
    expect(getLoopStopErrorToastCopy("prompt_invalid")).not.toBeNull();
    expect(getLoopStopErrorToastCopy("thread_unrunnable")).not.toBeNull();
  });

  it("stays quiet for routine lifecycle stops", () => {
    expect(getLoopStopErrorToastCopy("budget_iterations")).toBeNull();
    expect(getLoopStopErrorToastCopy("budget_duration")).toBeNull();
    expect(getLoopStopErrorToastCopy("user_stop")).toBeNull();
    expect(getLoopStopErrorToastCopy("toggled_off")).toBeNull();
    expect(getLoopStopErrorToastCopy("hard_cap")).toBeNull();
  });
});

describe("shouldToastLoopStop", () => {
  const stopped = makeLoop({ active: false, lastStopReason: "consecutive_errors" });

  it("toasts only on an observed active-to-stopped transition", () => {
    expect(shouldToastLoopStop({ activationId: "act-1", active: true }, stopped)).toBe(true);
  });

  it("does not toast for a loop already stopped on mount", () => {
    expect(shouldToastLoopStop(null, stopped)).toBe(false);
  });

  it("does not toast across different activations", () => {
    expect(shouldToastLoopStop({ activationId: "act-0", active: true }, stopped)).toBe(false);
  });

  it("does not toast while the loop is still active or has no reason", () => {
    expect(
      shouldToastLoopStop(
        { activationId: "act-1", active: true },
        makeLoop({ active: true, lastStopReason: null }),
      ),
    ).toBe(false);
    expect(
      shouldToastLoopStop(
        { activationId: "act-1", active: true },
        makeLoop({ active: false, lastStopReason: null }),
      ),
    ).toBe(false);
    expect(shouldToastLoopStop({ activationId: "act-1", active: true }, null)).toBe(false);
  });
});
