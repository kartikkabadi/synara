// FILE: islandGeometry.ts
// Purpose: Island overlay sizing shared by the Electron window manager and the renderer.
// Layer: Shared pure logic

import type { IslandNotchInfo, IslandWindowState } from "@synara/contracts";

export interface IslandSize {
  width: number;
  height: number;
}

// Shell mode: `floating` (Windows, Linux, non-notched macOS) is the fully
// implemented shell; `notch` (notched macOS) is a stub that reuses the
// floating rendering until the camera-housing fusion pass.
export type IslandShellMode = "floating" | "notch";

export function islandShellMode(notch: IslandNotchInfo | null): IslandShellMode {
  return notch ? "notch" : "floating";
}

// Electron cannot measure the physical notch width without native code, so the
// island uses the common MacBook Pro housing width; side extensions keep the
// status glyphs clear of the camera housing either way.
export const DEFAULT_NOTCH_WIDTH = 180;

export const ISLAND_EXPANDED_SIZE: IslandSize = { width: 432, height: 288 };

// The BrowserWindow is pre-sized to the maximum surface plus room for the
// ambient shadow so nothing clips at the window edge; the renderer morphs the
// inner surface within the fixed window.
export const ISLAND_WINDOW_MARGIN = { x: 48, bottom: 56 } as const;
export const ISLAND_WINDOW_SIZE: IslandSize = {
  width: ISLAND_EXPANDED_SIZE.width + ISLAND_WINDOW_MARGIN.x * 2,
  height: ISLAND_EXPANDED_SIZE.height + ISLAND_WINDOW_MARGIN.bottom,
};
export const ISLAND_EXPANDED_EMPTY_SIZE: IslandSize = { width: 432, height: 140 };
// Content-fit pill: status light + session count with breathing room.
export const ISLAND_FLOATING_COLLAPSED_SIZE: IslandSize = { width: 120, height: 32 };
// With zero sessions the floating pill shrinks to just the status light.
export const ISLAND_IDLE_COLLAPSED_SIZE: IslandSize = { width: 64, height: 30 };
export const ISLAND_HOVER_SIZE: IslandSize = { width: 372, height: 80 };

const EXPANDED_ROW_HEIGHT = 44;
const EXPANDED_CHROME_HEIGHT = 64;

// sessionCount undefined means "unknown": callers without content knowledge
// keep the classic sizes.
export function islandCollapsedSize(
  shell: IslandShellMode,
  notch: IslandNotchInfo | null,
  sessionCount?: number,
): IslandSize {
  // Notch stub keeps the hardware-anchored housing width in every state.
  if (shell === "notch" && notch) return { width: notch.width + 60, height: notch.height };
  if (sessionCount === 0) return ISLAND_IDLE_COLLAPSED_SIZE;
  return ISLAND_FLOATING_COLLAPSED_SIZE;
}

export function islandHoverSize(shell: IslandShellMode, notch: IslandNotchInfo | null): IslandSize {
  if (shell === "notch" && notch) {
    return {
      width: Math.max(notch.width + 200, ISLAND_HOVER_SIZE.width),
      height: ISLAND_HOVER_SIZE.height,
    };
  }
  return ISLAND_HOVER_SIZE;
}

// Content-driven expanded height: chrome + rows, clamped to sane bounds.
export function islandExpandedSize(rowCount?: number): IslandSize {
  if (rowCount === undefined) return ISLAND_EXPANDED_SIZE;
  if (rowCount === 0) return ISLAND_EXPANDED_EMPTY_SIZE;
  const height = Math.min(
    ISLAND_EXPANDED_SIZE.height,
    Math.max(140, EXPANDED_CHROME_HEIGHT + rowCount * EXPANDED_ROW_HEIGHT),
  );
  return { width: ISLAND_EXPANDED_SIZE.width, height };
}

export function islandStateSize(
  state: IslandWindowState,
  shell: IslandShellMode,
  notch: IslandNotchInfo | null,
  sessionCount?: number,
): IslandSize {
  if (state === "expanded") return islandExpandedSize(sessionCount);
  if (state === "hover") return islandHoverSize(shell, notch);
  return islandCollapsedSize(shell, notch, sessionCount);
}
