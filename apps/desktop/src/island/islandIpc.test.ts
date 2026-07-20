import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ISLAND_IPC_CHANNELS } from "../ipcChannels";
import { registerIslandIpcHandlers, type IslandIpcDelegate } from "./islandIpc";
import type { IslandWindowManager } from "./islandWindow";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function createFakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipcMain, handlers, invoke };
}

function createDelegate(manager: Partial<IslandWindowManager> | null = null) {
  return {
    getManager: () => manager as IslandWindowManager | null,
    getEnabled: vi.fn(() => true),
    setEnabled: vi.fn((enabled: boolean) => enabled),
    focusThread: vi.fn(),
  } satisfies IslandIpcDelegate;
}

describe("registerIslandIpcHandlers", () => {
  it("registers a handler for every island channel", () => {
    const { ipcMain, handlers } = createFakeIpcMain();
    registerIslandIpcHandlers(ipcMain, createDelegate());
    for (const channel of [
      ISLAND_IPC_CHANNELS.getContext,
      ISLAND_IPC_CHANNELS.setIgnoreMouse,
      ISLAND_IPC_CHANNELS.setState,
      ISLAND_IPC_CHANNELS.focusThread,
      ISLAND_IPC_CHANNELS.getEnabled,
      ISLAND_IPC_CHANNELS.setEnabled,
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it("forwards trimmed focus-thread requests and drops invalid ones", async () => {
    const { ipcMain, invoke } = createFakeIpcMain();
    const delegate = createDelegate();
    registerIslandIpcHandlers(ipcMain, delegate);

    await invoke(ISLAND_IPC_CHANNELS.focusThread, " thread-1 ");
    expect(delegate.focusThread).toHaveBeenCalledWith("thread-1");

    await invoke(ISLAND_IPC_CHANNELS.focusThread, "");
    await invoke(ISLAND_IPC_CHANNELS.focusThread, 42);
    expect(delegate.focusThread).toHaveBeenCalledTimes(1);
  });

  it("validates window states and ignore-mouse payloads before touching the manager", async () => {
    const { ipcMain, invoke } = createFakeIpcMain();
    const manager = { setState: vi.fn(), setIgnoreMouse: vi.fn() };
    registerIslandIpcHandlers(ipcMain, createDelegate(manager));

    await invoke(ISLAND_IPC_CHANNELS.setState, "expanded");
    await invoke(ISLAND_IPC_CHANNELS.setState, "bogus");
    expect(manager.setState).toHaveBeenCalledTimes(1);
    expect(manager.setState).toHaveBeenCalledWith("expanded");

    await invoke(ISLAND_IPC_CHANNELS.setIgnoreMouse, true);
    await invoke(ISLAND_IPC_CHANNELS.setIgnoreMouse, "yes");
    expect(manager.setIgnoreMouse).toHaveBeenNthCalledWith(1, true);
    expect(manager.setIgnoreMouse).toHaveBeenNthCalledWith(2, false);
  });

  it("routes the enable toggle through the delegate", async () => {
    const { ipcMain, invoke } = createFakeIpcMain();
    const delegate = createDelegate();
    registerIslandIpcHandlers(ipcMain, delegate);

    await expect(invoke(ISLAND_IPC_CHANNELS.getEnabled)).resolves.toBe(true);
    await expect(invoke(ISLAND_IPC_CHANNELS.setEnabled, true)).resolves.toBe(true);
    expect(delegate.setEnabled).toHaveBeenCalledWith(true);
    await expect(invoke(ISLAND_IPC_CHANNELS.setEnabled, "true")).resolves.toBe(false);
  });

  it("tolerates a missing manager", async () => {
    const { ipcMain, invoke } = createFakeIpcMain();
    registerIslandIpcHandlers(ipcMain, createDelegate(null));
    await expect(invoke(ISLAND_IPC_CHANNELS.getContext)).resolves.toBeUndefined();
    await expect(invoke(ISLAND_IPC_CHANNELS.setState, "hover")).resolves.toBeUndefined();
  });
});
