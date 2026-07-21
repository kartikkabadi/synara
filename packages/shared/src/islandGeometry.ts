// FILE: islandGeometry.ts
// Purpose: Island overlay sizing shared by the Electron window manager and the renderer.
// Layer: Shared pure logic

import type { IslandNotchInfo, IslandWindowState } from "@synara/contracts";

export interface IslandSize {
  width: number;
  height: number;
}

// Electron cannot measure the physical notch width without native code, so the
// island uses the common MacBook Pro housing width; side extensions keep the
// status glyphs clear of the camera housing either way.
export const DEFAULT_NOTCH_WIDTH = 180;

export const ISLAND_EXPANDED_SIZE: IslandSize = { width: 560, height: 320 };
export const ISLAND_EXPANDED_EMPTY_SIZE: IslandSize = { width: 560, height: 180 };
export const ISLAND_FLOATING_COLLAPSED_SIZE: IslandSize = { width: 180, height: 32 };
// With zero sessions the floating pill shrinks to just the seated orb.
export const ISLAND_IDLE_COLLAPSED_SIZE: IslandSize = { width: 64, height: 30 };
export const ISLAND_HOVER_HEIGHT = 104;

const EXPANDED_ROW_HEIGHT = 44;
const EXPANDED_CHROME_HEIGHT = 64 + 12;

// sessionCount undefined means "unknown": callers without content knowledge
// keep the classic sizes.
export function islandCollapsedSize(
  notch: IslandNotchInfo | null,
  sessionCount?: number,
): IslandSize {
  // Notch mode keeps the hardware-anchored housing width in every state.
  if (notch) return { width: notch.width + 60, height: notch.height };
  if (sessionCount === 0) return ISLAND_IDLE_COLLAPSED_SIZE;
  return ISLAND_FLOATING_COLLAPSED_SIZE;
}

export function islandHoverSize(notch: IslandNotchInfo | null): IslandSize {
  const width = Math.max((notch?.width ?? DEFAULT_NOTCH_WIDTH) + 200, 420);
  return { width, height: ISLAND_HOVER_HEIGHT };
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
  notch: IslandNotchInfo | null,
  sessionCount?: number,
): IslandSize {
  if (state === "expanded") return islandExpandedSize(sessionCount);
  if (state === "hover") return islandHoverSize(notch);
  return islandCollapsedSize(notch, sessionCount);
}
