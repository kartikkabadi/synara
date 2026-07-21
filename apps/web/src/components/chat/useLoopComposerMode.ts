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
  type ThreadId,
  type ThreadLoop,
} from "@synara/contracts";
import { parseLoopCommand, type LoopBudget } from "@synara/shared/loop";
import { useCallback, useState } from "react";
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
  | { kind: "edit"; budget: LoopBudgetChoice; sourceDraft: string; activationId: string };

export const LOOP_DEFAULT_BUDGET_CHOICE: LoopBudgetChoice = { kind: "count", turns: 5 };

export const LOOP_COUNT_PRESETS = [5, 10, 25, 50] as const;
export const LOOP_DURATION_PRESETS_SECONDS = [30 * 60, 60 * 60] as const;

export const LOOP_BUDGET_COUNT_ERROR = "Choose between 1 and 100 turns.";
export const LOOP_BUDGET_DURATION_ERROR = "Duration cannot exceed 24 hours.";
export const LOOP_UNSUPPORTED_CONTEXT_MESSAGE =
  "Loop prompts are text-only. Remove attachments and selected tools to continue.";

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

export type LoopInvocationInterpretation =
  | {
      kind: "open-setup";
      budget: LoopBudgetChoice;
      objective: string;
      note: "choose-budget" | "invalid-budget" | null;
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
      return {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: args,
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
  input: { threadId: ThreadId; objective: string; budget: LoopBudgetChoice },
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
  inlineError: string | null;
  budgetError: string | null;
  isUnsupportedContext: boolean;
  startDisabled: boolean;
  openCreate: (options?: {
    budget?: LoopBudgetChoice;
    objective?: string;
    note?: "choose-budget" | "invalid-budget" | null;
  }) => void;
  openEdit: () => void;
  setBudget: (budget: LoopBudgetChoice) => void;
  cancel: () => void;
  submit: () => Promise<void>;
}

export function useLoopComposerMode(input: UseLoopComposerModeInput): LoopComposerController {
  const {
    threadId,
    activeLoop,
    hasUnsupportedContext,
    getObjective,
    setObjective,
    clearObjective,
    focusEditor,
    syncServerShellSnapshot,
    ensureThreadReady,
  } = input;

  const [mode, setMode] = useState<LoopComposerMode>({ kind: "closed" });
  const [isDispatching, setIsDispatching] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const budgetError = mode.kind === "closed" ? null : validateLoopBudgetChoice(mode.budget);
  const objectiveInvalidReason =
    mode.kind === "closed" ? null : validateLoopObjective(getObjective(), hasUnsupportedContext);
  const startDisabled =
    mode.kind === "closed" ||
    isDispatching ||
    budgetError !== null ||
    objectiveInvalidReason !== null;

  const openCreate = useCallback(
    (options?: {
      budget?: LoopBudgetChoice;
      objective?: string;
      note?: "choose-budget" | "invalid-budget" | null;
    }) => {
      const sourceDraft = getObjective();
      if (options?.objective !== undefined) {
        setObjective(options.objective);
      }
      setInlineError(
        options?.note === "choose-budget"
          ? "Choose how long the loop should run."
          : options?.note === "invalid-budget"
            ? LOOP_BUDGET_COUNT_ERROR
            : null,
      );
      setMode({
        kind: "create",
        budget: options?.budget ?? LOOP_DEFAULT_BUDGET_CHOICE,
        sourceDraft,
      });
      focusEditor();
    },
    [focusEditor, getObjective, setObjective],
  );

  const openEdit = useCallback(() => {
    if (activeLoop == null || !activeLoop.active) return;
    const sourceDraft = getObjective();
    setObjective(activeLoop.prompt);
    setInlineError(null);
    setMode({
      kind: "edit",
      budget: loopBudgetChoiceFromLoop(activeLoop),
      sourceDraft,
      activationId: activeLoop.activationId,
    });
    focusEditor();
  }, [activeLoop, focusEditor, getObjective, setObjective]);

  const setBudget = useCallback((budget: LoopBudgetChoice) => {
    setInlineError(null);
    setMode((current) => (current.kind === "closed" ? current : { ...current, budget }));
  }, []);

  // Lossless cancel: keep the objective text (and attachments/context) in the
  // normal composer, discard only the loop budget, and retain focus.
  const cancel = useCallback(() => {
    setMode((current) => {
      if (current.kind === "edit") {
        setObjective(current.sourceDraft);
      }
      return { kind: "closed" };
    });
    setInlineError(null);
    setIsDispatching(false);
    focusEditor();
  }, [focusEditor, setObjective]);

  const submit = useCallback(async () => {
    if (mode.kind === "closed" || isDispatching) return;
    const objective = getObjective();
    const objectiveError = validateLoopObjective(objective, hasUnsupportedContext);
    const nextBudgetError = validateLoopBudgetChoice(mode.budget);
    if (objectiveError !== null || nextBudgetError !== null) {
      setInlineError(
        nextBudgetError ??
          (objectiveError === "unsupported-context"
            ? LOOP_UNSUPPORTED_CONTEXT_MESSAGE
            : objectiveError === "starts-with-slash"
              ? "The loop objective can't start with `/`."
              : objectiveError === "too-long"
                ? "That loop objective is too long. Shorten it and try again."
                : "Describe what Synara should keep working on."),
      );
      focusEditor();
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setInlineError("Unable to connect to the app server.");
      focusEditor();
      return;
    }

    setIsDispatching(true);
    setInlineError(null);
    try {
      const ready = await ensureThreadReady(objective);
      if (!ready) {
        setInlineError("Unable to connect to the app server.");
        focusEditor();
        return;
      }
      const result = await performLoopSetupSubmit(
        {
          dispatchCommand: (command) => api.orchestration.dispatchCommand(command),
          newCommandId,
          now: () => new Date().toISOString(),
        },
        { threadId, objective, budget: mode.budget },
      );
      if (!result.ok) {
        setInlineError(result.message);
        focusEditor();
        return;
      }
      await syncServerShellSnapshot();
      // Authoritative success: exit setup and clear the objective from the
      // normal composer. Never clear local state before this point.
      clearObjective();
      setMode({ kind: "closed" });
      focusEditor();
    } finally {
      setIsDispatching(false);
    }
  }, [
    clearObjective,
    ensureThreadReady,
    focusEditor,
    getObjective,
    hasUnsupportedContext,
    isDispatching,
    mode,
    syncServerShellSnapshot,
    threadId,
  ]);

  return {
    mode,
    isDispatching,
    inlineError: inlineError ?? budgetError,
    budgetError,
    isUnsupportedContext: mode.kind !== "closed" && hasUnsupportedContext,
    startDisabled,
    openCreate,
    openEdit,
    setBudget,
    cancel,
    submit,
  };
}

export { LOOP_DEFAULT_HARD_CAP };
