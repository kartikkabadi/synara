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

  it.each(["", "   ", "repo", "~/repo", "/", "/srv/../other", "/srv//repo", "/srv/repo/"])(
    "rejects invalid remote workspace %j instead of falling back to local",
    (remoteWorkspaceRoot) => {
      useThreadExecutionEnvironmentStore.getState().setThreadEnvironmentSelection(threadId, {
        environmentId,
        environmentLabel: "Build box",
        remoteWorkspaceRoot,
      });
      expect(() => buildThreadExecutionProfile(threadId, "codex")).toThrow(
        "absolute remote workspace path",
      );
    },
  );

  it("builds the profile from the selection and provider kind", () => {
    useThreadExecutionEnvironmentStore.getState().setThreadEnvironmentSelection(threadId, {
      environmentId,
      environmentLabel: "Build box",
      remoteWorkspaceRoot: " /srv/work ",
    });
    expect(buildThreadExecutionProfile(threadId, "codex")).toEqual({
      environmentId,
      providerKind: "codex",
      remoteWorkspaceRoot: "/srv/work",
    });
  });

  it("rejects an unsupported provider without losing the remote choice", () => {
    useThreadExecutionEnvironmentStore.getState().setThreadEnvironmentSelection(threadId, {
      environmentId,
      environmentLabel: "Build box",
      remoteWorkspaceRoot: "/srv/work",
    });
    expect(() => buildThreadExecutionProfile(threadId, "claudeAgent")).toThrow("Codex only");
    expect(buildThreadExecutionProfile(threadId, "codex")?.environmentId).toBe(environmentId);
    expect(buildThreadExecutionProfile("thread-2" as ThreadId, "codex")).toBeNull();
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
