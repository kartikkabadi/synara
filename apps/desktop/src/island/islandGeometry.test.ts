import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTCH_WIDTH,
  detectNotch,
  islandCollapsedSize,
  islandHoverSize,
  islandStateBounds,
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
  });

  it("keeps the hover width at least 420", () => {
    expect(islandHoverSize(null).width).toBe(420);
    expect(islandHoverSize({ width: 300, height: 38 }).width).toBe(500);
  });
});

describe("island anchoring", () => {
  it("pre-sizes the window to the expanded bounds, flush with the screen top in notch mode", () => {
    const notch = detectNotch("darwin", notchedDisplay);
    expect(islandWindowBounds(notchedDisplay, notch)).toEqual({
      x: 476,
      y: 0,
      width: 560,
      height: 320,
    });
  });

  it("floats below the work area top without a notch", () => {
    expect(islandWindowBounds(plainDisplay, null)).toEqual({
      x: 680,
      y: 31,
      width: 560,
      height: 320,
    });
  });

  it("anchors to displays with non-zero origins", () => {
    const bounds = islandWindowBounds(secondaryDisplay, null);
    expect(bounds.x).toBe(1920 + (1920 - 560) / 2);
    expect(bounds.y).toBe(-175 + 6);
  });

  it("sizes Linux state bounds per window state", () => {
    expect(islandStateBounds("collapsed", windowsDisplay, null)).toMatchObject({
      width: 180,
      height: 32,
      y: 6,
    });
    expect(islandStateBounds("hover", windowsDisplay, null)).toMatchObject({
      width: 420,
      height: 104,
    });
    expect(islandStateBounds("expanded", windowsDisplay, null)).toMatchObject({
      width: 560,
      height: 320,
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
