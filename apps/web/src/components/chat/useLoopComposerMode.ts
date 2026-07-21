// FILE: useLoopComposerMode.ts
// Purpose: Local state + dispatch for the guided `/loop` composer setup and edit modes.
// Layer: Web chat composer controller
// No JSX. Pure helpers are exported for tests; the hook wires them to the composer.

import {
  type ClientOrchestrationCommand,
  type CommandId,
  LOOP_DEFAULT_HARD_CAP,
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
  LOOP_PROMPT_MAX_INPUT_CHARS,
  type LoopActivationId,
  type ThreadId,
  type ThreadLoop,
} from "@synara/contracts";
import { parseLoopCommand, type LoopBudget } from "@synara/shared/loop";
import { useEffect, useRef, useState } from "react";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";

export type LoopBudgetChoice =
  | { kind: "count"; turns: number }
  | { kind: "duration"; seconds: number }
  // No explicit budget; the server applies the hard cap (LOOP_DEFAULT_HARD_CAP).
  | { kind: "until-stopped" };

export type LoopComposerMode =
  | { kind: "closed" }
  | { kind: "create"; budget: LoopBudgetChoice; sourceDraft: string }
  | { kind: "edit"; budget: LoopBudgetChoice; sourceDraft: string; activationId: LoopActivationId };

export const LOOP_DEFAULT_BUDGET_CHOICE: LoopBudgetChoice = { kind: "count", turns: 5 };

export const LOOP_COUNT_PRESETS = [5, 10, 25, 50] as const;
export const LOOP_DURATION_PRESETS_SECONDS = [30 * 60, 60 * 60] as const;

export const LOOP_BUDGET_COUNT_ERROR = "Choose between 1 and 100 turns.";
export const LOOP_BUDGET_DURATION_ERROR = "Duration cannot exceed 24 hours.";
export const LOOP_CHOOSE_BUDGET_NOTE = "Choose how long the loop should run.";
export const LOOP_UNSUPPORTED_CONTEXT_MESSAGE =
  "Loop prompts are text-only. Remove attachments and selected tools to continue.";
export const LOOP_EDIT_STALE_ERROR =
  "This loop ended while you were editing. Start a new loop to continue.";

export function loopBudgetChoiceFromParsed(budget: LoopBudget | null): LoopBudgetChoice {
  if (budget === null) return LOOP_DEFAULT_BUDGET_CHOICE;
  if (budget.kind === "count") return { kind: "count", turns: budget.value };
  return { kind: "duration", seconds: budget.seconds };
}

export function loopBudgetChoiceFromLoop(loop: ThreadLoop): LoopBudgetChoice {
  if (loop.maxIterations !== null) return { kind: "count", turns: loop.maxIterations };
  if (loop.endsAt !== null) {
    const totalMs = new Date(loop.endsAt).getTime() - new Date(loop.createdAt).getTime();
    return { kind: "duration", seconds: Math.max(60, Math.round(totalMs / 1000)) };
  }
  return { kind: "until-stopped" };
}

export function validateLoopBudgetChoice(choice: LoopBudgetChoice): string | null {
  if (choice.kind === "count") {
    if (
      !Number.isInteger(choice.turns) ||
      choice.turns < 1 ||
      choice.turns > LOOP_MAX_COUNT_BUDGET
    ) {
      return LOOP_BUDGET_COUNT_ERROR;
    }
    return null;
  }
  if (choice.kind === "duration") {
    if (
      !Number.isFinite(choice.seconds) ||
      choice.seconds < 60 ||
      choice.seconds > LOOP_MAX_DURATION_SECONDS
    ) {
      return LOOP_BUDGET_DURATION_ERROR;
    }
    return null;
  }
  return null;
}

export function formatLoopBudgetChoiceLabel(choice: LoopBudgetChoice): string {
  if (choice.kind === "count") {
    return `Stop after ${choice.turns} ${choice.turns === 1 ? "turn" : "turns"}`;
  }
  if (choice.kind === "duration") {
    const minutes = Math.round(choice.seconds / 60);
    if (minutes < 60) return `Stop after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
      ? `Stop after ${hours} ${hours === 1 ? "hour" : "hours"}`
      : `Stop after ${hours}h ${rest}m`;
  }
  return "Until stopped";
}

export function loopBudgetChoiceToDispatchFields(choice: LoopBudgetChoice): {
  maxIterations: number | null;
  durationSeconds: number | null;
} {
  if (choice.kind === "count") return { maxIterations: choice.turns, durationSeconds: null };
  if (choice.kind === "duration") return { maxIterations: null, durationSeconds: choice.seconds };
  // Until-stopped relies on the server-side hard cap of LOOP_DEFAULT_HARD_CAP turns.
  return { maxIterations: null, durationSeconds: null };
}

export interface LoopUnsupportedContextInput {
  imageCount: number;
  fileCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
  assistantSelectionCount: number;
}

export function isUnsupportedLoopContext(input: LoopUnsupportedContextInput): boolean {
  return (
    input.imageCount > 0 ||
    input.fileCount > 0 ||
    input.terminalContextCount > 0 ||
    input.selectedSkillCount > 0 ||
    input.selectedMentionCount > 0 ||
    input.assistantSelectionCount > 0
  );
}

export type LoopObjectiveInvalidReason =
  | "empty"
  | "starts-with-slash"
  | "too-long"
  | "unsupported-context";

export function validateLoopObjective(
  objective: string,
  hasUnsupportedContext: boolean,
): LoopObjectiveInvalidReason | null {
  if (hasUnsupportedContext) return "unsupported-context";
  const trimmed = objective.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.startsWith("/")) return "starts-with-slash";
  if (trimmed.length > LOOP_PROMPT_MAX_INPUT_CHARS) return "too-long";
  return null;
}

export type LoopSetupNote = "choose-budget" | "invalid-budget" | "unsupported-context";

// Best-effort mapping of a malformed budget token (e.g. `0`, `101`, `25h`) to a
// budget choice so setup can show the invalid value instead of silently
// resetting to the default.
export function loopBudgetChoiceFromInvalidToken(token: string): LoopBudgetChoice | null {
  if (/^[+-]?\d+$/.test(token)) {
    return { kind: "count", turns: Number(token) };
  }
  const durationMatch = /^([+-]?\d+)(s|m|min|mins|h|hr|hrs)$/i.exec(token);
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2]!.toLowerCase();
    const seconds = unit === "s" ? value : unit.startsWith("m") ? value * 60 : value * 3600;
    return { kind: "duration", seconds };
  }
  return null;
}

export type LoopInvocationInterpretation =
  | {
      kind: "open-setup";
      budget: LoopBudgetChoice;
      objective: string;
      note: LoopSetupNote | null;
    }
  | { kind: "start-direct"; budget: LoopBudget; prompt: string }
  | { kind: "toggle-off" }
  | {
      kind: "reject";
      reason: "ambiguous_second_budget" | "prompt_starts_with_slash" | "prompt_too_long";
    }
  | { kind: "not-loop" };

/**
 * Route a typed `/loop` invocation (section 3.2):
 * - inactive bare `/loop`, `/loop 10`, `/loop 30m` → guided setup with that budget;
 * - `/loop fix tests` (missing budget) → setup with the objective prefilled;
 * - malformed budget → setup, preserving text, with inline validation;
 * - valid budget + prompt → direct start;
 * - active bare `/loop` → server toggle off.
 */
export function interpretLoopInvocation(
  text: string,
  options: { loopActive: boolean },
): LoopInvocationInterpretation {
  const parsed = parseLoopCommand(text);
  if (parsed === null) return { kind: "not-loop" };

  const args = text
    .trimStart()
    .replace(/^\/loop/i, "")
    .trim();

  if (parsed.kind === "invalid") {
    if (parsed.reason === "missing_budget") {
      return {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: args,
        note: "choose-budget",
      };
    }
    if (parsed.reason === "invalid_budget") {
      const firstToken = args.match(/^\S*/)?.[0] ?? "";
      const invalidChoice = loopBudgetChoiceFromInvalidToken(firstToken);
      return {
        kind: "open-setup",
        budget: invalidChoice ?? LOOP_DEFAULT_BUDGET_CHOICE,
        objective: invalidChoice === null ? args : args.slice(firstToken.length).trim(),
        note: "invalid-budget",
      };
    }
    return { kind: "reject", reason: parsed.reason };
  }

  const isBare = parsed.budget === null && parsed.prompt === null;
  if (isBare && options.loopActive) {
    return { kind: "toggle-off" };
  }

  if (parsed.budget !== null && parsed.prompt !== null) {
    return { kind: "start-direct", budget: parsed.budget, prompt: parsed.prompt };
  }

  return {
    kind: "open-setup",
    budget: loopBudgetChoiceFromParsed(parsed.budget),
    objective: "",
    note: null,
  };
}

type LoopSetCommand = Extract<ClientOrchestrationCommand, { type: "thread.loop.set" }>;

export interface LoopSetupDispatchDeps {
  dispatchCommand: (command: LoopSetCommand) => Promise<unknown>;
  newCommandId: () => CommandId;
  now: () => string;
}

export type LoopSetupSubmitResult = { ok: true } | { ok: false; message: string };

export async function performLoopSetupSubmit(
  deps: LoopSetupDispatchDeps,
  input: {
    threadId: ThreadId;
    objective: string;
    budget: LoopBudgetChoice;
    expectedActivationId?: LoopActivationId;
  },
): Promise<LoopSetupSubmitResult> {
  const fields = loopBudgetChoiceToDispatchFields(input.budget);
  try {
    await deps.dispatchCommand({
      type: "thread.loop.set",
      commandId: deps.newCommandId(),
      threadId: input.threadId,
      prompt: input.objective.trim(),
      maxIterations: fields.maxIterations,
      durationSeconds: fields.durationSeconds,
      ...(input.expectedActivationId !== undefined
        ? { expectedActivationId: input.expectedActivationId }
        : {}),
      createdAt: deps.now(),
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "An error occurred while starting the loop.",
    };
  }
}

export interface UseLoopComposerModeInput {
  threadId: ThreadId;
  activeLoop: ThreadLoop | null;
  hasUnsupportedContext: boolean;
  getObjective: () => string;
  setObjective: (value: string) => void;
  clearObjective: () => void;
  focusEditor: () => void;
  syncServerShellSnapshot: () => Promise<void>;
  ensureThreadReady: (titleSeed: string) => Promise<boolean>;
}

export interface LoopComposerController {
  mode: LoopComposerMode;
  isDispatching: boolean;
  note: string | null;
  error: string | null;
  budgetError: string | null;
  isUnsupportedContext: boolean;
  startDisabled: boolean;
  openCreate: (options?: LoopComposerOpenCreateOptions) => void;
  openEdit: () => void;
  setBudget: (budget: LoopBudgetChoice) => void;
  cancel: () => void;
  submit: () => Promise<void>;
}

export interface LoopComposerOpenCreateOptions {
  budget?: LoopBudgetChoice;
  objective?: string;
  note?: LoopSetupNote | null;
}

export interface LoopComposerCoreState {
  mode: LoopComposerMode;
  // `note` is a quiet informational hint; `error` is a validation failure.
  note: string | null;
  error: string | null;
  isDispatching: boolean;
}

export const LOOP_COMPOSER_CLOSED_STATE: LoopComposerCoreState = {
  mode: { kind: "closed" },
  note: null,
  error: null,
  isDispatching: false,
};

export interface LoopComposerCoreEnv {
  getThreadId: () => ThreadId;
  getActiveLoop: () => ThreadLoop | null;
  hasUnsupportedContext: () => boolean;
  getObjective: () => string;
  setObjective: (value: string) => void;
  clearObjective: () => void;
  focusEditor: () => void;
  syncServerShellSnapshot: () => Promise<void>;
  ensureThreadReady: (titleSeed: string) => Promise<boolean>;
  getDispatchDeps: () => LoopSetupDispatchDeps | null;
}

export interface LoopComposerCore {
  getState: () => LoopComposerCoreState;
  openCreate: (options?: LoopComposerOpenCreateOptions) => void;
  openEdit: () => void;
  setBudget: (budget: LoopBudgetChoice) => void;
  cancel: () => void;
  submit: () => Promise<void>;
}

/**
 * Framework-free controller for the guided setup / edit modes. The hook wires
 * it to React state; tests drive it directly.
 */
export function createLoopComposerCore(
  env: LoopComposerCoreEnv,
  onStateChange?: (state: LoopComposerCoreState) => void,
): LoopComposerCore {
  let state = LOOP_COMPOSER_CLOSED_STATE;
  const setState = (partial: Partial<LoopComposerCoreState>) => {
    state = { ...state, ...partial };
    onStateChange?.(state);
  };

  const openCreate = (options?: LoopComposerOpenCreateOptions) => {
    const sourceDraft = env.getObjective();
    if (options?.objective !== undefined) {
      env.setObjective(options.objective);
    }
    const budget = options?.budget ?? LOOP_DEFAULT_BUDGET_CHOICE;
    setState({
      mode: { kind: "create", budget, sourceDraft },
      note: options?.note === "choose-budget" ? LOOP_CHOOSE_BUDGET_NOTE : null,
      error:
        options?.note === "invalid-budget"
          ? (validateLoopBudgetChoice(budget) ?? LOOP_BUDGET_COUNT_ERROR)
          : options?.note === "unsupported-context"
            ? LOOP_UNSUPPORTED_CONTEXT_MESSAGE
            : null,
    });
    env.focusEditor();
  };

  const openEdit = () => {
    const activeLoop = env.getActiveLoop();
    if (activeLoop == null || !activeLoop.active) return;
    const sourceDraft = env.getObjective();
    env.setObjective(activeLoop.prompt);
    setState({
      mode: {
        kind: "edit",
        budget: loopBudgetChoiceFromLoop(activeLoop),
        sourceDraft,
        activationId: activeLoop.activationId,
      },
      note: null,
      error: null,
    });
    env.focusEditor();
  };

  const setBudget = (budget: LoopBudgetChoice) => {
    if (state.mode.kind === "closed") return;
    setState({ mode: { ...state.mode, budget }, note: null, error: null });
  };

  // Lossless cancel: keep the objective text (and attachments/context) in the
  // normal composer, discard only the loop budget, and retain focus.
  const cancel = () => {
    if (state.mode.kind === "edit") {
      env.setObjective(state.mode.sourceDraft);
    }
    setState(LOOP_COMPOSER_CLOSED_STATE);
    env.focusEditor();
  };

  const submit = async () => {
    const mode = state.mode;
    if (mode.kind === "closed" || state.isDispatching) return;
    const objective = env.getObjective();
    const objectiveError = validateLoopObjective(objective, env.hasUnsupportedContext());
    const nextBudgetError = validateLoopBudgetChoice(mode.budget);
    if (objectiveError !== null || nextBudgetError !== null) {
      setState({
        note: null,
        error:
          nextBudgetError ??
          (objectiveError === "unsupported-context"
            ? LOOP_UNSUPPORTED_CONTEXT_MESSAGE
            : objectiveError === "starts-with-slash"
              ? "The loop objective can't start with `/`."
              : objectiveError === "too-long"
                ? "That loop objective is too long. Shorten it and try again."
                : "Describe what Synara should keep working on."),
      });
      env.focusEditor();
      return;
    }

    // Edit saves must target the activation the user opened; if the loop
    // ended or was replaced meanwhile, surface it instead of silently
    // starting a brand-new loop.
    if (mode.kind === "edit" && env.getActiveLoop()?.activationId !== mode.activationId) {
      setState({ note: null, error: LOOP_EDIT_STALE_ERROR });
      env.focusEditor();
      return;
    }

    const dispatchDeps = env.getDispatchDeps();
    if (!dispatchDeps) {
      setState({ note: null, error: "Unable to connect to the app server." });
      env.focusEditor();
      return;
    }

    setState({ isDispatching: true, note: null, error: null });
    try {
      const ready = await env.ensureThreadReady(objective);
      if (!ready) {
        setState({ error: "Unable to connect to the app server." });
        env.focusEditor();
        return;
      }
      const result = await performLoopSetupSubmit(dispatchDeps, {
        threadId: env.getThreadId(),
        objective,
        budget: mode.budget,
        ...(mode.kind === "edit" ? { expectedActivationId: mode.activationId } : {}),
      });
      if (!result.ok) {
        setState({ error: result.message });
        env.focusEditor();
        return;
      }
      await env.syncServerShellSnapshot();
      // Authoritative success: exit setup and clear the objective from the
      // normal composer. Never clear local state before this point.
      env.clearObjective();
      setState({ mode: { kind: "closed" } });
      env.focusEditor();
    } finally {
      setState({ isDispatching: false });
    }
  };

  return { getState: () => state, openCreate, openEdit, setBudget, cancel, submit };
}

function createBoundLoopComposerCore(
  inputRef: { readonly current: UseLoopComposerModeInput },
  onStateChange: (state: LoopComposerCoreState) => void,
): LoopComposerCore {
  return createLoopComposerCore(
    {
      getThreadId: () => inputRef.current.threadId,
      getActiveLoop: () => inputRef.current.activeLoop,
      hasUnsupportedContext: () => inputRef.current.hasUnsupportedContext,
      getObjective: () => inputRef.current.getObjective(),
      setObjective: (value) => inputRef.current.setObjective(value),
      clearObjective: () => inputRef.current.clearObjective(),
      focusEditor: () => inputRef.current.focusEditor(),
      syncServerShellSnapshot: () => inputRef.current.syncServerShellSnapshot(),
      ensureThreadReady: (titleSeed) => inputRef.current.ensureThreadReady(titleSeed),
      getDispatchDeps: () => {
        const api = readNativeApi();
        if (!api) return null;
        return {
          dispatchCommand: (command) => api.orchestration.dispatchCommand(command),
          newCommandId,
          now: () => new Date().toISOString(),
        };
      },
    },
    onStateChange,
  );
}

export function useLoopComposerMode(input: UseLoopComposerModeInput): LoopComposerController {
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const [state, setState] = useState<LoopComposerCoreState>(LOOP_COMPOSER_CLOSED_STATE);
  const [core] = useState(() => createBoundLoopComposerCore(inputRef, setState));

  const { mode, note, error, isDispatching } = state;
  const budgetError = mode.kind === "closed" ? null : validateLoopBudgetChoice(mode.budget);
  const objectiveInvalidReason =
    mode.kind === "closed"
      ? null
      : validateLoopObjective(input.getObjective(), input.hasUnsupportedContext);
  const startDisabled =
    mode.kind === "closed" ||
    isDispatching ||
    budgetError !== null ||
    objectiveInvalidReason !== null;

  return {
    mode,
    isDispatching,
    note,
    error: error ?? budgetError,
    budgetError,
    isUnsupportedContext: mode.kind !== "closed" && input.hasUnsupportedContext,
    startDisabled,
    openCreate: core.openCreate,
    openEdit: core.openEdit,
    setBudget: core.setBudget,
    cancel: core.cancel,
    submit: core.submit,
  };
}

export { LOOP_DEFAULT_HARD_CAP };
