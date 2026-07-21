// FILE: islandWindow.ts
// Purpose: Owns the always-on-top island overlay window: creation, anchoring, click-through, shortcut.
// Layer: Desktop island (Electron main)

import * as FS from "node:fs";
import * as Path from "node:path";

import { BrowserWindow, globalShortcut, screen } from "electron";
import { Schema } from "effect";
import {
  DesktopIslandSettings,
  type IslandDisplayContext,
  type IslandWindowState,
} from "@synara/contracts";

import { ISLAND_IPC_CHANNELS } from "../ipcChannels";
import {
  detectNotch,
  islandStateBounds,
  islandWindowBounds,
  type IslandDisplayMetrics,
} from "./islandGeometry";

export const ISLAND_GLOBAL_SHORTCUT = "CommandOrControl+Shift+I";

const decodeIslandSettings = Schema.decodeUnknownSync(DesktopIslandSettings);

export function readStoredIslandEnabled(settingsPath: string): boolean | null {
  try {
    const raw = FS.readFileSync(settingsPath, "utf8");
    return decodeIslandSettings(JSON.parse(raw)).enabled;
  } catch {
    return null;
  }
}

export function writeStoredIslandEnabled(settingsPath: string, enabled: boolean): void {
  FS.mkdirSync(Path.dirname(settingsPath), { recursive: true });
  FS.writeFileSync(settingsPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

export interface IslandWindowManagerOptions {
  preloadPath: string;
  url: string;
  platform: NodeJS.Platform;
}

function primaryDisplayMetrics(): IslandDisplayMetrics {
  const display = screen.getPrimaryDisplay();
  return { bounds: display.bounds, workArea: display.workArea };
}

export class IslandWindowManager {
  #options: IslandWindowManagerOptions;
  #window: BrowserWindow | null = null;
  #state: IslandWindowState = "collapsed";
  #detachDisplayListeners: (() => void) | null = null;

  constructor(options: IslandWindowManagerOptions) {
    this.#options = options;
  }

  get window(): BrowserWindow | null {
    return this.#window;
  }

  get isLinux(): boolean {
    return this.#options.platform === "linux";
  }

  getContext(): IslandDisplayContext {
    const platform =
      this.#options.platform === "darwin"
        ? "macos"
        : this.#options.platform === "win32"
          ? "windows"
          : this.#options.platform === "linux"
            ? "linux"
            : "other";
    return { platform, notch: this.#detectNotch() };
  }

  #detectNotch() {
    return detectNotch(this.#options.platform, primaryDisplayMetrics());
  }

  create(): void {
    if (this.#window && !this.#window.isDestroyed()) return;

    const metrics = primaryDisplayMetrics();
    const notch = this.#detectNotch();
    const bounds = this.isLinux
      ? islandStateBounds(this.#state, metrics, notch, this.#options.platform)
      : islandWindowBounds(metrics, notch, this.#options.platform);

    const window = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      roundedCorners: false,
      show: false,
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.#window = window;

    // "screen-saver" keeps the island above macOS fullscreen spaces; on
    // Wayland always-on-top is unsupported and these calls degrade silently.
    try {
      window.setAlwaysOnTop(true, "screen-saver");
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } catch {
      // Best effort: the island still renders as a normal window.
    }

    // At rest the window ignores mouse events so it never blocks clicks on
    // whatever sits underneath. `forward` (macOS/Windows only) still delivers
    // move events so the renderer can toggle interactivity on hover. On Linux
    // the window only ever spans the pill, so click-through is skipped.
    if (!this.isLinux) {
      window.setIgnoreMouseEvents(true, { forward: true });
    }

    window.once("ready-to-show", () => {
      window.showInactive();
    });

    void window.loadURL(this.#options.url);

    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });

    this.#registerShortcut();
    this.#attachDisplayListeners();
  }

  destroy(): void {
    globalShortcut.unregister(ISLAND_GLOBAL_SHORTCUT);
    this.#detachDisplayListeners?.();
    this.#detachDisplayListeners = null;
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) {
      // The window is created `closable: false` to hide OS close affordances;
      // destroy() bypasses that flag.
      window.destroy();
    }
  }

  setIgnoreMouse(ignore: boolean): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || this.isLinux) return;
    window.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
  }

  setState(state: IslandWindowState): void {
    this.#state = state;
    if (!this.isLinux) return;
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    window.setBounds(
      islandStateBounds(
        state,
        primaryDisplayMetrics(),
        this.#detectNotch(),
        this.#options.platform,
      ),
    );
  }

  toggleExpanded(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    if (!window.isVisible()) window.showInactive();
    const next: IslandWindowState = this.#state === "expanded" ? "collapsed" : "expanded";
    this.setState(next);
    window.webContents.send(ISLAND_IPC_CHANNELS.stateChanged, next);
  }

  reanchor(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    const metrics = primaryDisplayMetrics();
    const notch = this.#detectNotch();
    window.setBounds(
      this.isLinux
        ? islandStateBounds(this.#state, metrics, notch, this.#options.platform)
        : islandWindowBounds(metrics, notch, this.#options.platform),
    );
  }

  #registerShortcut(): void {
    if (globalShortcut.isRegistered(ISLAND_GLOBAL_SHORTCUT)) return;
    try {
      globalShortcut.register(ISLAND_GLOBAL_SHORTCUT, () => this.toggleExpanded());
    } catch {
      // Shortcut registration can fail (e.g. Wayland); the pill stays clickable.
    }
  }

  #attachDisplayListeners(): void {
    if (this.#detachDisplayListeners) return;
    const reanchor = () => this.reanchor();
    screen.on("display-metrics-changed", reanchor);
    screen.on("display-added", reanchor);
    screen.on("display-removed", reanchor);
    this.#detachDisplayListeners = () => {
      screen.removeListener("display-metrics-changed", reanchor);
      screen.removeListener("display-added", reanchor);
      screen.removeListener("display-removed", reanchor);
    };
  }
}
