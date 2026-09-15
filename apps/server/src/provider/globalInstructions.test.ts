import { describe, expect, it } from "vitest";

import {
  formatGlobalInstructionsPrompt,
  GLOBAL_INSTRUCTIONS_MAX_CHARS,
  normalizeGlobalInstructions,
} from "./globalInstructions";

describe("global instructions", () => {
  it("wraps user-authored guidance in an explicit boundary", () => {
    expect(formatGlobalInstructionsPrompt("Prefer small, tested changes.")).toContain(
      "<synara_global_instructions>",
    );
    expect(formatGlobalInstructionsPrompt("Prefer small, tested changes.")).toContain(
      "Prefer small, tested changes.",
    );
  });

  it("trims whitespace and caps the file before prompt composition", () => {
    const normalized = normalizeGlobalInstructions(`  ${"x".repeat(10_000)}  `);
    expect(normalized).toHaveLength(GLOBAL_INSTRUCTIONS_MAX_CHARS);
    expect(normalized).not.toMatch(/^\s|\s$/);
  });
});
