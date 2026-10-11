// FILE: threadExecutionEnvironmentStore.ts
// Purpose: Per-thread remote execution environment selection for the composer.
// Layer: Web session state (in-memory only; selection applies at thread start)
// Exports: useThreadExecutionEnvironmentStore, ThreadEnvironmentSelection

import {
  AbsolutePosixPath,
  type EnvironmentId,
  type ExecutionProfile,
  type ProviderKind,
  type ThreadId,
} from "@synara/contracts";
import { Schema } from "effect";
import { create } from "zustand";

export interface ThreadEnvironmentSelection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly remoteWorkspaceRoot: string;
}

interface ThreadExecutionEnvironmentState {
  selectionByThreadId: Readonly<Record<ThreadId, ThreadEnvironmentSelection>>;
  // Remembers the workspace when this environment is explicitly selected again.
  lastUsedSelection: ThreadEnvironmentSelection | null;
  setThreadEnvironmentSelection: (
    threadId: ThreadId,
    selection: ThreadEnvironmentSelection | null,
  ) => void;
}

export const useThreadExecutionEnvironmentStore = create<ThreadExecutionEnvironmentState>()(
  (set) => ({
    selectionByThreadId: {},
    lastUsedSelection: null,
    setThreadEnvironmentSelection: (threadId, selection) =>
      set((state) => {
        if (selection === null) {
          if (!(threadId in state.selectionByThreadId)) {
            return state;
          }
          const next = { ...state.selectionByThreadId };
          delete next[threadId];
          return { selectionByThreadId: next };
        }
        return {
          selectionByThreadId: { ...state.selectionByThreadId, [threadId]: selection },
          lastUsedSelection: selection,
        };
      }),
  }),
);

export function readThreadEnvironmentSelection(
  threadId: ThreadId,
): ThreadEnvironmentSelection | null {
  return useThreadExecutionEnvironmentStore.getState().selectionByThreadId[threadId] ?? null;
}

/** Builds the turn-start `executionProfile`; null when the thread runs locally. */
export function buildThreadExecutionProfile(
  threadId: ThreadId,
  providerKind: ProviderKind,
): ExecutionProfile | null {
  const selection = readThreadEnvironmentSelection(threadId);
  if (!selection) return null;
  if (providerKind !== "codex") {
    throw new Error("Remote execution supports Codex only. Choose Codex or This machine.");
  }
  const remoteWorkspaceRoot = selection.remoteWorkspaceRoot.trim();
  if (!Schema.is(AbsolutePosixPath)(remoteWorkspaceRoot)) {
    throw new Error("Enter an absolute remote workspace path before sending.");
  }
  return {
    environmentId: selection.environmentId,
    providerKind,
    remoteWorkspaceRoot,
  };
}
