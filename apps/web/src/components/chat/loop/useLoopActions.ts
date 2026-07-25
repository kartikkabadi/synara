// FILE: useLoopActions.ts
// Purpose: `/loop` action dispatch for ChatView — stop controls, stop-error
// toasts, and new-chat thread promotion before a loop can start.
// Layer: Web chat controller hook (no JSX)

import {
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { useCallback, useRef } from "react";
import { isLoopOwnedTurnRunning } from "./presentation";
import { useLoopStopErrorToast } from "./useLoopStopErrorToast";
import { toastManager } from "../../ui/toast";
import { promoteThreadCreate } from "../../../lib/threadCreatePromotion";
import { newCommandId } from "../../../lib/utils";
import { readNativeApi } from "../../../nativeApi";
import type { Project, Thread } from "../../../types";

export interface UseLoopActionsInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  isServerThread: boolean;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}

export interface LoopActions {
  // Stop after this turn: disable future iterations; the running turn finishes.
  stopAfterTurn: () => Promise<void>;
  // Stop now: interrupt the running loop-owned turn (the decider atomically
  // turns the loop off); fall back to a plain loop-off when no concrete turn exists.
  stopNow: () => Promise<void>;
  // Promotes a local new-chat draft to a server thread before a loop can be
  // set on it. Shared by direct `/loop 5 fix tests` starts and guided setup.
  ensureLoopThreadReady: (titleSeed: string) => Promise<boolean>;
}

function addStopLoopErrorToast(error: unknown): void {
  toastManager.add({
    type: "error",
    title: "Could not stop Loop",
    description:
      error instanceof Error ? error.message : "An error occurred while stopping the loop.",
  });
}

export function useLoopActions(input: UseLoopActionsInput): LoopActions {
  const {
    threadId,
    activeThread,
    activeProject,
    isServerThread,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    syncServerShellSnapshot,
  } = input;

  // Guards both stop controls so repeated clicks dispatch a single command.
  const stopDispatchInFlightRef = useRef(false);

  const stopAfterTurn = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || activeThread.loop?.active !== true) {
      return;
    }
    if (stopDispatchInFlightRef.current) {
      return;
    }
    stopDispatchInFlightRef.current = true;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.loop.off",
        commandId: newCommandId(),
        threadId: activeThread.id,
        createdAt: new Date().toISOString(),
      });
      const snapshot = await api.orchestration.getShellSnapshot();
      syncServerShellSnapshot(snapshot);
    } catch (error) {
      addStopLoopErrorToast(error);
    } finally {
      stopDispatchInFlightRef.current = false;
    }
  }, [activeThread, syncServerShellSnapshot]);

  const stopNow = useCallback(async () => {
    const api = readNativeApi();
    const loop = activeThread?.loop;
    if (!api || !activeThread || loop == null) {
      return;
    }
    if (stopDispatchInFlightRef.current) {
      return;
    }
    stopDispatchInFlightRef.current = true;
    try {
      if (isLoopOwnedTurnRunning(loop, activeThread.latestTurn)) {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: newCommandId(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
        });
      } else if (loop.active) {
        await api.orchestration.dispatchCommand({
          type: "thread.loop.off",
          commandId: newCommandId(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
        });
      }
      const snapshot = await api.orchestration.getShellSnapshot();
      syncServerShellSnapshot(snapshot);
    } catch (error) {
      addStopLoopErrorToast(error);
    } finally {
      stopDispatchInFlightRef.current = false;
    }
  }, [activeThread, syncServerShellSnapshot]);

  const ensureLoopThreadReady = useCallback(
    async (titleSeed: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeProject || !activeThread) {
        return false;
      }
      if (isServerThread) {
        return true;
      }
      try {
        const result = await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId,
            projectId: activeProject.id,
            title: buildPromptThreadTitleFallback(titleSeed),
            modelSelection: selectedModelSelection,
            runtimeMode,
            interactionMode,
            envMode: activeThread.envMode ?? "local",
            branch: activeThread.branch,
            worktreePath: activeThread.worktreePath,
            associatedWorktreePath: activeThread.associatedWorktreePath ?? null,
            associatedWorktreeBranch: activeThread.associatedWorktreeBranch ?? null,
            associatedWorktreeRef: activeThread.associatedWorktreeRef ?? null,
            lastKnownPr: activeThread.lastKnownPr ?? null,
            createdAt: new Date().toISOString(),
          },
          api,
          { force: true },
        );
        return result !== "unavailable";
      } catch {
        return false;
      }
    },
    [
      activeProject,
      activeThread,
      interactionMode,
      isServerThread,
      runtimeMode,
      selectedModelSelection,
      threadId,
    ],
  );

  // One error toast for exceptional loop auto-stops (repeated errors, invalid
  // saved objective, unavailable thread); routine stops stay toast-free.
  const addLoopStopErrorToast = useCallback(
    (toast: { title: string; description: string; threadId: ThreadId | null }) => {
      toastManager.add({
        type: "error",
        title: toast.title,
        description: toast.description,
        data: { threadId: toast.threadId },
      });
    },
    [],
  );
  useLoopStopErrorToast(
    activeThread?.id ?? null,
    activeThread?.loop ?? null,
    addLoopStopErrorToast,
  );

  return { stopAfterTurn, stopNow, ensureLoopThreadReady };
}
