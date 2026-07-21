import { describe, expect, it } from "vitest";

import { shortcutHint } from "./Island";

describe("shortcutHint", () => {
  it("renders mac glyphs only for an explicit macos display context", () => {
    expect(shortcutHint({ platform: "macos", notch: null })).toBe("\u2318\u21e7I");
  });

  it("renders Ctrl for Windows and Linux display contexts", () => {
    expect(shortcutHint({ platform: "windows", notch: null })).toBe("Ctrl\u21e7I");
    expect(shortcutHint({ platform: "linux", notch: null })).toBe("Ctrl\u21e7I");
  });
});
