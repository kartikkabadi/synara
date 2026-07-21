// FILE: islandIpc.ts
// Purpose: Centralizes island IPC handlers: window state, click-through, enable toggle, focus-thread.
// Layer: Desktop IPC adapter

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { IslandWindowState } from "@synara/contracts";

import { ISLAND_IPC_CHANNELS } from "../ipcChannels";
import type { IslandWindowManager } from "./islandWindow";

const ISLAND_WINDOW_STATES: ReadonlySet<string> = new Set(["collapsed", "hover", "expanded"]);

export interface IslandIpcDelegate {
  getManager: () => IslandWindowManager | null;
  isTrustedAppSender: (sender: WebContents) => boolean;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  focusThread: (threadId: string) => void;
  stopLoop: (threadId: string) => void;
}

export function registerIslandIpcHandlers(ipcMain: IpcMain, delegate: IslandIpcDelegate): void {
  // The preload checks nothing itself, so the main process is the trust
  // boundary. Island-only channels (state, click-through, focus, stop) accept
  // only the island window's own webContents; the enable toggle is also
  // reachable from trusted app renderers such as the main window's settings.
  const senderIsIslandContents = (event: IpcMainInvokeEvent): boolean => {
    const islandContents = delegate.getManager()?.window?.webContents ?? null;
    return islandContents !== null && event.sender === islandContents;
  };
  const isIslandSender = (event: IpcMainInvokeEvent): boolean => {
    if (senderIsIslandContents(event)) return true;
    console.warn("[island] rejected IPC from a non-island sender");
    return false;
  };
  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    if (senderIsIslandContents(event)) return true;
    if (delegate.isTrustedAppSender(event.sender)) return true;
    console.warn("[island] rejected IPC from an untrusted sender");
    return false;
  };

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.getContext);
  ipcMain.handle(ISLAND_IPC_CHANNELS.getContext, async (event) => {
    if (!isIslandSender(event)) return null;
    return delegate.getManager()?.getContext() ?? null;
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.setIgnoreMouse);
  ipcMain.handle(ISLAND_IPC_CHANNELS.setIgnoreMouse, async (event, ignore: unknown) => {
    if (!isIslandSender(event)) return;
    delegate.getManager()?.setIgnoreMouse(ignore === true);
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.setState);
  ipcMain.handle(ISLAND_IPC_CHANNELS.setState, async (event, state: unknown, meta: unknown) => {
    if (!isIslandSender(event)) return;
    if (typeof state === "string" && ISLAND_WINDOW_STATES.has(state)) {
      const rawCount =
        typeof meta === "object" && meta !== null
          ? (meta as { sessionCount?: unknown }).sessionCount
          : undefined;
      const sessionCount =
        typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0
          ? rawCount
          : undefined;
      delegate.getManager()?.setState(state as IslandWindowState, sessionCount);
    }
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.focusThread);
  ipcMain.handle(ISLAND_IPC_CHANNELS.focusThread, async (event, threadId: unknown) => {
    if (!isIslandSender(event)) return;
    if (typeof threadId === "string" && threadId.trim().length > 0) {
      delegate.focusThread(threadId.trim());
    }
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.stopLoop);
  ipcMain.handle(ISLAND_IPC_CHANNELS.stopLoop, async (event, threadId: unknown) => {
    if (!isIslandSender(event)) return;
    if (typeof threadId === "string" && threadId.trim().length > 0) {
      delegate.stopLoop(threadId.trim());
    }
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.getEnabled);
  ipcMain.handle(ISLAND_IPC_CHANNELS.getEnabled, async (event) => {
    if (!isTrustedSender(event)) return;
    return delegate.getEnabled();
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.setEnabled);
  ipcMain.handle(ISLAND_IPC_CHANNELS.setEnabled, async (event, enabled: unknown) => {
    if (!isTrustedSender(event)) return;
    return delegate.setEnabled(enabled === true);
  });
}
