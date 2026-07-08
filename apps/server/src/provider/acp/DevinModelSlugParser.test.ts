import { describe, it, expect } from "vitest";
import { normalizeDevinModelDisplayName, parseDevinModelSlug } from "./DevinModelSlugParser";

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
    expect(parseDevinModelSlug("adaptive", "Adaptive")).toEqual({
      baseSlug: "adaptive",
      baseName: "Adaptive",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "devin",
      upstreamProviderName: "Devin",
    });
  });

  it("parses deepseek-v4 without stripping v4", () => {
    expect(parseDevinModelSlug("deepseek-v4", "DeepSeek V4 Pro")).toEqual({
      baseSlug: "deepseek-v4",
      baseName: "DeepSeek V4 Pro",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "deepseek",
      upstreamProviderName: "DeepSeek",
    });
  });

  it("parses kimi-k2-6 without stripping 6", () => {
    expect(parseDevinModelSlug("kimi-k2-6", "Kimi K2.6")).toEqual({
      baseSlug: "kimi-k2-6",
      baseName: "Kimi K2.6",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "moonshot",
      upstreamProviderName: "Moonshot AI",
    });
  });

  // Effort variants
  it("parses claude-opus-4-8-high", () => {
    expect(parseDevinModelSlug("claude-opus-4-8-high", "Claude Opus 4.8 High")).toEqual({
      baseSlug: "claude-opus-4-8",
      baseName: "Claude Opus 4.8",
      effort: "high",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses claude-sonnet-5-medium", () => {
    expect(parseDevinModelSlug("claude-sonnet-5-medium", "Claude Sonnet 5 Medium")).toEqual({
      baseSlug: "claude-sonnet-5",
      baseName: "Claude Sonnet 5",
      effort: "medium",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses sonnet-4-5 without the claude prefix", () => {
    expect(parseDevinModelSlug("sonnet-4-5", "Sonnet 4.5")).toEqual({
      baseSlug: "sonnet-4-5",
      baseName: "Sonnet 4.5",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses haiku-4-5 without the claude prefix", () => {
    expect(parseDevinModelSlug("haiku-4-5", "Haiku 4.5")).toEqual({
      baseSlug: "haiku-4-5",
      baseName: "Haiku 4.5",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses glm-5-2-none (none is an effort)", () => {
    expect(parseDevinModelSlug("glm-5-2-none", "GLM-5.2 None")).toEqual({
      baseSlug: "glm-5-2",
      baseName: "GLM-5.2",
      effort: "none",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "z-ai",
      upstreamProviderName: "Z.AI",
    });
  });

  it("parses gemini-3-5-flash-minimal (minimal is an effort)", () => {
    expect(parseDevinModelSlug("gemini-3-5-flash-minimal", "Gemini 3.5 Flash Minimal")).toEqual({
      baseSlug: "gemini-3-5-flash",
      baseName: "Gemini 3.5 Flash",
      effort: "minimal",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "google",
      upstreamProviderName: "Google",
    });
  });

  // Effort + fast variants
  it("parses claude-opus-4-8-high-fast", () => {
    expect(parseDevinModelSlug("claude-opus-4-8-high-fast", "Claude Opus 4.8 High Fast")).toEqual({
      baseSlug: "claude-opus-4-8",
      baseName: "Claude Opus 4.8",
      effort: "high",
      fast: true,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses gpt-5-3-codex-low-priority (priority = fast)", () => {
    expect(parseDevinModelSlug("gpt-5-3-codex-low-priority", "GPT-5.3-Codex Low Fast")).toEqual({
      baseSlug: "gpt-5-3-codex",
      baseName: "GPT-5.3-Codex",
      effort: "low",
      fast: true,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
    });
  });

  it("parses gpt-5-5-medium-priority", () => {
    expect(parseDevinModelSlug("gpt-5-5-medium-priority", "GPT-5.5 Medium Fast")).toEqual({
      baseSlug: "gpt-5-5",
      baseName: "GPT-5.5",
      effort: "medium",
      fast: true,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
    });
  });

  // Thinking + context window variants
  it("parses claude-opus-4-6-thinking", () => {
    expect(parseDevinModelSlug("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking")).toEqual({
      baseSlug: "claude-opus-4-6",
      baseName: "Claude Opus 4.6",
      effort: null,
      fast: false,
      thinking: true,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses claude-opus-4-6-thinking-1m", () => {
    expect(
      parseDevinModelSlug("claude-opus-4-6-thinking-1m", "Claude Opus 4.6 Thinking 1M"),
    ).toEqual({
      baseSlug: "claude-opus-4-6",
      baseName: "Claude Opus 4.6",
      effort: null,
      fast: false,
      thinking: true,
      contextWindow: "1m",
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses glm-5-2-max-1m", () => {
    expect(parseDevinModelSlug("glm-5-2-max-1m", "GLM-5.2 Max 1M")).toEqual({
      baseSlug: "glm-5-2",
      baseName: "GLM-5.2",
      effort: "max",
      fast: false,
      thinking: false,
      contextWindow: "1m",
      upstreamProviderId: "z-ai",
      upstreamProviderName: "Z.AI",
    });
  });

  // Fast-only variant (no effort)
  it("parses swe-1-6-fast", () => {
    expect(parseDevinModelSlug("swe-1-6-fast", "SWE 1.6 Fast")).toEqual({
      baseSlug: "swe-1-6",
      baseName: "SWE 1.6",
      effort: null,
      fast: true,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "devin",
      upstreamProviderName: "Devin",
    });
  });

  // gpt-5-4-mini — "mini" is NOT an effort, must stay in base
  it("parses gpt-5-4-mini-high without stripping mini", () => {
    expect(parseDevinModelSlug("gpt-5-4-mini-high", "GPT-5.4 Mini High")).toEqual({
      baseSlug: "gpt-5-4-mini",
      baseName: "GPT-5.4 Mini",
      effort: "high",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
    });
  });

  // Uppercase MODEL_* legacy slugs
  it("parses MODEL_GPT_5_2_HIGH", () => {
    expect(parseDevinModelSlug("MODEL_GPT_5_2_HIGH", "MODEL_GPT_5_2_HIGH")).toEqual({
      baseSlug: "MODEL_GPT_5_2",
      baseName: "GPT-5.2",
      effort: "high",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
    });
  });

  it("parses MODEL_SWE_1_5 without variant suffix", () => {
    expect(parseDevinModelSlug("MODEL_SWE_1_5", "MODEL_SWE_1_5")).toEqual({
      baseSlug: "MODEL_SWE_1_5",
      baseName: "SWE 1.5",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "devin",
      upstreamProviderName: "Devin",
    });
  });

  it("parses MODEL_SWE_1_5_SLOW (slow is an effort)", () => {
    expect(parseDevinModelSlug("MODEL_SWE_1_5_SLOW", "MODEL_SWE_1_5_SLOW")).toEqual({
      baseSlug: "MODEL_SWE_1_5",
      baseName: "SWE 1.5",
      effort: "slow",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "devin",
      upstreamProviderName: "Devin",
    });
  });

  it("parses MODEL_CLAUDE_4_5_OPUS_THINKING", () => {
    expect(
      parseDevinModelSlug("MODEL_CLAUDE_4_5_OPUS_THINKING", "MODEL_CLAUDE_4_5_OPUS_THINKING"),
    ).toEqual({
      baseSlug: "MODEL_CLAUDE_4_5_OPUS",
      baseName: "Claude Opus 4.5",
      effort: null,
      fast: false,
      thinking: true,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses MODEL_PRIVATE_11 with catalog display name", () => {
    expect(parseDevinModelSlug("MODEL_PRIVATE_11", "MODEL_PRIVATE_11")).toEqual({
      baseSlug: "MODEL_PRIVATE_11",
      baseName: "Claude Haiku 4.5",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("merges MODEL_PRIVATE_3 into the MODEL_PRIVATE_2 Sonnet 4.5 family", () => {
    expect(normalizeDevinModelDisplayName("MODEL_PRIVATE_3", "MODEL_PRIVATE_3")).toBe(
      "Claude Sonnet 4.5 Thinking",
    );
    expect(parseDevinModelSlug("MODEL_PRIVATE_3", "MODEL_PRIVATE_3")).toEqual({
      baseSlug: "MODEL_PRIVATE_2",
      baseName: "Claude Sonnet 4.5",
      effort: null,
      fast: false,
      thinking: true,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_3", "Claude Sonnet 4.5 Thinking")).toEqual({
      baseSlug: "MODEL_PRIVATE_2",
      baseName: "Claude Sonnet 4.5",
      effort: null,
      fast: false,
      thinking: true,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_2", "Claude Sonnet 4.5")).toEqual({
      baseSlug: "MODEL_PRIVATE_2",
      baseName: "Claude Sonnet 4.5",
      effort: null,
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    });
  });

  it("parses MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH", () => {
    expect(
      parseDevinModelSlug(
        "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
        "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
      ),
    ).toEqual({
      baseSlug: "MODEL_GOOGLE_GEMINI_3_0_FLASH",
      baseName: "Gemini 3 Flash",
      effort: "high",
      fast: false,
      thinking: false,
      contextWindow: null,
      upstreamProviderId: "google",
      upstreamProviderName: "Google",
    });
  });

  // Edge: empty/invalid input
  it("returns null for empty slug", () => {
    expect(parseDevinModelSlug("", "")).toBeNull();
    expect(parseDevinModelSlug("  ", "  ")).toBeNull();
  });
});
