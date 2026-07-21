import { describe, expect, it } from "vitest";

import {
  DARWIN_HIDDEN_MENU_BAR_TOP_INSET,
  DEFAULT_NOTCH_WIDTH,
  detectNotch,
  islandCollapsedSize,
  islandExpandedSize,
  islandHoverSize,
  islandSurfaceRect,
  islandWindowBounds,
  resolveIslandEnabled,
  type IslandDisplayMetrics,
} from "./islandGeometry";

const notchedDisplay: IslandDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 944 },
};

const plainDisplay: IslandDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};

const windowsDisplay: IslandDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
};

const secondaryDisplay: IslandDisplayMetrics = {
  bounds: { x: 1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: 1920, y: -175, width: 1920, height: 1055 },
};

describe("detectNotch", () => {
  it("detects a notch from a large macOS menu-bar inset", () => {
    expect(detectNotch("darwin", notchedDisplay)).toEqual({
      width: DEFAULT_NOTCH_WIDTH,
      height: 38,
    });
  });

  it("returns null for a non-notched macOS menu bar", () => {
    expect(detectNotch("darwin", plainDisplay)).toBeNull();
  });

  it("never reports a notch off macOS, even with a large top inset", () => {
    expect(detectNotch("win32", notchedDisplay)).toBeNull();
    expect(detectNotch("linux", notchedDisplay)).toBeNull();
  });
});

describe("island sizes", () => {
  it("extends the notch housing when collapsed in notch mode", () => {
    expect(islandCollapsedSize({ width: 180, height: 38 })).toEqual({ width: 240, height: 38 });
  });

  it("uses the floating pill size without a notch", () => {
    expect(islandCollapsedSize(null)).toEqual({ width: 180, height: 32 });
    expect(islandCollapsedSize(null, 2)).toEqual({ width: 180, height: 32 });
  });

  it("shrinks to the idle mini pill with zero sessions, except in notch mode", () => {
    expect(islandCollapsedSize(null, 0)).toEqual({ width: 64, height: 30 });
    expect(islandCollapsedSize({ width: 180, height: 38 }, 0)).toEqual({ width: 240, height: 38 });
  });

  it("derives the expanded height from the row count", () => {
    expect(islandExpandedSize()).toEqual({ width: 560, height: 320 });
    expect(islandExpandedSize(0)).toEqual({ width: 560, height: 180 });
    expect(islandExpandedSize(1)).toEqual({ width: 560, height: 140 });
    expect(islandExpandedSize(3)).toEqual({ width: 560, height: 208 });
    expect(islandExpandedSize(10)).toEqual({ width: 560, height: 320 });
  });

  it("keeps the hover width at least 420", () => {
    expect(islandHoverSize(null).width).toBe(420);
    expect(islandHoverSize({ width: 300, height: 38 }).width).toBe(500);
  });
});

describe("island anchoring", () => {
  it("pre-sizes the window past the max surface, flush with the screen top in notch mode", () => {
    const notch = detectNotch("darwin", notchedDisplay);
    expect(islandWindowBounds(notchedDisplay, notch)).toEqual({
      x: 428,
      y: 0,
      width: 656,
      height: 376,
    });
  });

  it("widens the window for a housing wider than the max surface", () => {
    const wideNotch = { width: 620, height: 38 };
    expect(islandWindowBounds(notchedDisplay, wideNotch).width).toBe(620 + 60 + 96);
  });

  it("floats below the work area top without a notch", () => {
    expect(islandWindowBounds(plainDisplay, null)).toEqual({
      x: 632,
      y: 31,
      width: 656,
      height: 376,
    });
  });

  it("anchors to displays with non-zero origins", () => {
    const bounds = islandWindowBounds(secondaryDisplay, null);
    expect(bounds.x).toBe(1920 + (1920 - 656) / 2);
    expect(bounds.y).toBe(-175 + 6);
  });

  it("pads past a possible notch when the macOS menu bar auto-hides", () => {
    const autoHideDisplay: IslandDisplayMetrics = {
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 0, width: 1512, height: 982 },
    };
    expect(detectNotch("darwin", autoHideDisplay)).toBeNull();
    expect(islandWindowBounds(autoHideDisplay, null, "darwin").y).toBe(
      DARWIN_HIDDEN_MENU_BAR_TOP_INSET + 6,
    );
    // Non-darwin platforms keep the plain work-area anchor.
    expect(islandWindowBounds(autoHideDisplay, null, "win32").y).toBe(6);
  });

  it("centers the surface rect at the window top per state", () => {
    expect(islandSurfaceRect("collapsed", windowsDisplay, null)).toEqual({
      x: (2560 - 180) / 2,
      y: 6,
      width: 180,
      height: 32,
    });
    expect(islandSurfaceRect("hover", windowsDisplay, null)).toMatchObject({
      width: 420,
      height: 104,
      y: 6,
    });
    expect(islandSurfaceRect("expanded", windowsDisplay, null)).toMatchObject({
      width: 560,
      height: 320,
    });
  });

  it("sizes the surface rect from the session count", () => {
    expect(islandSurfaceRect("collapsed", windowsDisplay, null, "linux", 0)).toMatchObject({
      width: 64,
      height: 30,
    });
    expect(islandSurfaceRect("expanded", windowsDisplay, null, "linux", 2)).toMatchObject({
      width: 560,
      height: 164,
    });
  });
});

describe("resolveIslandEnabled", () => {
  it("defaults on for macOS and Windows, off for Linux", () => {
    expect(resolveIslandEnabled(null, "darwin")).toBe(true);
    expect(resolveIslandEnabled(undefined, "win32")).toBe(true);
    expect(resolveIslandEnabled(null, "linux")).toBe(false);
  });

  it("honors an explicit stored choice on every platform", () => {
    expect(resolveIslandEnabled(true, "linux")).toBe(true);
    expect(resolveIslandEnabled(false, "darwin")).toBe(false);
  });
});
