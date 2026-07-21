import { describe, expect, it } from "vitest";

import { HOVER_EXIT_GRACE_MS, HOVER_OPEN_DELAY_MS, shortcutHint } from "./Island";

describe("shortcutHint", () => {
  it("renders mac glyphs only for an explicit macos display context", () => {
    expect(shortcutHint({ platform: "macos", notch: null })).toBe("\u2318\u21e7I");
  });

  it("renders Ctrl+Shift for Windows and Linux display contexts", () => {
    expect(shortcutHint({ platform: "windows", notch: null })).toBe("Ctrl+Shift+I");
    expect(shortcutHint({ platform: "linux", notch: null })).toBe("Ctrl+Shift+I");
  });
});

describe("hover timers", () => {
  it("keeps the dwell delay and exit grace inside their spec bands", () => {
    expect(HOVER_OPEN_DELAY_MS).toBeGreaterThanOrEqual(100);
    expect(HOVER_OPEN_DELAY_MS).toBeLessThanOrEqual(140);
    expect(HOVER_EXIT_GRACE_MS).toBeGreaterThanOrEqual(120);
    expect(HOVER_EXIT_GRACE_MS).toBeLessThanOrEqual(180);
  });
});
