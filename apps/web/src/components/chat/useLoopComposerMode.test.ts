import { describe, expect, it } from "vitest";

import { CommandId, LoopActivationId, ThreadId, type ThreadLoop } from "@synara/contracts";

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
    activationId: LoopActivationId.makeUnsafe("activation-1"),
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
    const result = interpretLoopInvocation("/loop fix the tests", {
      loopActive: false,
    });
    expect(result).toEqual({
      kind: "open-setup",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
      objective: "fix the tests",
      note: "choose-budget",
    });
  });

  it("starts immediately for a valid budget plus prompt", () => {
    const result = interpretLoopInvocation("/loop 5 fix the tests", {
      loopActive: false,
    });
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

  it("drops the malformed budget token and opens setup with an inline error", () => {
    expect(interpretLoopInvocation("/loop 0", { loopActive: false })).toEqual({
      kind: "open-setup",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
      objective: "",
      note: "invalid-budget",
    });
    expect(interpretLoopInvocation("/loop 200 fix the tests", { loopActive: false })).toEqual({
      kind: "open-setup",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
      objective: "fix the tests",
      note: "invalid-budget",
    });
    expect(interpretLoopInvocation("/loop 25h ship it", { loopActive: false })).toEqual({
      kind: "open-setup",
      budget: LOOP_DEFAULT_BUDGET_CHOICE,
      objective: "ship it",
      note: "invalid-budget",
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

  it("validates duration between 1 minute and 24 hours", () => {
    expect(validateLoopBudgetChoice({ kind: "duration", seconds: 60 })).toBeNull();
    expect(validateLoopBudgetChoice({ kind: "duration", seconds: 24 * 3600 })).toBeNull();
    expect(validateLoopBudgetChoice({ kind: "duration", seconds: 59 })).toBe(
      LOOP_BUDGET_DURATION_MIN_ERROR,
    );
    expect(validateLoopBudgetChoice({ kind: "duration", seconds: 24 * 3600 + 1 })).toBe(
      LOOP_BUDGET_DURATION_MAX_ERROR,
    );
    expect(validateLoopBudgetChoice({ kind: "until-stopped" })).toBeNull();
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

  it("includes expectedActivationId when provided", async () => {
    const { deps, dispatched } = makeDeps();
    const result = await performLoopSetupSubmit(deps, {
      threadId: THREAD_ID,
      objective: "fix the tests",
      budget: { kind: "count", turns: 10 },
      expectedActivationId: LoopActivationId.makeUnsafe("activation-1"),
    });
    expect(result).toEqual({ ok: true });
    expect(dispatched[0]).toMatchObject({
      expectedActivationId: "activation-1",
    });
  });

  it("omits expectedActivationId when not provided", async () => {
    const { deps, dispatched } = makeDeps();
    await performLoopSetupSubmit(deps, {
      threadId: THREAD_ID,
      objective: "fix the tests",
      budget: { kind: "count", turns: 10 },
    });
    expect(dispatched[0]).not.toHaveProperty("expectedActivationId");
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
/* Legacy core-abstraction tests are superseded by the direct hook tests above.
function makeCoreHarness(
  overrides: {
    objective?: string;
    activeLoop?: ThreadLoop | null | (() => ThreadLoop | null);
    hasUnsupportedContext?: boolean;
    ensureThreadReady?: (titleSeed: string) => Promise<boolean>;
    dispatchCommand?: LoopSetupDispatchDeps["dispatchCommand"];
    getDispatchDeps?: LoopComposerCoreEnv["getDispatchDeps"];
  } = {},
) {
  let objective = overrides.objective ?? "";
  const dispatched: unknown[] = [];
  const calls: string[] = [];
  const env: LoopComposerCoreEnv = {
    getThreadId: () => THREAD_ID,
    getActiveLoop: () =>
      (typeof overrides.activeLoop === "function"
        ? overrides.activeLoop()
        : overrides.activeLoop) ?? null,
    hasUnsupportedContext: () => overrides.hasUnsupportedContext ?? false,
    getObjective: () => objective,
    setObjective: (value) => {
      objective = value;
    },
    clearObjective: () => {
      objective = "";
    },
    focusEditor: () => {},
    syncServerShellSnapshot: () => {
      calls.push("sync");
      return Promise.resolve();
    },
    ensureThreadReady: (titleSeed) => {
      calls.push(`ensure:${titleSeed}`);
      return overrides.ensureThreadReady?.(titleSeed) ?? Promise.resolve(true);
    },
    getDispatchDeps:
      overrides.getDispatchDeps ??
      (() => ({
        dispatchCommand: (command) => {
          calls.push("dispatch");
          dispatched.push(command);
          return overrides.dispatchCommand?.(command) ?? Promise.resolve();
        },
        newCommandId: () => CommandId.makeUnsafe("cmd-1"),
        now: () => "2026-01-01T12:00:00.000Z",
      })),
  };
  const core = createLoopComposerCore(env);
  return {
    core,
    dispatched,
    calls,
    getObjective: () => objective,
  };
}

describe("createLoopComposerCore", () => {
  it("enters setup from the menu with the default budget and no messages", () => {
    const { core, getObjective } = makeCoreHarness({ objective: "draft text" });
    core.openCreate();
    expect(core.getState()).toEqual({
      mode: { kind: "create", budget: LOOP_DEFAULT_BUDGET_CHOICE, sourceDraft: "draft text" },
      note: null,
      error: null,
      isDispatching: false,
    });
    expect(getObjective()).toBe("draft text");
  });

  it("shows a quiet note (not an error) for a missing budget", () => {
    const { core } = makeCoreHarness();
    core.openCreate({ objective: "fix tests", note: "choose-budget" });
    expect(core.getState().note).toBe(LOOP_CHOOSE_BUDGET_NOTE);
    expect(core.getState().error).toBeNull();
  });

  it("shows the matching validation error and keeps the invalid budget", () => {
    const { core } = makeCoreHarness();
    core.openCreate({ budget: { kind: "count", turns: 0 }, note: "invalid-budget" });
    expect(core.getState().error).toBe(LOOP_BUDGET_COUNT_ERROR);
    expect(core.getState().mode).toMatchObject({ budget: { kind: "count", turns: 0 } });

    core.openCreate({ budget: { kind: "duration", seconds: 25 * 3600 }, note: "invalid-budget" });
    expect(core.getState().error).toBe(LOOP_BUDGET_DURATION_ERROR);
  });

  it("shows the text-only contract error for unsupported context setup", () => {
    const { core } = makeCoreHarness();
    core.openCreate({ objective: "fix tests", note: "unsupported-context" });
    expect(core.getState().error).toBe(LOOP_UNSUPPORTED_CONTEXT_MESSAGE);
    expect(core.getState().note).toBeNull();
  });

  it("prefills edit mode from the active loop", () => {
    const { core, getObjective } = makeCoreHarness({
      objective: "draft text",
      activeLoop: makeLoop({ maxIterations: 10 }),
    });
    core.openEdit();
    expect(core.getState().mode).toEqual({
      kind: "edit",
      budget: { kind: "count", turns: 10 },
      sourceDraft: "draft text",
      activationId: LoopActivationId.makeUnsafe("activation-1"),
    });
    expect(getObjective()).toBe("Keep fixing tests");
  });

  it("cancel keeps the create objective and restores the edit source draft", () => {
    const create = makeCoreHarness({ objective: "keep me" });
    create.core.openCreate();
    create.core.cancel();
    expect(create.core.getState().mode).toEqual({ kind: "closed" });
    expect(create.getObjective()).toBe("keep me");

    const edit = makeCoreHarness({ objective: "draft text", activeLoop: makeLoop() });
    edit.core.openEdit();
    edit.core.cancel();
    expect(edit.getObjective()).toBe("draft text");
  });

  it("clears note and error when a budget is chosen", () => {
    const { core } = makeCoreHarness({ objective: "fix tests" });
    core.openCreate({ note: "choose-budget" });
    core.setBudget({ kind: "count", turns: 10 });
    expect(core.getState()).toMatchObject({
      mode: { budget: { kind: "count", turns: 10 } },
      note: null,
      error: null,
    });
  });

  it("preserves setup state and objective on submit failure", async () => {
    const { core, getObjective } = makeCoreHarness({
      objective: "fix tests",
      dispatchCommand: () => Promise.reject(new Error("server down")),
    });
    core.openCreate();
    await core.submit();
    expect(core.getState()).toMatchObject({
      mode: { kind: "create" },
      error: "server down",
      isDispatching: false,
    });
    expect(getObjective()).toBe("fix tests");
  });

  it("clears the objective and closes only after an authoritative success", async () => {
    const { core, dispatched, getObjective } = makeCoreHarness({ objective: "fix tests" });
    core.openCreate();
    await core.submit();
    expect(dispatched).toHaveLength(1);
    expect(core.getState().mode).toEqual({ kind: "closed" });
    expect(getObjective()).toBe("");
  });

  it("blocks submit for unsupported context with the text-only error", async () => {
    const { core, dispatched } = makeCoreHarness({
      objective: "fix tests",
      hasUnsupportedContext: true,
    });
    core.openCreate();
    await core.submit();
    expect(core.getState().error).toBe(LOOP_UNSUPPORTED_CONTEXT_MESSAGE);
    expect(dispatched).toHaveLength(0);
  });

  it("prevents a double submit while dispatch is in flight", async () => {
    let releaseReady: (ready: boolean) => void = () => {};
    const { core, dispatched } = makeCoreHarness({
      objective: "fix tests",
      ensureThreadReady: () =>
        new Promise((resolve) => {
          releaseReady = resolve;
        }),
    });
    core.openCreate();
    const first = core.submit();
    const second = core.submit();
    releaseReady(true);
    await Promise.all([first, second]);
    expect(dispatched).toHaveLength(1);
  });

  it("sends expectedActivationId on edit submits", async () => {
    const { core, dispatched } = makeCoreHarness({
      objective: "draft text",
      activeLoop: makeLoop(),
    });
    core.openEdit();
    await core.submit();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ expectedActivationId: "activation-1" });
    expect(core.getState().mode).toEqual({ kind: "closed" });
  });

  it("blocks a stale edit save when the loop ended while editing", async () => {
    let activeLoop: ThreadLoop | null = makeLoop();
    const { core, dispatched } = makeCoreHarness({
      objective: "draft text",
      activeLoop: () => activeLoop,
    });
    core.openEdit();
    activeLoop = null;
    await core.submit();
    expect(dispatched).toHaveLength(0);
    expect(core.getState()).toMatchObject({
      mode: { kind: "edit" },
      error: LOOP_EDIT_STALE_ERROR,
    });
  });

  it("blocks a stale edit save when the activation was replaced while editing", async () => {
    let activeLoop: ThreadLoop | null = makeLoop();
    const { core, dispatched } = makeCoreHarness({
      objective: "draft text",
      activeLoop: () => activeLoop,
    });
    core.openEdit();
    activeLoop = makeLoop({ activationId: LoopActivationId.makeUnsafe("activation-2") });
    await core.submit();
    expect(dispatched).toHaveLength(0);
    expect(core.getState()).toMatchObject({
      mode: { kind: "edit" },
      error: LOOP_EDIT_STALE_ERROR,
    });
  });

  it("promotes the new-chat thread before dispatching and syncing", async () => {
    const { core, calls } = makeCoreHarness({ objective: "fix tests" });
    core.openCreate();
    await core.submit();
    expect(calls).toEqual(["ensure:fix tests", "dispatch", "sync"]);
  });
});
*/
