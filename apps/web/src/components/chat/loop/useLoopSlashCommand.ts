// FILE: useLoopSlashCommand.ts
// Purpose: `/loop` slash-command handling — menu selection, parse-error toasts,
// the active-loop toggle shortcut, and validated direct starts.
// Layer: Web chat controller hook (no JSX)
// useComposerSlashCommands routes `/loop` invocations here.

import { type OrchestrationShellSnapshot, type ThreadId } from "@synara/contracts";
import { type LoopBudget, type LoopParseErrorReason } from "@synara/shared/loop";
import { useCallback } from "react";
import {
  LOOP_DEFAULT_BUDGET_CHOICE,
  interpretLoopInvocation,
  loopBudgetChoiceFromParsed,
  type LoopBudgetChoice,
  type LoopSetupNote,
} from "../../../lib/loop";
import { newCommandId } from "../../../lib/utils";
import { toastManager } from "../../ui/toast";
import type { Project, Thread } from "../../../types";
import { buildLoopSetCommand, dispatchLoopCommand } from "./dispatch";

export function formatLoopParseError(reason: LoopParseErrorReason): string {
  switch (reason) {
    case "missing_budget":
      return "Add a budget first, e.g. /loop 10 fix the tests or /loop 30m.";
    case "invalid_budget":
      return "That budget isn't valid. Use a count up to 100 (/loop 10) or a duration (/loop 30m, /loop 2h).";
    case "ambiguous_second_budget":
      return "The objective can't start with a second budget. Quote or reword it, e.g. /loop 10 run 5 checks.";
    case "prompt_starts_with_slash":
      return "The loop objective can't start with a slash. Try /loop 10 fix the tests.";
    case "prompt_too_long":
      return "That loop objective is too long. Shorten it and try again.";
    default:
      return reason satisfies never;
  }
}

export type LoopSetupOptions = {
  budget: LoopBudgetChoice;
  objective: string;
  note: LoopSetupNote | null;
};

// Selecting Loop from the command menu: active loop opens Edit Loop mode (it
// never stops the running loop); inactive selection opens guided setup.
export function resolveLoopMenuSelection(
  loopActive: boolean,
): { kind: "edit" } | { kind: "setup"; options: LoopSetupOptions } {
  return loopActive
    ? { kind: "edit" }
    : {
        kind: "setup",
        options: { budget: LOOP_DEFAULT_BUDGET_CHOICE, objective: "", note: null },
      };
}

// Parse errors stay recoverable: the toast carries a Configure Loop action
// that reopens guided setup with the typed objective prefilled.
export function buildLoopParseErrorToast(
  trimmed: string,
  reason: LoopParseErrorReason,
  openLoopSetup: (options: LoopSetupOptions) => void,
): {
  type: "warning";
  title: string;
  description: string;
  actionProps: { children: string; onClick: () => void };
} {
  const args = trimmed
    .trimStart()
    .replace(/^\/loop/i, "")
    .trim();
  return {
    type: "warning",
    title: "Invalid Loop budget",
    description: formatLoopParseError(reason),
    actionProps: {
      children: "Configure Loop",
      onClick: () => {
        openLoopSetup({ budget: LOOP_DEFAULT_BUDGET_CHOICE, objective: args, note: null });
      },
    },
  };
}

export interface UseLoopSlashCommandInput {
  threadId: ThreadId;
  activeProject: Project | undefined;
  activeThread: Thread | undefined;
  hasUnsupportedLoopContext: boolean;
  openLoopSetup: (options: LoopSetupOptions) => void;
  ensureLoopThreadReady: (titleSeed: string) => Promise<boolean>;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  editorActions: {
    clearComposerSlashDraft: () => void;
    setComposerPromptValue: (nextPrompt: string) => void;
  };
}

export function useLoopSlashCommand(input: UseLoopSlashCommandInput): {
  runLoopSlashCommand: (trimmed: string) => Promise<void>;
} {
  const {
    threadId,
    activeProject,
    activeThread,
    hasUnsupportedLoopContext,
    openLoopSetup,
    ensureLoopThreadReady,
    syncServerShellSnapshot,
    editorActions,
  } = input;

  // Active bare `/loop` retains the backend toggle shortcut: disable future
  // iterations while letting a currently running turn finish.
  const toggleActiveLoop = useCallback(
    async (trimmed: string) => {
      if (!activeThread) {
        return;
      }
      editorActions.clearComposerSlashDraft();
      await dispatchLoopCommand({
        command: {
          type: "thread.loop.toggle",
          commandId: newCommandId(),
          threadId,
          createdAt: new Date().toISOString(),
        },
        syncServerShellSnapshot,
        onError: () => {
          editorActions.setComposerPromptValue(trimmed);
          toastManager.add({
            type: "error",
            title: "Could not stop Loop",
            description: "Couldn't stop the loop. Try again.",
          });
        },
      });
    },
    [activeThread, editorActions, syncServerShellSnapshot, threadId],
  );

  // Power-user fast path: `/loop 5 fix the tests` starts immediately after
  // validation, reusing new-chat thread promotion via ensureLoopThreadReady.
  // Direct starts enforce the same text-only contract as guided setup: any
  // unsupported context routes into setup with the objective prefilled.
  const startLoopDirect = useCallback(
    async (trimmed: string, budget: LoopBudget, prompt: string) => {
      if (hasUnsupportedLoopContext) {
        openLoopSetup({
          budget: loopBudgetChoiceFromParsed(budget),
          objective: prompt,
          note: "unsupported-context",
        });
        return;
      }

      const ready = await ensureLoopThreadReady(prompt);
      if (!ready) {
        toastManager.add({
          type: "error",
          title: "Could not start Loop",
          description: "The thread isn't ready yet. Your objective has been preserved.",
        });
        return;
      }

      editorActions.clearComposerSlashDraft();
      await dispatchLoopCommand({
        command: buildLoopSetCommand({
          threadId,
          objective: prompt,
          budget: loopBudgetChoiceFromParsed(budget),
        }),
        syncServerShellSnapshot,
        onError: (error) => {
          editorActions.setComposerPromptValue(trimmed);
          toastManager.add({
            type: "error",
            title: "Could not start Loop",
            description:
              error instanceof Error
                ? `${error.message} Your objective has been preserved.`
                : "An error occurred while starting the loop. Your objective has been preserved.",
          });
        },
      });
    },
    [
      editorActions,
      ensureLoopThreadReady,
      hasUnsupportedLoopContext,
      openLoopSetup,
      syncServerShellSnapshot,
      threadId,
    ],
  );

  const runLoopSlashCommand = useCallback(
    async (trimmed: string) => {
      if (!activeProject || !activeThread) {
        toastManager.add({
          type: "warning",
          title: "Loop is unavailable",
          description: "Open a thread before starting a loop.",
        });
        return;
      }
      if (activeThread.parentThreadId != null) {
        toastManager.add({
          type: "warning",
          title: "Loop is unavailable",
          description: "Loops are only allowed on top-level threads.",
        });
        return;
      }

      const interpretation = interpretLoopInvocation(trimmed, {
        loopActive: activeThread.loop?.active === true,
      });
      switch (interpretation.kind) {
        case "not-loop":
          return;
        case "reject":
          toastManager.add(buildLoopParseErrorToast(trimmed, interpretation.reason, openLoopSetup));
          return;
        case "toggle-off":
          await toggleActiveLoop(trimmed);
          return;
        case "start-direct":
          await startLoopDirect(trimmed, interpretation.budget, interpretation.prompt);
          return;
        case "open-setup":
          openLoopSetup({
            budget: interpretation.budget,
            objective: interpretation.objective,
            note: interpretation.note,
          });
          return;
        default:
          return interpretation satisfies never;
      }
    },
    [activeProject, activeThread, openLoopSetup, startLoopDirect, toggleActiveLoop],
  );

  return { runLoopSlashCommand };
}
