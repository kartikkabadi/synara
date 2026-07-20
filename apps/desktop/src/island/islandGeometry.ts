// FILE: islandGeometry.ts
// Purpose: Pure geometry math for the island overlay window — notch heuristic and anchoring.
// Layer: Desktop island (pure logic, no Electron imports)

import type { IslandNotchInfo, IslandWindowState } from "@synara/contracts";
import {
  DEFAULT_NOTCH_WIDTH,
  ISLAND_EXPANDED_SIZE,
  islandStateSize,
  type IslandSize,
} from "@synara/shared/islandGeometry";

export {
  DEFAULT_NOTCH_WIDTH,
  ISLAND_EXPANDED_SIZE,
  ISLAND_FLOATING_COLLAPSED_SIZE,
  ISLAND_HOVER_HEIGHT,
  islandCollapsedSize,
  islandHoverSize,
  islandStateSize,
  type IslandSize,
} from "@synara/shared/islandGeometry";

export interface IslandRect {
  x: number;
  y: number;
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
