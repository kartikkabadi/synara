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
    expect(islandCollapsedSize("notch", { width: 180, height: 38 })).toEqual({
      width: 240,
      height: 38,
    });
  });

  it("uses the floating pill size without a notch", () => {
    expect(islandCollapsedSize("floating", null)).toEqual({ width: 120, height: 32 });
    expect(islandCollapsedSize("floating", null, 2)).toEqual({ width: 120, height: 32 });
  });

  it("shrinks to the idle mini pill with zero sessions, except in notch mode", () => {
    expect(islandCollapsedSize("floating", null, 0)).toEqual({ width: 64, height: 30 });
    expect(islandCollapsedSize("notch", { width: 180, height: 38 }, 0)).toEqual({
      width: 240,
      height: 38,
    });
  });

  it("derives the expanded height from the row count", () => {
    expect(islandExpandedSize()).toEqual({ width: 432, height: 288 });
    expect(islandExpandedSize(0)).toEqual({ width: 432, height: 140 });
    expect(islandExpandedSize(1)).toEqual({ width: 432, height: 140 });
    expect(islandExpandedSize(3)).toEqual({ width: 432, height: 196 });
    expect(islandExpandedSize(10)).toEqual({ width: 432, height: 288 });
  });

  it("uses the floating hover size, widening for a wide notch housing", () => {
    expect(islandHoverSize("floating", null)).toEqual({ width: 372, height: 80 });
    expect(islandHoverSize("floating", null, 2)).toEqual({ width: 372, height: 80 });
    expect(islandHoverSize("notch", { width: 300, height: 38 }).width).toBe(500);
  });

  it("shrinks the hover preview with zero sessions, except in notch mode", () => {
    expect(islandHoverSize("floating", null, 0)).toEqual({ width: 272, height: 60 });
    expect(islandHoverSize("notch", { width: 180, height: 38 }, 0)).toEqual({
      width: 380,
      height: 80,
    });
  });
});

describe("island anchoring", () => {
  it("pre-sizes the window past the max surface, flush with the screen top in notch mode", () => {
    const notch = detectNotch("darwin", notchedDisplay);
    expect(islandWindowBounds(notchedDisplay, notch)).toEqual({
      x: 492,
      y: 0,
      width: 528,
      height: 344,
    });
  });

  it("widens the window for a housing wider than the max surface", () => {
    const wideNotch = { width: 620, height: 38 };
    expect(islandWindowBounds(notchedDisplay, wideNotch).width).toBe(620 + 60 + 96);
  });

  it("sits 9px below the work area top without a notch", () => {
    expect(islandWindowBounds(plainDisplay, null)).toEqual({
      x: 696,
      y: 34,
      width: 528,
      height: 344,
    });
  });

  it("anchors to displays with non-zero origins", () => {
    const bounds = islandWindowBounds(secondaryDisplay, null);
    expect(bounds.x).toBe(1920 + (1920 - 528) / 2);
    expect(bounds.y).toBe(-175 + 9);
  });

  it("pads past a possible notch when the macOS menu bar auto-hides", () => {
    const autoHideDisplay: IslandDisplayMetrics = {
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 0, width: 1512, height: 982 },
    };
    expect(detectNotch("darwin", autoHideDisplay)).toBeNull();
    expect(islandWindowBounds(autoHideDisplay, null, "darwin").y).toBe(
      DARWIN_HIDDEN_MENU_BAR_TOP_INSET + 9,
    );
    // Non-darwin platforms keep the work-area anchor plus the floating margin.
    expect(islandWindowBounds(autoHideDisplay, null, "win32").y).toBe(9);
  });

  it("centers the surface rect at the window top per state", () => {
    expect(islandSurfaceRect("collapsed", windowsDisplay, null)).toEqual({
      x: (2560 - 120) / 2,
      y: 9,
      width: 120,
      height: 32,
    });
    expect(islandSurfaceRect("hover", windowsDisplay, null)).toMatchObject({
      width: 372,
      height: 80,
      y: 9,
    });
    expect(islandSurfaceRect("expanded", windowsDisplay, null)).toMatchObject({
      width: 432,
      height: 288,
    });
  });

  it("sizes the surface rect from the session count", () => {
    expect(islandSurfaceRect("collapsed", windowsDisplay, null, "linux", 0)).toMatchObject({
      width: 64,
      height: 30,
    });
    expect(islandSurfaceRect("expanded", windowsDisplay, null, "linux", 2)).toMatchObject({
      width: 432,
      height: 152,
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

describe("surface/window sizing invariant", () => {
  it("never renders a surface wider than the pre-sized window", () => {
    const notches = [null, { width: DEFAULT_NOTCH_WIDTH, height: 38 }];
    const states = ["collapsed", "hover", "expanded"] as const;
    for (const notch of notches) {
      const window = islandWindowBounds(notchedDisplay, notch, "darwin");
      for (const state of states) {
        for (const sessionCount of [undefined, 0, 1, 3, 8, 20]) {
          const surface = islandSurfaceRect(state, notchedDisplay, notch, "darwin", sessionCount);
          expect(surface.width).toBeLessThanOrEqual(window.width);
          expect(surface.height).toBeLessThanOrEqual(window.height);
        }
      }
    }
  });
});
