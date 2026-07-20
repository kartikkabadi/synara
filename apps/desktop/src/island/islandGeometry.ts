// FILE: islandGeometry.ts
// Purpose: Pure geometry math for the island overlay window — notch heuristic and anchoring.
// Layer: Desktop island (pure logic, no Electron imports)

import type { IslandNotchInfo, IslandWindowState } from "@synara/contracts";

export interface IslandRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IslandSize {
  width: number;
  height: number;
}

export interface IslandDisplayMetrics {
  bounds: IslandRect;
  workArea: IslandRect;
}

// A notched macOS menu bar insets the work area ~37–38pt from the screen top,
// versus ~24–25pt without a notch. 30 splits the two populations safely.
export const NOTCH_TOP_INSET_THRESHOLD = 30;

// Electron cannot measure the physical notch width without native code, so the
// island uses the common MacBook Pro housing width; side extensions keep the
// status glyphs clear of the camera housing either way.
export const DEFAULT_NOTCH_WIDTH = 180;

export const ISLAND_EXPANDED_SIZE: IslandSize = { width: 560, height: 320 };
export const ISLAND_FLOATING_COLLAPSED_SIZE: IslandSize = { width: 180, height: 32 };
export const ISLAND_HOVER_HEIGHT = 104;
export const ISLAND_FLOATING_TOP_MARGIN = 6;

export function detectNotch(
  platform: NodeJS.Platform,
  metrics: IslandDisplayMetrics,
): IslandNotchInfo | null {
  if (platform !== "darwin") return null;
  const topInset = metrics.workArea.y - metrics.bounds.y;
  if (topInset < NOTCH_TOP_INSET_THRESHOLD) return null;
  return { width: DEFAULT_NOTCH_WIDTH, height: topInset };
}

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

// Top-center anchor: flush with the screen top in notch mode (the pill reads
// as a camera-housing extension), 6px below the work area top elsewhere.
function islandAnchoredBounds(
  size: IslandSize,
  metrics: IslandDisplayMetrics,
  notch: IslandNotchInfo | null,
): IslandRect {
  const centerX = metrics.bounds.x + Math.round((metrics.bounds.width - size.width) / 2);
  const y = notch ? metrics.bounds.y : metrics.workArea.y + ISLAND_FLOATING_TOP_MARGIN;
  return { x: centerX, y, width: size.width, height: size.height };
}

// macOS/Windows: the window is pre-sized to the max expanded bounds and the
// renderer animates an inner container, so setBounds never animates.
export function islandWindowBounds(
  metrics: IslandDisplayMetrics,
  notch: IslandNotchInfo | null,
): IslandRect {
  return islandAnchoredBounds(ISLAND_EXPANDED_SIZE, metrics, notch);
}

// Linux (no click-through forwarding): the window only spans the current
// state's bounds and resizes between states without animation.
export function islandStateBounds(
  state: IslandWindowState,
  metrics: IslandDisplayMetrics,
  notch: IslandNotchInfo | null,
): IslandRect {
  return islandAnchoredBounds(islandStateSize(state, notch), metrics, notch);
}

// null means "use the platform default": on for macOS/Windows, off for Linux.
export function resolveIslandEnabled(
  stored: boolean | null | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (typeof stored === "boolean") return stored;
  return platform !== "linux";
}
