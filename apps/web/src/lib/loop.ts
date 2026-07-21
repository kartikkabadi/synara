// FILE: loop.ts
// Purpose: Framework-free `/loop` parser, budget-choice, and dispatch helpers.
// Layer: Web lib (pure TypeScript; no React, no Effect)
// Shared by the composer-mode hook and slash-command handling.

import {
  type ClientOrchestrationCommand,
  type CommandId,
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
  LOOP_PROMPT_MAX_INPUT_CHARS,
  type LoopActivationId,
  type ThreadId,
  type ThreadLoop,
} from "@synara/contracts";
import { parseLoopCommand, type LoopBudget } from "@synara/shared/loop";

export type LoopBudgetChoice =
  | { kind: "count"; turns: number }
  | { kind: "duration"; seconds: number }
  // No explicit budget; the server applies the hard cap (LOOP_DEFAULT_HARD_CAP).
  | { kind: "until-stopped" };

export const LOOP_DEFAULT_BUDGET_CHOICE: LoopBudgetChoice = {
  kind: "count",
  turns: 5,
};

export const LOOP_COUNT_PRESETS = [5, 10, 25, 50] as const;
export const LOOP_DURATION_PRESETS_SECONDS = [30 * 60, 60 * 60] as const;

export const LOOP_BUDGET_COUNT_ERROR = "Choose between 1 and 100 turns.";
export const LOOP_BUDGET_DURATION_MIN_ERROR = "Choose a duration of at least 1 minute.";
export const LOOP_BUDGET_DURATION_MAX_ERROR = "Choose a duration of 24 hours or less.";
export const LOOP_BUDGET_INVALID_ERROR = "That budget isn't valid. Choose a budget below.";
export const LOOP_CHOOSE_BUDGET_NOTE = "Choose how long the loop should run.";
export const LOOP_UNSUPPORTED_CONTEXT_MESSAGE =
  "Loop prompts are text-only. Remove attachments and selected tools to continue.";
export const LOOP_EDIT_STALE_ERROR =
  "This loop ended while you were editing. Start a new loop to continue.";

// Composer placeholder for the guided setup objective, also used while an
// active loop has an empty saved objective.
export const LOOP_OBJECTIVE_PLACEHOLDER = "What should Synara keep working on?";
export const LOOP_SETUP_COMPOSER_PLACEHOLDER = LOOP_OBJECTIVE_PLACEHOLDER;

export function loopBudgetChoiceFromParsed(budget: LoopBudget | null): LoopBudgetChoice {
  if (budget === null) return LOOP_DEFAULT_BUDGET_CHOICE;
  if (budget.kind === "count") return { kind: "count", turns: budget.value };
  return { kind: "duration", seconds: budget.seconds };
}

export function loopBudgetChoiceFromLoop(loop: ThreadLoop): LoopBudgetChoice {
  if (loop.maxIterations !== null) return { kind: "count", turns: loop.maxIterations };
  if (loop.durationSeconds != null) {
    return { kind: "duration", seconds: Math.max(60, loop.durationSeconds) };
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
    if (!Number.isFinite(choice.seconds) || choice.seconds < 60) {
      return LOOP_BUDGET_DURATION_MIN_ERROR;
    }
    if (choice.seconds > LOOP_MAX_DURATION_SECONDS) {
      return LOOP_BUDGET_DURATION_MAX_ERROR;
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

// Maps an open-setup note to the initial hint/error pair shown in the header.
export function loopSetupNoticeFor(note: LoopSetupNote | null | undefined): {
  note: string | null;
  error: string | null;
} {
  switch (note) {
    case "choose-budget":
      return { note: LOOP_CHOOSE_BUDGET_NOTE, error: null };
    case "invalid-budget":
      return { note: null, error: LOOP_BUDGET_INVALID_ERROR };
    case "unsupported-context":
      return { note: null, error: LOOP_UNSUPPORTED_CONTEXT_MESSAGE };
    default:
      return { note: null, error: null };
  }
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
      // The malformed budget token is dropped (setup shows an inline error and
      // the default budget); the rest of the text is preserved as the objective.
      const firstToken = args.match(/^\S*/)?.[0] ?? "";
      return {
        kind: "open-setup",
        budget: LOOP_DEFAULT_BUDGET_CHOICE,
        objective: args.slice(firstToken.length).trim(),
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
    return {
      kind: "start-direct",
      budget: parsed.budget,
      prompt: parsed.prompt,
    };
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
