// FILE: islandIpc.ts
// Purpose: Centralizes island IPC handlers: window state, click-through, enable toggle, focus-thread.
// Layer: Desktop IPC adapter

import type { IpcMain } from "electron";
import type { IslandWindowState } from "@synara/contracts";

import { ISLAND_IPC_CHANNELS } from "../ipcChannels";
import type { IslandWindowManager } from "./islandWindow";

const ISLAND_WINDOW_STATES: ReadonlySet<string> = new Set(["collapsed", "hover", "expanded"]);

export interface IslandIpcDelegate {
  getManager: () => IslandWindowManager | null;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  focusThread: (threadId: string) => void;
  stopLoop: (threadId: string) => void;
}

export function registerIslandIpcHandlers(ipcMain: IpcMain, delegate: IslandIpcDelegate): void {
  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.getContext);
  ipcMain.handle(ISLAND_IPC_CHANNELS.getContext, async () => delegate.getManager()?.getContext());

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.setIgnoreMouse);
  ipcMain.handle(ISLAND_IPC_CHANNELS.setIgnoreMouse, async (_event, ignore: unknown) => {
    delegate.getManager()?.setIgnoreMouse(ignore === true);
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.setState);
  ipcMain.handle(ISLAND_IPC_CHANNELS.setState, async (_event, state: unknown) => {
    if (typeof state === "string" && ISLAND_WINDOW_STATES.has(state)) {
      delegate.getManager()?.setState(state as IslandWindowState);
    }
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.focusThread);
  ipcMain.handle(ISLAND_IPC_CHANNELS.focusThread, async (_event, threadId: unknown) => {
    if (typeof threadId === "string" && threadId.trim().length > 0) {
      delegate.focusThread(threadId.trim());
    }
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.stopLoop);
  ipcMain.handle(ISLAND_IPC_CHANNELS.stopLoop, async (_event, threadId: unknown) => {
    if (typeof threadId === "string" && threadId.trim().length > 0) {
      delegate.stopLoop(threadId.trim());
    }
  });

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.getEnabled);
  ipcMain.handle(ISLAND_IPC_CHANNELS.getEnabled, async () => delegate.getEnabled());

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.setEnabled);
  ipcMain.handle(ISLAND_IPC_CHANNELS.setEnabled, async (_event, enabled: unknown) =>
    delegate.setEnabled(enabled === true),
  );
}
