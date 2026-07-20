import { describe, it, assert } from "@effect/vitest";
import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";
import {
  DEVIN_FALLBACK_MODELS,
  DevinModelIncompatibilityError,
  normalizeDevinModelSlug,
  buildDevinVariantMatrix,
  resolveDevinModelSlug,
} from "./DevinModelCatalog.ts";

describe("normalizeDevinModelSlug", () => {
  it('maps "opus" to the "claude-opus-4-8" base family', () => {
    assert.strictEqual(normalizeDevinModelSlug("opus"), "claude-opus-4-8");
  });

  it('trims whitespace and lowercases input (e.g. " SWE " → "swe-1-6")', () => {
    assert.strictEqual(normalizeDevinModelSlug(" SWE "), "swe-1-6");
  });

  it("strips removed -medium variant suffixes and falls back to the base slug", () => {
    assert.strictEqual(normalizeDevinModelSlug("claude-opus-4-8-medium"), "claude-opus-4-8");
  });

  it("passes through genuinely unknown slugs unchanged", () => {
    assert.strictEqual(normalizeDevinModelSlug("unknown-model"), "unknown-model");
  });
});

describe("DEVIN_FALLBACK_MODELS", () => {
  it('contains "adaptive"', () => {
    const adaptive = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "adaptive");
    assert.ok(adaptive, "expected adaptive model entry");
    assert.strictEqual(adaptive!.name, "Adaptive");
  });

  it("every entry has non-empty slug and name", () => {
    for (const model of DEVIN_FALLBACK_MODELS) {
      assert.ok(model.slug.length > 0, `expected non-empty slug, got "${model.slug}"`);
      assert.ok(model.name.length > 0, `expected non-empty name for "${model.slug}"`);
    }
  });

  it("slugs equal MODEL_OPTIONS_BY_PROVIDER.devin slugs (no duplication)", () => {
    const contractSlugs = MODEL_OPTIONS_BY_PROVIDER.devin.map((o) => o.slug);
    const catalogSlugs = DEVIN_FALLBACK_MODELS.map((m) => m.slug);
    assert.deepStrictEqual(catalogSlugs, contractSlugs);
  });

  it("copies capabilities from the contract model definitions", () => {
    const opus = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "claude-opus-4-8");
    assert.ok(opus, "expected claude-opus-4-8 fallback entry");
    assert.ok(opus!.supportedReasoningEfforts && opus!.supportedReasoningEfforts.length > 0);
    assert.strictEqual(opus!.supportsFastMode, true);
    assert.strictEqual(opus!.contextWindowOptions, undefined);

    const deepseek = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "deepseek-v4");
    assert.ok(deepseek, "expected deepseek-v4 fallback entry");
    assert.strictEqual(deepseek!.supportedReasoningEfforts, undefined);
    assert.strictEqual(deepseek!.supportsFastMode, undefined);
  });

  it("infers upstream provider info for fallback models", () => {
    const opus = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "claude-opus-4-8");
    assert.strictEqual(opus?.upstreamProviderId, "anthropic");
    assert.strictEqual(opus?.upstreamProviderName, "Anthropic");

    const adaptive = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "adaptive");
    assert.strictEqual(adaptive?.upstreamProviderId, "devin");
    assert.strictEqual(adaptive?.upstreamProviderName, "Devin");
  });
});

const MATRIX_INPUT = [
  { slug: "claude-opus-4-8-low", name: "Claude Opus 4.8 Low" },
  { slug: "claude-opus-4-8-medium", name: "Claude Opus 4.8 Medium" },
  { slug: "claude-opus-4-8-high", name: "Claude Opus 4.8 High" },
  { slug: "claude-opus-4-8-high-fast", name: "Claude Opus 4.8 High Fast" },
  { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { slug: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
  { slug: "claude-opus-4-6-thinking-1m", name: "Claude Opus 4.6 Thinking 1M" },
  { slug: "deepseek-v4", name: "DeepSeek V4" },
  { slug: "adaptive", name: "Adaptive" },
];

describe("buildDevinVariantMatrix", () => {
  const matrix = buildDevinVariantMatrix(MATRIX_INPUT);

  it("groups claude-opus-4-8 with efforts, fast mode, medium default", () => {
    const base = matrix.get("claude-opus-4-8");
    assert.ok(base, "expected claude-opus-4-8 base");
    assert.deepStrictEqual(base!.supportedEfforts, ["low", "medium", "high"]);
    assert.strictEqual(base!.supportsFastMode, true);
    assert.strictEqual(base!.supportsThinking, false);
    assert.deepStrictEqual([...base!.contextWindowOptions], []);
    assert.strictEqual(base!.defaultVariant.slug, "claude-opus-4-8-medium");
  });

  it("groups claude-opus-4-6 with thinking, 1m context, bare default", () => {
    const base = matrix.get("claude-opus-4-6");
    assert.ok(base, "expected claude-opus-4-6 base");
    assert.deepStrictEqual([...base!.supportedEfforts], []);
    assert.strictEqual(base!.supportsFastMode, false);
    assert.strictEqual(base!.supportsThinking, true);
    assert.deepStrictEqual([...base!.contextWindowOptions], ["1m"]);
    assert.strictEqual(base!.defaultVariant.slug, "claude-opus-4-6");
  });

  it("groups deepseek-v4 as a bare single-variant base", () => {
    const base = matrix.get("deepseek-v4");
    assert.ok(base, "expected deepseek-v4 base");
    assert.deepStrictEqual([...base!.supportedEfforts], []);
    assert.strictEqual(base!.supportsFastMode, false);
    assert.strictEqual(base!.supportsThinking, false);
    assert.deepStrictEqual([...base!.contextWindowOptions], []);
    assert.strictEqual(base!.defaultVariant.slug, "deepseek-v4");
  });

  it("uses preferredDefaultSlug as the default variant when it matches an option", () => {
    const preferred = buildDevinVariantMatrix(MATRIX_INPUT, {
      preferredDefaultSlug: "claude-opus-4-8-high-fast",
    });
    const base = preferred.get("claude-opus-4-8");
    assert.ok(base, "expected claude-opus-4-8 base");
    assert.strictEqual(base!.defaultVariant.slug, "claude-opus-4-8-high-fast");
    assert.strictEqual(base!.defaultVariant.effort, "high");
    assert.strictEqual(base!.defaultVariant.fast, true);
  });

  it("falls back to the bare/medium default when preferredDefaultSlug does not match", () => {
    const preferred = buildDevinVariantMatrix(MATRIX_INPUT, {
      preferredDefaultSlug: "claude-opus-4-8-nonexistent",
    });
    const base = preferred.get("claude-opus-4-8");
    assert.ok(base, "expected claude-opus-4-8 base");
    assert.strictEqual(base!.defaultVariant.slug, "claude-opus-4-8-medium");
  });

  it("prefers group metadata for upstream provider labels", () => {
    const grouped = buildDevinVariantMatrix([
      { slug: "vendor-model-a", name: "Model A", groupId: "moonshot", groupName: "Moonshot AI" },
      { slug: "vendor-model-b", name: "Model B", groupId: "z-ai", groupName: "Z.AI" },
    ]);

    assert.strictEqual(grouped.get("vendor-model-a")?.upstreamProviderId, "moonshot");
    assert.strictEqual(grouped.get("vendor-model-a")?.upstreamProviderName, "Moonshot AI");
    assert.strictEqual(grouped.get("vendor-model-b")?.upstreamProviderId, "z-ai");
    assert.strictEqual(grouped.get("vendor-model-b")?.upstreamProviderName, "Z.AI");
  });

  it("keeps upstream provider labels stable when variant order changes", () => {
    const variants = [
      { slug: "vendor-model-a", name: "Vendor Model A" },
      {
        slug: "vendor-model-a-fast",
        name: "Vendor Model A Fast",
        groupId: "moonshot",
        groupName: "Moonshot AI",
      },
    ];

    for (const input of [variants, [...variants].reverse()]) {
      const base = buildDevinVariantMatrix(input).get("vendor-model-a");
      assert.strictEqual(base?.upstreamProviderId, "moonshot");
      assert.strictEqual(base?.upstreamProviderName, "Moonshot AI");
    }
  });

  it("formats slug-echoed legacy MODEL_* bases for single-variant families", () => {
    const matrix = buildDevinVariantMatrix([{ slug: "MODEL_SWE_1_5", name: "MODEL_SWE_1_5" }]);
    assert.strictEqual(matrix.get("MODEL_SWE_1_5")?.baseName, "SWE 1.5");
  });

  it("uses catalog names for legacy vendor slugs", () => {
    const matrix = buildDevinVariantMatrix([
      { slug: "MODEL_CLAUDE_4_5_OPUS", name: "MODEL_CLAUDE_4_5_OPUS" },
      { slug: "MODEL_GPT_5_2", name: "MODEL_GPT_5_2" },
      { slug: "MODEL_GOOGLE_GEMINI_3_0_FLASH", name: "MODEL_GOOGLE_GEMINI_3_0_FLASH" },
    ]);
    assert.strictEqual(matrix.get("MODEL_CLAUDE_4_5_OPUS")?.baseName, "Claude Opus 4.5");
    assert.strictEqual(matrix.get("MODEL_GPT_5_2")?.baseName, "GPT-5.2");
    assert.strictEqual(matrix.get("MODEL_GOOGLE_GEMINI_3_0_FLASH")?.baseName, "Gemini 3 Flash");
  });

  it("merges MODEL_PRIVATE_2 and MODEL_PRIVATE_3 into one Sonnet 4.5 family", () => {
    const matrix = buildDevinVariantMatrix([
      { slug: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
      { slug: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
    ]);
    const base = matrix.get("MODEL_PRIVATE_2");
    assert.ok(base, "expected merged Sonnet 4.5 base");
    assert.strictEqual(base!.baseName, "Claude Sonnet 4.5");
    assert.strictEqual(base!.supportsThinking, true);
    assert.strictEqual(base!.defaultVariant.slug, "MODEL_PRIVATE_2");
    assert.strictEqual(
      resolveDevinModelSlug("MODEL_PRIVATE_2", { thinking: true }, matrix),
      "MODEL_PRIVATE_3",
    );
    assert.strictEqual(
      resolveDevinModelSlug("MODEL_PRIVATE_2", { thinking: false }, matrix),
      "MODEL_PRIVATE_2",
    );
    assert.strictEqual(matrix.has("MODEL_PRIVATE_3"), false);
  });
});

describe("resolveDevinModelSlug", () => {
  const matrix = buildDevinVariantMatrix(MATRIX_INPUT);

  it("resolves effort+fast to exact variant slug", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", { reasoningEffort: "high", fastMode: true }, matrix),
      "claude-opus-4-8-high-fast",
    );
  });

  it("resolves effort-only to exact variant slug", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", { reasoningEffort: "high" }, matrix),
      "claude-opus-4-8-high",
    );
  });

  it("resolves undefined options to default variant", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", undefined, matrix),
      "claude-opus-4-8-medium",
    );
  });

  it("returns incompatibility when fast-only target has no exact match", () => {
    const result = resolveDevinModelSlug("claude-opus-4-8", { fastMode: true }, matrix);
    assert.ok(result instanceof DevinModelIncompatibilityError);
    assert.strictEqual((result as DevinModelIncompatibilityError).baseSlug, "claude-opus-4-8");
  });

  it("resolves thinking+context to exact variant slug", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-6", { thinking: true, contextWindow: "1m" }, matrix),
      "claude-opus-4-6-thinking-1m",
    );
  });

  it("resolves undefined options to bare default for claude-opus-4-6", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-6", undefined, matrix),
      "claude-opus-4-6",
    );
  });

  it("resolves undefined options to bare default for deepseek-v4", () => {
    assert.strictEqual(resolveDevinModelSlug("deepseek-v4", undefined, matrix), "deepseek-v4");
  });

  it("passes through unknown slugs unchanged", () => {
    assert.strictEqual(resolveDevinModelSlug("unknown-slug", undefined, matrix), "unknown-slug");
  });

  it("passes through full variant slugs unchanged (not a base slug)", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8-high-fast", undefined, matrix),
      "claude-opus-4-8-high-fast",
    );
  });
});
