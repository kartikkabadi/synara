import { describe, expect, it } from "vitest";

import { formatSecondsCompact } from "./format";

describe("formatSecondsCompact", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatSecondsCompact(45)).toBe("45s");
  });

  it("formats minute-scale durations", () => {
    expect(formatSecondsCompact(90)).toBe("1m");
  });

  it("formats hour-scale durations", () => {
    expect(formatSecondsCompact(5400)).toBe("1.5h");
  });
});
