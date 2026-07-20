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
export const ISLAND_FLOATING_COLLAPSED_SIZE: IslandSize = { width: 180, height: 32 };
export const ISLAND_HOVER_HEIGHT = 104;

export function islandCollapsedSize(notch: IslandNotchInfo | null): IslandSize {
  if (!notch) return ISLAND_FLOATING_COLLAPSED_SIZE;
  return { width: notch.width + 60, height: notch.height };
}

export function islandHoverSize(notch: IslandNotchInfo | null): IslandSize {
  const width = Math.max((notch?.width ?? DEFAULT_NOTCH_WIDTH) + 200, 420);
  return { width, height: ISLAND_HOVER_HEIGHT };
}

export function islandStateSize(
  state: IslandWindowState,
  notch: IslandNotchInfo | null,
): IslandSize {
  if (state === "expanded") return ISLAND_EXPANDED_SIZE;
  if (state === "hover") return islandHoverSize(notch);
  return islandCollapsedSize(notch);
}
