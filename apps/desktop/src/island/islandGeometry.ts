// FILE: islandGeometry.ts
// Purpose: Pure geometry math for the island overlay window — notch heuristic and anchoring.
// Layer: Desktop island (pure logic, no Electron imports)

import type { IslandNotchInfo, IslandWindowState } from "@synara/contracts";
import {
  DEFAULT_NOTCH_WIDTH,
  ISLAND_WINDOW_MARGIN,
  ISLAND_WINDOW_SIZE,
  islandShellMode,
  islandStateSize,
  type IslandSize,
} from "@synara/shared/islandGeometry";

export {
  DEFAULT_NOTCH_WIDTH,
  ISLAND_EXPANDED_SIZE,
  ISLAND_WINDOW_MARGIN,
  ISLAND_WINDOW_SIZE,
  ISLAND_EXPANDED_EMPTY_SIZE,
  ISLAND_FLOATING_COLLAPSED_SIZE,
  ISLAND_HOVER_SIZE,
  ISLAND_IDLE_COLLAPSED_SIZE,
  islandCollapsedSize,
  islandExpandedSize,
  islandHoverSize,
  islandShellMode,
  islandStateSize,
  type IslandShellMode,
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

// Floating shell sits just below the work-area top so the rounded surface
// reads as a detached overlay rather than fusing with the screen edge.
export const ISLAND_FLOATING_TOP_MARGIN = 9;

// With "Automatically hide and show the menu bar" the work area reaches the
// screen top, so the notch heuristic is blind. Fall back to the notched
// menu-bar inset (~38pt) so a floating island can never sit under the
// physical camera housing.
export const DARWIN_HIDDEN_MENU_BAR_TOP_INSET = 38;

export function detectNotch(
  platform: NodeJS.Platform,
  metrics: IslandDisplayMetrics,
): IslandNotchInfo | null {
  if (platform !== "darwin") return null;
  const topInset = metrics.workArea.y - metrics.bounds.y;
  if (topInset < NOTCH_TOP_INSET_THRESHOLD) return null;
  return { width: DEFAULT_NOTCH_WIDTH, height: topInset };
}

function islandFloatingTop(metrics: IslandDisplayMetrics, platform?: NodeJS.Platform): number {
  const topInset = metrics.workArea.y - metrics.bounds.y;
  if (platform === "darwin" && topInset <= 0) {
    return metrics.bounds.y + DARWIN_HIDDEN_MENU_BAR_TOP_INSET;
  }
  return metrics.workArea.y;
}

// Top-center anchor: flush with the screen top in notch mode (the pill reads
// as a camera-housing extension); 9px below the work-area top in the floating
// shell.
function islandAnchoredBounds(
  size: IslandSize,
  metrics: IslandDisplayMetrics,
  notch: IslandNotchInfo | null,
  platform?: NodeJS.Platform,
): IslandRect {
  const centerX = metrics.bounds.x + Math.round((metrics.bounds.width - size.width) / 2);
  const y = notch
    ? metrics.bounds.y
    : islandFloatingTop(metrics, platform) + ISLAND_FLOATING_TOP_MARGIN;
  return { x: centerX, y, width: size.width, height: size.height };
}

// Every platform: the window is pre-sized to the max surface plus shadow
// margin and never resizes per state — the renderer morphs an inner surface,
// so setBounds only ever runs on display changes.
export function islandWindowBounds(
  metrics: IslandDisplayMetrics,
  notch: IslandNotchInfo | null,
  platform?: NodeJS.Platform,
): IslandRect {
  const width = notch
    ? Math.max(ISLAND_WINDOW_SIZE.width, notch.width + 60 + ISLAND_WINDOW_MARGIN.x * 2)
    : ISLAND_WINDOW_SIZE.width;
  return islandAnchoredBounds(
    { width, height: ISLAND_WINDOW_SIZE.height },
    metrics,
    notch,
    platform,
  );
}

// Screen-space rect of the visible surface (top-center of the window) for the
// Linux cursor-poll click-through model.
export function islandSurfaceRect(
  state: IslandWindowState,
  metrics: IslandDisplayMetrics,
  notch: IslandNotchInfo | null,
  platform?: NodeJS.Platform,
  sessionCount?: number,
): IslandRect {
  const window = islandWindowBounds(metrics, notch, platform);
  const size = islandStateSize(state, islandShellMode(notch), notch, sessionCount);
  return {
    x: window.x + Math.round((window.width - size.width) / 2),
    y: window.y,
    width: size.width,
    height: size.height,
  };
}

// null means "use the platform default": on for macOS/Windows, off for Linux.
export function resolveIslandEnabled(
  stored: boolean | null | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (typeof stored === "boolean") return stored;
  return platform !== "linux";
}
