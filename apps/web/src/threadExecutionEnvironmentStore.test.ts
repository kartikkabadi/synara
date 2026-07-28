// FILE: threadExecutionEnvironmentStore.test.ts
// Purpose: Selection store + execution profile builder behavior.

import type { EnvironmentId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildThreadExecutionProfile,
  useThreadExecutionEnvironmentStore,
} from "./threadExecutionEnvironmentStore";

const threadId = "thread-1" as ThreadId;
const environmentId = "env-1" as EnvironmentId;

beforeEach(() => {
  useThreadExecutionEnvironmentStore.setState({
    selectionByThreadId: {},
    lastUsedSelection: null,
  });
});

describe("threadExecutionEnvironmentStore", () => {
  it("omits the execution profile when no environment is selected", () => {
    expect(buildThreadExecutionProfile(threadId, "codex")).toBeNull();
  });

  it("omits the execution profile when the workspace root is blank", () => {
    useThreadExecutionEnvironmentStore.getState().setThreadEnvironmentSelection(threadId, {
      environmentId,
      environmentLabel: "Build box",
      remoteWorkspaceRoot: "   ",
    });
    expect(buildThreadExecutionProfile(threadId, "codex")).toBeNull();
  });

  it("builds the profile from the selection and provider kind", () => {
    useThreadExecutionEnvironmentStore.getState().setThreadEnvironmentSelection(threadId, {
      environmentId,
      environmentLabel: "Build box",
      remoteWorkspaceRoot: " /srv/work ",
    });
    expect(buildThreadExecutionProfile(threadId, "claudeAgent")).toEqual({
      environmentId,
      providerKind: "claudeAgent",
      remoteWorkspaceRoot: "/srv/work",
    });
  });

  it("clears the selection back to Local and remembers the last-used selection", () => {
    const store = useThreadExecutionEnvironmentStore.getState();
    store.setThreadEnvironmentSelection(threadId, {
      environmentId,
      environmentLabel: "Build box",
      remoteWorkspaceRoot: "/srv/work",
    });
    useThreadExecutionEnvironmentStore.getState().setThreadEnvironmentSelection(threadId, null);
    const state = useThreadExecutionEnvironmentStore.getState();
    expect(state.selectionByThreadId[threadId]).toBeUndefined();
    expect(state.lastUsedSelection?.environmentId).toBe(environmentId);
    expect(buildThreadExecutionProfile(threadId, "codex")).toBeNull();
  });
});
