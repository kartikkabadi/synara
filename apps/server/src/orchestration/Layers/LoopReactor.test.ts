import { describe, expect, it } from "vitest";

import { compactionCanReduceUsage } from "./LoopReactor";

describe("compactionCanReduceUsage", () => {
  it("allows native provider compaction even when Synara auto-compaction is disabled", () => {
    expect(compactionCanReduceUsage("codex", false)).toBe(true);
    expect(compactionCanReduceUsage("cursor", false)).toBe(true);
    expect(compactionCanReduceUsage("gemini", false)).toBe(true);
  });

  it("requires Synara auto-compaction for providers Synara compacts", () => {
    expect(compactionCanReduceUsage("opencode", false)).toBe(false);
    expect(compactionCanReduceUsage("opencode", true)).toBe(true);
    expect(compactionCanReduceUsage("pi", true)).toBe(true);
  });

  it("rejects providers with no compaction path", () => {
    expect(compactionCanReduceUsage("claudeAgent", true)).toBe(false);
    expect(compactionCanReduceUsage("grok", true)).toBe(false);
    expect(compactionCanReduceUsage("kilo", true)).toBe(false);
  });
});
