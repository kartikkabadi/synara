import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const globalShortcutMock = vi.hoisted(() => ({
  register: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true),
  unregister: vi.fn<(accelerator: string) => void>(),
  isRegistered: vi.fn<(accelerator: string) => boolean>(() => false),
}));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    showInactive = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    once = vi.fn();
    on = vi.fn();
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => true);
    destroy = vi.fn();
    setBounds = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }));
    webContents = { send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() };
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    globalShortcut: globalShortcutMock,
    screen: {
      getPrimaryDisplay: () => ({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
  };
});

import { ISLAND_IPC_CHANNELS } from "../ipcChannels";
import {
  ISLAND_GLOBAL_SHORTCUT,
  IslandWindowManager,
  readStoredIslandEnabled,
  writeStoredIslandEnabled,
} from "./islandWindow";

function createManager() {
  return new IslandWindowManager({
    platform: "win32",
    preloadPath: "/tmp/preload.js",
    url: "http://localhost/#/island",
  });
}

describe("IslandWindowManager global shortcut ownership", () => {
  beforeEach(() => {
    globalShortcutMock.register.mockClear().mockReturnValue(true);
    globalShortcutMock.unregister.mockClear();
    globalShortcutMock.isRegistered.mockClear().mockReturnValue(false);
  });

  it("unregisters on destroy only when it registered the accelerator", () => {
    const manager = createManager();
    manager.create();
    expect(globalShortcutMock.register).toHaveBeenCalledWith(
      ISLAND_GLOBAL_SHORTCUT,
      expect.any(Function),
    );
    manager.destroy();
    expect(globalShortcutMock.unregister).toHaveBeenCalledWith(ISLAND_GLOBAL_SHORTCUT);
  });

  it("does not unregister an accelerator owned by another feature", () => {
    globalShortcutMock.isRegistered.mockReturnValue(true);
    const manager = createManager();
    manager.create();
    expect(globalShortcutMock.register).not.toHaveBeenCalled();
    manager.destroy();
    expect(globalShortcutMock.unregister).not.toHaveBeenCalled();
  });

  it("does not unregister when register() reported failure", () => {
    globalShortcutMock.register.mockReturnValue(false);
    const manager = createManager();
    manager.create();
    manager.destroy();
    expect(globalShortcutMock.unregister).not.toHaveBeenCalled();
  });
});

describe("IslandWindowManager shortcut toggle", () => {
  it("sends a toggle request instead of computing the next state in main", () => {
    const manager = createManager();
    manager.create();
    const send = (manager.window as unknown as { webContents: { send: ReturnType<typeof vi.fn> } })
      .webContents.send;
    send.mockClear();
    manager.setState("expanded");
    manager.toggleExpanded();
    manager.toggleExpanded();
    expect(send.mock.calls).toEqual([
      [ISLAND_IPC_CHANNELS.toggleExpanded],
      [ISLAND_IPC_CHANNELS.toggleExpanded],
    ]);
  });
});

describe("island settings persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "island-settings-"));
  });

  afterEach(() => {
    FS.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the enabled flag without leaving a temp file", () => {
    const settingsPath = Path.join(dir, "island.json");
    writeStoredIslandEnabled(settingsPath, true);
    expect(readStoredIslandEnabled(settingsPath)).toBe(true);
    writeStoredIslandEnabled(settingsPath, false);
    expect(readStoredIslandEnabled(settingsPath)).toBe(false);
    expect(FS.existsSync(`${settingsPath}.tmp`)).toBe(false);
  });

  it("returns null for missing, corrupted, or invalid settings files", () => {
    const settingsPath = Path.join(dir, "island.json");
    expect(readStoredIslandEnabled(settingsPath)).toBeNull();
    FS.writeFileSync(settingsPath, "{ not json");
    expect(readStoredIslandEnabled(settingsPath)).toBeNull();
    FS.writeFileSync(settingsPath, JSON.stringify({ enabled: "yes" }));
    expect(readStoredIslandEnabled(settingsPath)).toBeNull();
  });
});
