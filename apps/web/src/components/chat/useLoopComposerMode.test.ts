import { describe, expect, it } from "vitest";

import { CommandId, ThreadId, type ThreadLoop } from "@synara/contracts";

import {
  LOOP_BUDGET_COUNT_ERROR,
  LOOP_BUDGET_DURATION_ERROR,
  LOOP_DEFAULT_BUDGET_CHOICE,
  formatLoopBudgetChoiceLabel,
  interpretLoopInvocation,
  isUnsupportedLoopContext,
  loopBudgetChoiceFromLoop,
  loopBudgetChoiceFromParsed,
  loopBudgetChoiceToDispatchFields,
  performLoopSetupSubmit,
  validateLoopBudgetChoice,
  validateLoopObjective,
  type LoopSetupDispatchDeps,
} from "./useLoopComposerMode";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeDeps(overrides: Partial<LoopSetupDispatchDeps> = {}): {
  deps: LoopSetupDispatchDeps;
  dispatched: unknown[];
} {
  const dispatched: unknown[] = [];
  const deps: LoopSetupDispatchDeps = {
    dispatchCommand: (command) => {
      dispatched.push(command);
      return Promise.resolve();
    },
    newCommandId: () => CommandId.makeUnsafe("cmd-1"),
    now: () => "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
  return { deps, dispatched };
}

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return {
    active: true,
    prompt: "Keep fixing tests",
    iteration: 2,
    maxIterations: 5,
    endsAt: null,
    hardCap: 100,
    consecutiveErrors: 0,
    lastStopReason: null,
    activationId: "activation-1",
    createdAt: "2026-01-01T11:00:00.000Z",
    updatedAt: "2026-01-01T11:30:00.000Z",
    ...overrides,
  } as ThreadLoop;
}

describe("interpretLoopInvocation", () => {
  it("routes inactive bare /loop to guided setup with the 5-turn default", () => {
    const result = interpretLoopInvocation("/loop", { loopActive: false });
    expect(result).toEqual({
      kind: "open-setup",
      budget: { kind: "count", turns: 5 },
      objective: "",
      note: null,
    });
  });

  it("routes /loop 10 to setup with a 10-turn budget", () => {
    const result = interpretLoopInvocation("/loop 10", { loopActive: false });
    expect(result).toEqual({
      kind: "open-setup",
      budget: { kind: "count", turns: 10 },
      objective: "",
      note: null,
    });
  });

  it("routes /loop 30m to setup with a 30-minute budget", () => {
    const result = interpretLoopInvocation("/loop 30m", { loopActive: false });
    expect(result).toEqual({
      kind: "open-setup",
      budget: { kind: "duration", seconds: 30 * 60 },
      objective: "",
      note: null,
    });
  });

  it("prefills the objective for a missing-budget prompt", () => {
    const result = interpretLoopInvocation("/loop fix the tests", { loopActive: false });
    expect(result).toEqual({
      kind: "open-setup",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
      objective: "fix the tests",
      note: "choose-budget",
    });
  });

  it("starts immediately for a valid budget plus prompt", () => {
    const result = interpretLoopInvocation("/loop 5 fix the tests", { loopActive: false });
    expect(result).toEqual({
      kind: "start-direct",
      budget: { kind: "count", value: 5 },
      prompt: "fix the tests",
    });
  });

  it("toggles off for active bare /loop", () => {
    expect(interpretLoopInvocation("/loop", { loopActive: true })).toEqual({
      kind: "toggle-off",
    });
  });

  it("preserves the text and opens setup with validation for a malformed budget", () => {
    const result = interpretLoopInvocation("/loop 0", { loopActive: false });
    expect(result).toEqual({
      kind: "open-setup",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
      objective: "0",
      note: "invalid-budget",
    });
  });

  it("rejects a prompt starting with a slash", () => {
    const result = interpretLoopInvocation("/loop 5 /clear", { loopActive: false });
    expect(result).toEqual({ kind: "reject", reason: "prompt_starts_with_slash" });
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
      loopBudgetChoiceFromLoop(
        makeLoop({ maxIterations: null, endsAt: "2026-01-01T11:30:00.000Z" }),
      ),
    ).toEqual({ kind: "duration", seconds: 30 * 60 });
    expect(loopBudgetChoiceFromLoop(makeLoop({ maxIterations: null, endsAt: null }))).toEqual({
      kind: "until-stopped",
    });
  });

  it("validates count range 1..100", () => {
    expect(validateLoopBudgetChoice({ kind: "count", turns: 1 })).toBeNull();
    expect(validateLoopBudgetChoice({ kind: "count", turns: 100 })).toBeNull();
    expect(validateLoopBudgetChoice({ kind: "count", turns: 0 })).toBe(LOOP_BUDGET_COUNT_ERROR);
    expect(validateLoopBudgetChoice({ kind: "count", turns: 101 })).toBe(LOOP_BUDGET_COUNT_ERROR);
  });

  it("validates duration up to 24 hours", () => {
    expect(validateLoopBudgetChoice({ kind: "duration", seconds: 24 * 3600 })).toBeNull();
    expect(validateLoopBudgetChoice({ kind: "duration", seconds: 24 * 3600 + 1 })).toBe(
      LOOP_BUDGET_DURATION_ERROR,
    );
    expect(validateLoopBudgetChoice({ kind: "until-stopped" })).toBeNull();
  });

  it("formats trigger labels", () => {
    expect(formatLoopBudgetChoiceLabel({ kind: "count", turns: 5 })).toBe("Stop after 5 turns");
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

describe("performLoopSetupSubmit", () => {
  it("dispatches thread.loop.set with the trimmed prompt and budget", async () => {
    const { deps, dispatched } = makeDeps();
    const result = await performLoopSetupSubmit(deps, {
      threadId: THREAD_ID,
      objective: "  fix the tests  ",
      budget: { kind: "count", turns: 10 },
    });
    expect(result).toEqual({ ok: true });
    expect(dispatched).toEqual([
      {
        type: "thread.loop.set",
        commandId: "cmd-1",
        threadId: THREAD_ID,
        prompt: "fix the tests",
        maxIterations: 10,
        durationSeconds: null,
        createdAt: "2026-01-01T12:00:00.000Z",
      },
    ]);
  });

  it("returns the failure message and dispatches nothing extra on error", async () => {
    const { deps } = makeDeps({
      dispatchCommand: () => Promise.reject(new Error("server down")),
    });
    const result = await performLoopSetupSubmit(deps, {
      threadId: THREAD_ID,
      objective: "fix the tests",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
    });
    expect(result).toEqual({ ok: false, message: "server down" });
  });
});
