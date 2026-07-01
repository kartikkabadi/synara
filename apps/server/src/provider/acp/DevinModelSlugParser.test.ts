import { describe, it, expect } from "vitest";
import { parseDevinModelSlug } from "./DevinModelSlugParser";

describe("parseDevinModelSlug", () => {
  // Mode values return null
  it("returns null for mode values", () => {
    expect(parseDevinModelSlug("accept-edits", "Code")).toBeNull();
    expect(parseDevinModelSlug("ask", "Ask")).toBeNull();
    expect(parseDevinModelSlug("bypass", "Bypass Permissions")).toBeNull();
    expect(parseDevinModelSlug("plan", "Plan")).toBeNull();
  });

  // Single model, no variants
  it("parses adaptive with no variants", () => {
    const result = parseDevinModelSlug("adaptive", "Adaptive");
    expect(result).toEqual({ baseSlug: "adaptive", baseName: "Adaptive" });
  });

  it("parses deepseek-v4 without stripping v4", () => {
    const result = parseDevinModelSlug("deepseek-v4", "DeepSeek V4 Pro");
    expect(result).toEqual({ baseSlug: "deepseek-v4", baseName: "DeepSeek V4 Pro" });
  });

  it("parses kimi-k2-6 without stripping 6", () => {
    const result = parseDevinModelSlug("kimi-k2-6", "Kimi K2.6");
    expect(result).toEqual({ baseSlug: "kimi-k2-6", baseName: "Kimi K2.6" });
  });

  // Effort variants
  it("parses claude-opus-4-8-high", () => {
    const result = parseDevinModelSlug("claude-opus-4-8-high", "Claude Opus 4.8 High");
    expect(result).toEqual({ baseSlug: "claude-opus-4-8", baseName: "Claude Opus 4.8" });
  });

  it("parses claude-sonnet-5-medium", () => {
    const result = parseDevinModelSlug("claude-sonnet-5-medium", "Claude Sonnet 5 Medium");
    expect(result).toEqual({ baseSlug: "claude-sonnet-5", baseName: "Claude Sonnet 5" });
  });

  it("parses glm-5-2-none (none is an effort)", () => {
    const result = parseDevinModelSlug("glm-5-2-none", "GLM-5.2 None");
    expect(result).toEqual({ baseSlug: "glm-5-2", baseName: "GLM-5.2" });
  });

  it("parses gemini-3-5-flash-minimal (minimal is an effort)", () => {
    const result = parseDevinModelSlug("gemini-3-5-flash-minimal", "Gemini 3.5 Flash Minimal");
    expect(result).toEqual({ baseSlug: "gemini-3-5-flash", baseName: "Gemini 3.5 Flash" });
  });

  // Effort + fast variants
  it("parses claude-opus-4-8-high-fast", () => {
    const result = parseDevinModelSlug("claude-opus-4-8-high-fast", "Claude Opus 4.8 High Fast");
    expect(result).toEqual({ baseSlug: "claude-opus-4-8", baseName: "Claude Opus 4.8" });
  });

  it("parses gpt-5-3-codex-low-priority (priority = fast)", () => {
    const result = parseDevinModelSlug("gpt-5-3-codex-low-priority", "GPT-5.3-Codex Low Fast");
    expect(result).toEqual({ baseSlug: "gpt-5-3-codex", baseName: "GPT-5.3-Codex" });
  });

  it("parses gpt-5-5-medium-priority", () => {
    const result = parseDevinModelSlug("gpt-5-5-medium-priority", "GPT-5.5 Medium Fast");
    expect(result).toEqual({ baseSlug: "gpt-5-5", baseName: "GPT-5.5" });
  });

  // Thinking + context window variants
  it("parses claude-opus-4-6-thinking", () => {
    const result = parseDevinModelSlug("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking");
    expect(result).toEqual({ baseSlug: "claude-opus-4-6", baseName: "Claude Opus 4.6" });
  });

  it("parses claude-opus-4-6-thinking-1m", () => {
    const result = parseDevinModelSlug(
      "claude-opus-4-6-thinking-1m",
      "Claude Opus 4.6 Thinking 1M",
    );
    expect(result).toEqual({ baseSlug: "claude-opus-4-6", baseName: "Claude Opus 4.6" });
  });

  it("parses glm-5-2-max-1m", () => {
    const result = parseDevinModelSlug("glm-5-2-max-1m", "GLM-5.2 Max 1M");
    expect(result).toEqual({ baseSlug: "glm-5-2", baseName: "GLM-5.2" });
  });

  // Fast-only variant (no effort)
  it("parses swe-1-6-fast", () => {
    const result = parseDevinModelSlug("swe-1-6-fast", "SWE 1.6 Fast");
    expect(result).toEqual({ baseSlug: "swe-1-6", baseName: "SWE 1.6" });
  });

  // gpt-5-4-mini — "mini" is NOT an effort, must stay in base
  it("parses gpt-5-4-mini-high without stripping mini", () => {
    const result = parseDevinModelSlug("gpt-5-4-mini-high", "GPT-5.4 Mini High");
    expect(result).toEqual({ baseSlug: "gpt-5-4-mini", baseName: "GPT-5.4 Mini" });
  });

  // Uppercase MODEL_* legacy slugs
  it("parses MODEL_GPT_5_2_HIGH", () => {
    const result = parseDevinModelSlug("MODEL_GPT_5_2_HIGH", "MODEL_GPT_5_2_HIGH");
    expect(result).toEqual({ baseSlug: "MODEL_GPT_5_2", baseName: "GPT 5.2" });
  });

  it("parses MODEL_SWE_1_5_SLOW (slow is an effort)", () => {
    const result = parseDevinModelSlug("MODEL_SWE_1_5_SLOW", "MODEL_SWE_1_5_SLOW");
    expect(result).toEqual({ baseSlug: "MODEL_SWE_1_5", baseName: "SWE 1.5" });
  });

  it("parses MODEL_CLAUDE_4_5_OPUS_THINKING", () => {
    const result = parseDevinModelSlug(
      "MODEL_CLAUDE_4_5_OPUS_THINKING",
      "MODEL_CLAUDE_4_5_OPUS_THINKING",
    );
    expect(result).toEqual({ baseSlug: "MODEL_CLAUDE_4_5_OPUS", baseName: "Claude 4.5 Opus" });
  });

  it("parses MODEL_PRIVATE_11 without stripping 11", () => {
    const result = parseDevinModelSlug("MODEL_PRIVATE_11", "MODEL_PRIVATE_11");
    expect(result).toEqual({ baseSlug: "MODEL_PRIVATE_11", baseName: "Private 11" });
  });

  it("parses MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH", () => {
    const result = parseDevinModelSlug(
      "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
      "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
    );
    expect(result).toEqual({
      baseSlug: "MODEL_GOOGLE_GEMINI_3_0_FLASH",
      baseName: "Google Gemini 3.0 Flash",
    });
  });

  // Edge: empty/invalid input
  it("returns null for empty slug", () => {
    expect(parseDevinModelSlug("", "")).toBeNull();
    expect(parseDevinModelSlug("  ", "  ")).toBeNull();
  });
});
