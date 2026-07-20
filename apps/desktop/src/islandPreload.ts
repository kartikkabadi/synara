// FILE: islandPreload.ts
// Purpose: Minimal contextBridge for the island overlay window.
// Layer: Desktop preload

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, IslandBridge, IslandWindowState } from "@synara/contracts";

import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const IPC = DESKTOP_IPC_CHANNELS;

function getDesktopWsUrl(): string | null {
  try {
    const ipcWsUrl = normalizeDesktopWsUrl(ipcRenderer.sendSync(IPC.wsUrl));
    return ipcWsUrl ?? resolveDesktopWsUrlFromEnv(process.env);
  } catch {
    return resolveDesktopWsUrlFromEnv(process.env);
  }
}

// The island window only needs the WebSocket URL from the main desktop bridge;
// exposing it under the same name lets the shared web transport code work
// unchanged inside the island renderer. `setTheme` is a no-op: the overlay has
// no native window chrome to theme, but shared web code may still call it.
contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: getDesktopWsUrl,
  setTheme: async () => {},
} satisfies Pick<DesktopBridge, "getWsUrl" | "setTheme">);

contextBridge.exposeInMainWorld("islandBridge", {
  getContext: () => ipcRenderer.invoke(IPC.island.getContext),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke(IPC.island.setIgnoreMouse, ignore),
  setState: (state) => ipcRenderer.invoke(IPC.island.setState, state),
  focusThread: (threadId) => ipcRenderer.invoke(IPC.island.focusThread, threadId),
  onStateChanged: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state !== "collapsed" && state !== "hover" && state !== "expanded") return;
      listener(state as IslandWindowState);
    };
    ipcRenderer.on(IPC.island.stateChanged, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.island.stateChanged, wrappedListener);
    };
  },
} satisfies IslandBridge);
