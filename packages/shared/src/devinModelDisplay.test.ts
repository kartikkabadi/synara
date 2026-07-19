import { describe, expect, it } from "vitest";

import {
  formatDevinModelSlugDisplay,
  normalizeDevinModelDisplayName,
  resolveDevinModelDisplayName,
} from "./devinModelDisplay";
import { normalizeDevinModelVariantBaseId } from "./devinModelVariants";

describe("formatDevinModelSlugDisplay", () => {
  it("formats unknown legacy MODEL_* slugs", () => {
    expect(formatDevinModelSlugDisplay("MODEL_SWE_1_5")).toBe("SWE 1.5");
    expect(formatDevinModelSlugDisplay("MODEL_PRIVATE_11")).toBe("Private 11");
    expect(formatDevinModelSlugDisplay("MODEL_GPT_5_2")).toBe("GPT 5.2");
  });

  it("formats kebab-case slugs", () => {
    expect(formatDevinModelSlugDisplay("swe-1-6")).toBe("SWE 1.6");
    expect(formatDevinModelSlugDisplay("claude-opus-4-8")).toBe("Claude Opus 4.8");
  });
});

describe("resolveDevinModelDisplayName", () => {
  it("uses the live ACP catalog for legacy MODEL_* base slugs", () => {
    expect(resolveDevinModelDisplayName("MODEL_SWE_1_5", "MODEL_SWE_1_5")).toBe("SWE 1.5");
    expect(resolveDevinModelDisplayName("MODEL_GPT_5_2", "MODEL_GPT_5_2")).toBe("GPT-5.2");
    expect(resolveDevinModelDisplayName("MODEL_GOOGLE_GEMINI_3_0_FLASH")).toBe("Gemini 3 Flash");
    expect(resolveDevinModelDisplayName("MODEL_CLAUDE_4_5_OPUS")).toBe("Claude Opus 4.5");
  });

  it("resolves variant slugs to their base display names", () => {
    expect(resolveDevinModelDisplayName("MODEL_SWE_1_5_SLOW")).toBe("SWE 1.5");
    expect(resolveDevinModelDisplayName("claude-opus-4-8-high-fast")).toBe("Claude Opus 4.8");
    expect(resolveDevinModelDisplayName("gpt-5-3-codex-low-priority")).toBe("GPT-5.3 Codex");
  });

  it("keeps distinct ACP-provided labels", () => {
    expect(resolveDevinModelDisplayName("swe-1-6", "SWE 1.6")).toBe("SWE 1.6");
    expect(resolveDevinModelDisplayName("deepseek-v4", "DeepSeek V4 Pro")).toBe("DeepSeek V4 Pro");
  });

  it("maps private codenames", () => {
    expect(resolveDevinModelDisplayName("MODEL_PRIVATE_3")).toBe("Claude Sonnet 4.5 Thinking");
    expect(resolveDevinModelDisplayName("MODEL_PRIVATE_2")).toBe("Claude Sonnet 4.5");
    expect(resolveDevinModelDisplayName("MODEL_PRIVATE_11")).toBe("Claude Haiku 4.5");
  });

  it("covers the public Devin ACP catalog slugs", () => {
    expect(resolveDevinModelDisplayName("adaptive")).toBe("Adaptive");
    expect(resolveDevinModelDisplayName("claude-5-fable")).toBe("Claude 5 Fable");
    expect(resolveDevinModelDisplayName("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(resolveDevinModelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(resolveDevinModelDisplayName("gemini-3-5-flash")).toBe("Gemini 3.5 Flash");
    expect(resolveDevinModelDisplayName("glm-5-2")).toBe("GLM-5.2");
    expect(resolveDevinModelDisplayName("gpt-5-5")).toBe("GPT-5.5");
    expect(resolveDevinModelDisplayName("kimi-k2-7")).toBe("Kimi K2.7");
    expect(resolveDevinModelDisplayName("haiku-4-5")).toBe("Claude Haiku 4.5");
  });
});

describe("normalizeDevinModelVariantBaseId", () => {
  it("collapses legacy Sonnet 4.5 thinking alias to the shared base slug", () => {
    expect(normalizeDevinModelVariantBaseId("MODEL_PRIVATE_3")).toBe("MODEL_PRIVATE_2");
    expect(normalizeDevinModelVariantBaseId("MODEL_PRIVATE_2")).toBe("MODEL_PRIVATE_2");
  });
});

describe("normalizeDevinModelDisplayName", () => {
  it("delegates to resolveDevinModelDisplayName", () => {
    expect(normalizeDevinModelDisplayName("MODEL_SWE_1_5", "MODEL_SWE_1_5")).toBe("SWE 1.5");
  });
});
