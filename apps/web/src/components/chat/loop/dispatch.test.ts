// FILE: dispatch.test.ts
// Purpose: Covers the shared loop dispatch → snapshot-sync path and the guided
// setup submit built on it.
// Layer: Web chat loop tests

import { describe, expect, it, vi } from "vitest";

import { ThreadId, LoopActivationId } from "@synara/contracts";

const dispatchCommand = vi.fn<(command: unknown) => Promise<void>>();
const getShellSnapshot = vi.fn<() => Promise<unknown>>();

vi.mock("../../../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand,
      getShellSnapshot,
    },
  }),
}));

import { dispatchLoopCommand, performLoopSetupSubmit } from "./dispatch";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const SNAPSHOT = { threads: [] };

function resetApi(): void {
  dispatchCommand.mockReset().mockResolvedValue(undefined);
  getShellSnapshot.mockReset().mockResolvedValue(SNAPSHOT);
}

describe("dispatchLoopCommand", () => {
  it("dispatches, then syncs the refreshed shell snapshot", async () => {
    resetApi();
    const synced: unknown[] = [];
    const onError = vi.fn();
    const ok = await dispatchLoopCommand({
      command: {
        type: "thread.loop.toggle",
        commandId: "cmd-1",
        threadId: THREAD_ID,
        createdAt: "2026-01-01T12:00:00.000Z",
      } as never,
      syncServerShellSnapshot: (snapshot) => synced.push(snapshot),
      onError,
    });
    expect(ok).toBe(true);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(synced).toEqual([SNAPSHOT]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports dispatch failures through onError without syncing", async () => {
    resetApi();
    const failure = new Error("server down");
    dispatchCommand.mockRejectedValue(failure);
    const synced: unknown[] = [];
    const onError = vi.fn();
    const ok = await dispatchLoopCommand({
      command: {
        type: "thread.loop.off",
        commandId: "cmd-1",
        threadId: THREAD_ID,
        createdAt: "2026-01-01T12:00:00.000Z",
      } as never,
      syncServerShellSnapshot: (snapshot) => synced.push(snapshot),
      onError,
    });
    expect(ok).toBe(false);
    expect(synced).toEqual([]);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe("performLoopSetupSubmit", () => {
  it("dispatches thread.loop.set with the trimmed prompt and budget", async () => {
    resetApi();
    const result = await performLoopSetupSubmit({
      threadId: THREAD_ID,
      objective: "  fix the tests  ",
      budget: { kind: "count", turns: 10 },
      syncServerShellSnapshot: () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.loop.set",
      threadId: THREAD_ID,
      prompt: "fix the tests",
      maxIterations: 10,
      durationSeconds: null,
    });
  });

  it("includes expectedActivationId when provided and omits it otherwise", async () => {
    resetApi();
    await performLoopSetupSubmit({
      threadId: THREAD_ID,
      objective: "fix the tests",
      budget: { kind: "count", turns: 10 },
      expectedActivationId: LoopActivationId.makeUnsafe("activation-1"),
      syncServerShellSnapshot: () => {},
    });
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      expectedActivationId: "activation-1",
    });

    resetApi();
    await performLoopSetupSubmit({
      threadId: THREAD_ID,
      objective: "fix the tests",
      budget: { kind: "count", turns: 10 },
      syncServerShellSnapshot: () => {},
    });
    expect(dispatchCommand.mock.calls[0]?.[0]).not.toHaveProperty("expectedActivationId");
  });

  it("returns the failure message on error", async () => {
    resetApi();
    dispatchCommand.mockRejectedValue(new Error("server down"));
    const result = await performLoopSetupSubmit({
      threadId: THREAD_ID,
      objective: "fix the tests",
      budget: { kind: "count", turns: 5 },
      syncServerShellSnapshot: () => {},
    });
    expect(result).toEqual({ ok: false, message: "server down" });
  });
});
