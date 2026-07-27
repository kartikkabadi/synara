// FILE: useLoopComposerMode.ts
// Purpose: Local state + dispatch for the guided `/loop` composer setup and edit modes.
// Layer: Web chat composer controller
// No JSX. Pure `/loop` helpers live in ~/lib/loop; the hook wires them to the composer.

import {
  type LoopActivationId,
  type OrchestrationShellSnapshot,
  type ThreadId,
  type ThreadLoop,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LOOP_DEFAULT_BUDGET_CHOICE,
  LOOP_EDIT_STALE_ERROR,
  LOOP_UNSUPPORTED_CONTEXT_MESSAGE,
  loopBudgetChoiceFromLoop,
  loopSetupNoticeFor,
  validateLoopBudgetChoice,
  validateLoopObjective,
  type LoopBudgetChoice,
  type LoopSetupNote,
} from "../../../lib/loop";
import { performLoopSetupSubmit } from "./dispatch";

export type LoopComposerMode =
  | { kind: "closed" }
  | { kind: "create"; budget: LoopBudgetChoice; sourceDraft: string }
  | {
      kind: "edit";
      budget: LoopBudgetChoice;
      sourceDraft: string;
      activationId: LoopActivationId;
    };

export interface UseLoopComposerModeInput {
  threadId: ThreadId;
  activeLoop: ThreadLoop | null;
  hasUnsupportedContext: boolean;
  objective: string;
  setObjective: (value: string) => void;
  clearObjective: () => void;
  focusEditor: () => void;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
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
  // Closes the mode without touching the composer draft or focus (thread switches).
  reset: () => void;
  submit: () => Promise<void>;
}

export interface LoopComposerOpenCreateOptions {
  budget?: LoopBudgetChoice;
  objective?: string;
  note?: LoopSetupNote | null;
}

interface LoopComposerModeHookState {
  mode: LoopComposerMode;
  // `note` is a quiet informational hint; `error` is a validation failure.
  note: string | null;
  error: string | null;
  isDispatching: boolean;
}

const CLOSED_STATE: LoopComposerModeHookState = {
  mode: { kind: "closed" },
  note: null,
  error: null,
  isDispatching: false,
};

export function useLoopComposerMode(input: UseLoopComposerModeInput): LoopComposerController {
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const [state, setStateRaw] = useState<LoopComposerModeHookState>(CLOSED_STATE);
  // Actions read/patch through a ref so async flows (submit) always see the
  // latest state without re-creating callbacks every render.
  const stateRef = useRef(state);
  const patch = useCallback((partial: Partial<LoopComposerModeHookState>) => {
    stateRef.current = { ...stateRef.current, ...partial };
    setStateRaw(stateRef.current);
  }, []);

  const openCreate = useCallback(
    (options?: LoopComposerOpenCreateOptions) => {
      const env = inputRef.current;
      const sourceDraft = env.objective;
      if (options?.objective !== undefined) {
        env.setObjective(options.objective);
      }
      const budget = options?.budget ?? LOOP_DEFAULT_BUDGET_CHOICE;
      patch({
        mode: { kind: "create", budget, sourceDraft },
        ...loopSetupNoticeFor(options?.note),
      });
      env.focusEditor();
    },
    [patch],
  );

  const openEdit = useCallback(() => {
    const env = inputRef.current;
    const activeLoop = env.activeLoop;
    if (activeLoop == null || !activeLoop.active) return;
    const sourceDraft = env.objective;
    env.setObjective(activeLoop.prompt);
    patch({
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
  }, [patch]);

  const setBudget = useCallback(
    (budget: LoopBudgetChoice) => {
      const mode = stateRef.current.mode;
      if (mode.kind === "closed") return;
      patch({ mode: { ...mode, budget }, note: null, error: null });
    },
    [patch],
  );

  // Lossless cancel: keep the objective text (and attachments/context) in the
  // normal composer, discard only the loop budget, and retain focus.
  const cancel = useCallback(() => {
    const env = inputRef.current;
    const mode = stateRef.current.mode;
    if (mode.kind === "edit") {
      env.setObjective(mode.sourceDraft);
    }
    patch(CLOSED_STATE);
    env.focusEditor();
  }, [patch]);

  const reset = useCallback(() => {
    if (stateRef.current.mode.kind === "closed") return;
    patch(CLOSED_STATE);
  }, [patch]);

  const submit = useCallback(async () => {
    const env = inputRef.current;
    const mode = stateRef.current.mode;
    if (mode.kind === "closed" || stateRef.current.isDispatching) return;
    const objective = env.objective;
    const objectiveError = validateLoopObjective(objective, env.hasUnsupportedContext);
    const nextBudgetError = validateLoopBudgetChoice(mode.budget);
    if (objectiveError !== null || nextBudgetError !== null) {
      patch({
        note: null,
        error:
          nextBudgetError ??
          (objectiveError === "unsupported-context"
            ? LOOP_UNSUPPORTED_CONTEXT_MESSAGE
            : objectiveError === "starts-with-slash"
              ? "The loop objective can't start with a slash."
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
    if (mode.kind === "edit" && env.activeLoop?.activationId !== mode.activationId) {
      patch({ note: null, error: LOOP_EDIT_STALE_ERROR });
      env.focusEditor();
      return;
    }

    patch({ isDispatching: true, note: null, error: null });
    try {
      const ready = await env.ensureThreadReady(objective);
      if (!ready) {
        patch({ error: "Unable to connect to the app server." });
        env.focusEditor();
        return;
      }
      const result = await performLoopSetupSubmit({
        threadId: env.threadId,
        objective,
        budget: mode.budget,
        ...(mode.kind === "edit" ? { expectedActivationId: mode.activationId } : {}),
        syncServerShellSnapshot: (snapshot) => inputRef.current.syncServerShellSnapshot(snapshot),
      });
      if (!result.ok) {
        patch({ error: result.message });
        env.focusEditor();
        return;
      }
      // Authoritative success: exit setup and clear the objective from the
      // normal composer. Never clear local state before this point.
      inputRef.current.clearObjective();
      patch({ mode: { kind: "closed" } });
      inputRef.current.focusEditor();
    } finally {
      patch({ isDispatching: false });
    }
  }, [patch]);

  const { mode, note, error, isDispatching } = state;
  const budgetError = mode.kind === "closed" ? null : validateLoopBudgetChoice(mode.budget);
  const objectiveInvalidReason =
    mode.kind === "closed"
      ? null
      : validateLoopObjective(input.objective, input.hasUnsupportedContext);
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
    openCreate,
    openEdit,
    setBudget,
    cancel,
    reset,
    submit,
  };
}
