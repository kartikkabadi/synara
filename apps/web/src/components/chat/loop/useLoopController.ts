// FILE: useLoopController.ts
// Purpose: Single `/loop` facade for ChatView — combines stop/start actions,
// the guided composer mode, and per-thread lifecycle resets.
// Layer: Web chat controller hook (no JSX)

import {
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ThreadLoop,
} from "@synara/contracts";
import { useEffect } from "react";
import {
  isUnsupportedLoopContext,
  type LoopUnsupportedContextInput,
} from "../../../lib/loop";
import type { Project, Thread } from "../../../types";
import { isLoopOwnedTurnRunning } from "./presentation";
import { useLoopActions } from "./useLoopActions";
import { useLoopComposerMode, type LoopComposerController } from "./useLoopComposerMode";

export interface UseLoopControllerInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  isServerThread: boolean;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  // The approval composer takes over the surface; loop setup closes rather
  // than staying hidden-but-armed behind the approval flow.
  isComposerApprovalState: boolean;
  unsupportedContext: LoopUnsupportedContextInput;
  composer: {
    objective: string;
    setObjective: (value: string) => void;
    clearObjective: () => void;
    focusEditor: () => void;
  };
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}

export interface LoopController {
  composerMode: LoopComposerController;
  actions: {
    stopAfterTurn: () => Promise<void>;
    stopNow: () => Promise<void>;
  };
  ensureLoopThreadReady: (titleSeed: string) => Promise<boolean>;
  isLoopOwnedTurnActive: boolean;
  activeLoop: ThreadLoop | null;
  hasUnsupportedContext: boolean;
}

export function useLoopController(input: UseLoopControllerInput): LoopController {
  const {
    threadId,
    activeThread,
    activeProject,
    isServerThread,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    isComposerApprovalState,
    unsupportedContext,
    composer,
    syncServerShellSnapshot,
  } = input;

  const activeLoop = activeThread?.loop ?? null;
  const hasUnsupportedContext = isUnsupportedLoopContext(unsupportedContext);

  const { stopAfterTurn, stopNow, ensureLoopThreadReady } = useLoopActions({
    threadId,
    activeThread,
    activeProject,
    isServerThread,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    syncServerShellSnapshot,
  });

  const composerMode = useLoopComposerMode({
    threadId,
    activeLoop,
    hasUnsupportedContext,
    objective: composer.objective,
    setObjective: composer.setObjective,
    clearObjective: composer.clearObjective,
    focusEditor: composer.focusEditor,
    syncServerShellSnapshot,
    ensureThreadReady: ensureLoopThreadReady,
  });

  // Loop setup/edit is per-thread state: close it when the thread changes so
  // a mode opened on one thread never dispatches against another.
  const composerModeReset = composerMode.reset;
  useEffect(() => {
    composerModeReset();
  }, [threadId, composerModeReset]);
  useEffect(() => {
    if (isComposerApprovalState) {
      composerModeReset();
    }
  }, [isComposerApprovalState, composerModeReset]);

  const isLoopOwnedTurnActive =
    activeLoop != null && isLoopOwnedTurnRunning(activeLoop, activeThread?.latestTurn);

  return {
    composerMode,
    actions: { stopAfterTurn, stopNow },
    ensureLoopThreadReady,
    isLoopOwnedTurnActive,
    activeLoop,
    hasUnsupportedContext,
  };
}
