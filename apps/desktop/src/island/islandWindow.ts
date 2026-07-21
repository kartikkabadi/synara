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
  islandSurfaceRect,
  islandWindowBounds,
  type IslandDisplayMetrics,
} from "./islandGeometry";

export const ISLAND_GLOBAL_SHORTCUT = "CommandOrControl+Shift+I";

// Linux click-through: setIgnoreMouseEvents has no `forward` there, so the
// main process polls the cursor against the current surface rect instead.
export const LINUX_CURSOR_POLL_MS = 100;
// Must exceed the poll interval or the grace window can never elapse a poll.
export const LINUX_CURSOR_EXIT_GRACE_MS = 250;

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
  // Atomic replace so a crash mid-write cannot leave a truncated settings file.
  const tempPath = `${settingsPath}.tmp`;
  FS.writeFileSync(tempPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
  FS.renameSync(tempPath, settingsPath);
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
  #sessionCount = 0;
  #detachDisplayListeners: (() => void) | null = null;
  #cursorPoll: ReturnType<typeof setInterval> | null = null;
  #cursorInteractive = false;
  #cursorExitAt: number | null = null;
  #ownsShortcut = false;

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
    const bounds = islandWindowBounds(metrics, notch, this.#options.platform);

    const window = new BrowserWindow({
      ...bounds,
      // X11 treats toolbar windows as undecorated utility surfaces.
      ...(this.isLinux ? { type: "toolbar" } : {}),
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
    // forwarding is unsupported, so a main-process cursor poll toggles
    // interactivity against the current surface rect instead.
    window.setIgnoreMouseEvents(true, this.isLinux ? undefined : { forward: true });
    if (this.isLinux) this.#startCursorPoll();

    // The overlay only ever renders the bundled island route: deny popups,
    // block navigation elsewhere, and reload after a renderer crash.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== this.#options.url) event.preventDefault();
    });
    window.webContents.on("render-process-gone", () => {
      if (this.#window === window && !window.isDestroyed()) {
        void window.loadURL(this.#options.url);
      }
    });

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
    if (this.#ownsShortcut) {
      globalShortcut.unregister(ISLAND_GLOBAL_SHORTCUT);
      this.#ownsShortcut = false;
    }
    this.#detachDisplayListeners?.();
    this.#detachDisplayListeners = null;
    this.#stopCursorPoll();
    this.#state = "collapsed";
    this.#sessionCount = 0;
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

  // Pure bookkeeping: the window never resizes per state; state + sessionCount
  // only feed the Linux cursor-rect math.
  setState(state: IslandWindowState, sessionCount?: number): void {
    this.#state = state;
    if (sessionCount !== undefined) this.#sessionCount = sessionCount;
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
    // Single setBounds call (never setPosition alone) so WMs that re-clamp
    // size on move cannot drift the window.
    window.setBounds(islandWindowBounds(metrics, notch, this.#options.platform));
  }

  #startCursorPoll(): void {
    if (this.#cursorPoll) return;
    this.#cursorPoll = setInterval(() => this.#pollCursor(), LINUX_CURSOR_POLL_MS);
  }

  #stopCursorPoll(): void {
    if (this.#cursorPoll) clearInterval(this.#cursorPoll);
    this.#cursorPoll = null;
    this.#cursorInteractive = false;
    this.#cursorExitAt = null;
  }

  #pollCursor(): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    const rect = islandSurfaceRect(
      this.#state,
      primaryDisplayMetrics(),
      this.#detectNotch(),
      this.#options.platform,
      this.#sessionCount,
    );
    const cursor = screen.getCursorScreenPoint();
    const inside =
      cursor.x >= rect.x &&
      cursor.x < rect.x + rect.width &&
      cursor.y >= rect.y &&
      cursor.y < rect.y + rect.height;
    if (inside) {
      this.#cursorExitAt = null;
      if (!this.#cursorInteractive) {
        this.#cursorInteractive = true;
        window.setIgnoreMouseEvents(false);
      }
      return;
    }
    if (!this.#cursorInteractive) return;
    const now = Date.now();
    if (this.#cursorExitAt === null) {
      this.#cursorExitAt = now;
      return;
    }
    if (now - this.#cursorExitAt < LINUX_CURSOR_EXIT_GRACE_MS) return;
    this.#cursorExitAt = null;
    this.#cursorInteractive = false;
    window.setIgnoreMouseEvents(true);
  }

  #registerShortcut(): void {
    if (this.#ownsShortcut || globalShortcut.isRegistered(ISLAND_GLOBAL_SHORTCUT)) return;
    try {
      this.#ownsShortcut = globalShortcut.register(ISLAND_GLOBAL_SHORTCUT, () =>
        this.toggleExpanded(),
      );
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
