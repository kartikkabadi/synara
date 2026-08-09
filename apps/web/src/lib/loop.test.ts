import { describe, expect, it } from "vitest";

import { type ThreadLoop } from "@synara/contracts";
import { makeLoop } from "@synara/shared/loopTestFixtures";

import {
  LOOP_BUDGET_COUNT_ERROR,
  LOOP_BUDGET_DURATION_MAX_ERROR,
  LOOP_BUDGET_DURATION_MIN_ERROR,
  LOOP_BUDGET_INVALID_ERROR,
  LOOP_CHOOSE_BUDGET_NOTE,
  LOOP_DEFAULT_BUDGET_CHOICE,
  LOOP_UNSUPPORTED_CONTEXT_MESSAGE,
  formatLoopBudgetChoiceLabel,
  interpretLoopInvocation,
  isUnsupportedLoopContext,
  loopBudgetChoiceFromLoop,
  loopBudgetChoiceFromParsed,
  loopBudgetChoiceToDispatchFields,
  loopSetupNoticeFor,
  validateLoopBudgetChoice,
  validateLoopObjective,
} from "./loop";

describe("interpretLoopInvocation", () => {
  it.each([
    [
      "inactive bare /loop opens setup with the 5-turn default",
      "/loop",
      { kind: "open-setup", budget: { kind: "count", turns: 5 }, objective: "", note: null },
    ],
    [
      "/loop 10 opens setup with a 10-turn budget",
      "/loop 10",
      { kind: "open-setup", budget: { kind: "count", turns: 10 }, objective: "", note: null },
    ],
    [
      "/loop 30m opens setup with a 30-minute budget",
      "/loop 30m",
      {
        kind: "open-setup",
        budget: { kind: "duration", seconds: 30 * 60 },
        objective: "",
        note: null,
      },
    ],
    [
      "missing budget prefills the objective with a choose-budget note",
      "/loop fix the tests",
      {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: "fix the tests",
        note: "choose-budget",
      },
    ],
    [
      "valid budget plus prompt starts immediately",
      "/loop 5 fix the tests",
      { kind: "start-direct", budget: { kind: "count", value: 5 }, prompt: "fix the tests" },
    ],
    [
      "malformed count drops the token and opens setup with validation",
      "/loop 0",
      {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: "",
        note: "invalid-budget",
      },
    ],
    [
      "over-cap count drops the token and opens setup with validation",
      "/loop 200 fix the tests",
      {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: "fix the tests",
        note: "invalid-budget",
      },
    ],
    [
      "over-cap duration drops the token and opens setup with validation",
      "/loop 25h ship it",
      {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: "ship it",
        note: "invalid-budget",
      },
    ],
  ])("%s", (_name, input, expected) => {
    expect(interpretLoopInvocation(input, { loopActive: false })).toEqual(expected);
  });

  it("toggles off for active bare /loop", () => {
    expect(interpretLoopInvocation("/loop", { loopActive: true })).toEqual({
      kind: "toggle-off",
    });
  });

  it("rejects a prompt starting with a slash", () => {
    const result = interpretLoopInvocation("/loop 5 /clear", {
      loopActive: false,
    });
    expect(result).toEqual({
      kind: "reject",
      reason: "prompt_starts_with_slash",
    });
  });

  it("returns not-loop for other commands", () => {
    expect(interpretLoopInvocation("/status", { loopActive: false })).toEqual({
      kind: "not-loop",
    });
  });
});

describe("budget choices", () => {
  it("maps parsed budgets to choices", () => {
    expect(loopBudgetChoiceFromParsed(null)).toEqual(LOOP_DEFAULT_BUDGET_CHOICE);
    expect(loopBudgetChoiceFromParsed({ kind: "count", value: 25 })).toEqual({
      kind: "count",
      turns: 25,
    });
    expect(loopBudgetChoiceFromParsed({ kind: "duration", seconds: 3600 })).toEqual({
      kind: "duration",
      seconds: 3600,
    });
  });

  it("prefills the edit budget from the active loop", () => {
    expect(loopBudgetChoiceFromLoop(makeLoop({ maxIterations: 10 }))).toEqual({
      kind: "count",
      turns: 10,
    });
    expect(
      loopBudgetChoiceFromLoop(makeLoop({ maxIterations: null, durationSeconds: 30 * 60 })),
    ).toEqual({ kind: "duration", seconds: 30 * 60 });
    expect(
      loopBudgetChoiceFromLoop(makeLoop({ maxIterations: null, durationSeconds: 7 })),
    ).toEqual({ kind: "duration", seconds: 7 });
    expect(
      loopBudgetChoiceFromLoop(makeLoop({ maxIterations: null, durationSeconds: null })),
    ).toEqual({
      kind: "until-stopped",
    });
  });

  it.each([
    [{ kind: "count", turns: 1 } as const, null],
    [{ kind: "count", turns: 100 } as const, null],
    [{ kind: "count", turns: 0 } as const, LOOP_BUDGET_COUNT_ERROR],
    [{ kind: "count", turns: 101 } as const, LOOP_BUDGET_COUNT_ERROR],
    [{ kind: "duration", seconds: 1 } as const, null],
    [{ kind: "duration", seconds: 60 } as const, null],
    [{ kind: "duration", seconds: 0 } as const, LOOP_BUDGET_DURATION_MIN_ERROR],
    [{ kind: "duration", seconds: 24 * 3600 } as const, null],
    [{ kind: "duration", seconds: 24 * 3600 + 1 } as const, LOOP_BUDGET_DURATION_MAX_ERROR],
    [{ kind: "until-stopped" } as const, null],
  ])("validates budget choice %j", (choice, expected) => {
    expect(validateLoopBudgetChoice(choice)).toBe(expected);
  });

  it("maps open-setup notes to their header hint/error copy", () => {
    expect(loopSetupNoticeFor("choose-budget")).toEqual({
      note: LOOP_CHOOSE_BUDGET_NOTE,
      error: null,
    });
    expect(loopSetupNoticeFor("invalid-budget")).toEqual({
      note: null,
      error: LOOP_BUDGET_INVALID_ERROR,
    });
    expect(loopSetupNoticeFor("unsupported-context")).toEqual({
      note: null,
      error: LOOP_UNSUPPORTED_CONTEXT_MESSAGE,
    });
    expect(loopSetupNoticeFor(null)).toEqual({ note: null, error: null });
  });

  it("formats trigger labels", () => {
    expect(formatLoopBudgetChoiceLabel({ kind: "count", turns: 5 })).toBe("Stop after 5 turns");
    expect(formatLoopBudgetChoiceLabel({ kind: "duration", seconds: 1 })).toBe(
      "Stop after 1 second",
    );
    expect(formatLoopBudgetChoiceLabel({ kind: "duration", seconds: 59 })).toBe(
      "Stop after 59 seconds",
    );
    expect(formatLoopBudgetChoiceLabel({ kind: "duration", seconds: 30 * 60 })).toBe(
      "Stop after 30 minutes",
    );
    expect(formatLoopBudgetChoiceLabel({ kind: "duration", seconds: 3600 })).toBe(
      "Stop after 1 hour",
    );
    expect(formatLoopBudgetChoiceLabel({ kind: "until-stopped" })).toBe("Until stopped");
  });

  it("maps choices to dispatch fields, with until-stopped deferring to the hard cap", () => {
    expect(loopBudgetChoiceToDispatchFields({ kind: "count", turns: 10 })).toEqual({
      maxIterations: 10,
      durationSeconds: null,
    });
    expect(loopBudgetChoiceToDispatchFields({ kind: "duration", seconds: 1800 })).toEqual({
      maxIterations: null,
      durationSeconds: 1800,
    });
    expect(loopBudgetChoiceToDispatchFields({ kind: "until-stopped" })).toEqual({
      maxIterations: null,
      durationSeconds: null,
    });
  });
});

describe("objective validation", () => {
  it("rejects empty, slash-leading, and over-limit objectives", () => {
    expect(validateLoopObjective("", false)).toBe("empty");
    expect(validateLoopObjective("   ", false)).toBe("empty");
    expect(validateLoopObjective("/clear", false)).toBe("starts-with-slash");
    expect(validateLoopObjective("x".repeat(120_001), false)).toBe("too-long");
    expect(validateLoopObjective("fix the tests", false)).toBeNull();
  });

  it("blocks unsupported context without touching content", () => {
    expect(validateLoopObjective("fix the tests", true)).toBe("unsupported-context");
  });
});

describe("isUnsupportedLoopContext", () => {
  const empty = {
    imageCount: 0,
    fileCount: 0,
    terminalContextCount: 0,
    selectedSkillCount: 0,
    selectedMentionCount: 0,
    assistantSelectionCount: 0,
  };

  it("is false for text-only context", () => {
    expect(isUnsupportedLoopContext(empty)).toBe(false);
  });

  it("is true when any non-text context is present", () => {
    expect(isUnsupportedLoopContext({ ...empty, imageCount: 1 })).toBe(true);
    expect(isUnsupportedLoopContext({ ...empty, fileCount: 1 })).toBe(true);
    expect(isUnsupportedLoopContext({ ...empty, terminalContextCount: 1 })).toBe(true);
    expect(isUnsupportedLoopContext({ ...empty, selectedSkillCount: 1 })).toBe(true);
    expect(isUnsupportedLoopContext({ ...empty, selectedMentionCount: 1 })).toBe(true);
    expect(isUnsupportedLoopContext({ ...empty, assistantSelectionCount: 1 })).toBe(true);
  });
});
