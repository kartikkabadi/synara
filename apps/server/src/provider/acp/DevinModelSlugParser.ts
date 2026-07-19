/**
 * DevinModelSlugParser - extracts base family from Devin model slugs.
 *
 * Devin ACP returns ~105 flat model slugs. Each slug encodes a base model
 * family plus variant dimensions (effort, fast mode, context window, thinking)
 * in the slug string itself. This parser collapses variants into a common
 * base family so the model picker can group them.
 *
 * Grouping only — does NOT populate variant capability fields. Devin slugs are
 * fixed configurations, not runtime-toggleable variants.
 *
 * @module DevinModelSlugParser
 */

import {
  devinModelDisplayNameOverride,
  formatDevinModelSlugDisplay,
  normalizeDevinModelDisplayName,
} from "@synara/shared/devinModelDisplay";
import { resolveDevinLegacyModelFamilyAlias } from "@synara/shared/devinModelVariants";

export { normalizeDevinModelDisplayName } from "@synara/shared/devinModelDisplay";

const MODE_VALUES = new Set(["accept-edits", "ask", "bypass", "plan"]);

const SLUG_VARIANT_TOKENS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
  "minimal",
  "slow",
  "fast",
  "priority",
  "lightning",
  "thinking",
  "1m",
  "nvfp4",
]);

const EFFORT_TOKENS = new Set(["low", "medium", "high", "xhigh", "max", "none", "minimal", "slow"]);

const FAST_TOKENS = new Set(["fast", "priority", "lightning"]);

const DISPLAY_VARIANT_WORDS = new Set([
  "fast",
  "low",
  "medium",
  "high",
  "xhigh",
  "x-high",
  "max",
  "none",
  "no",
  "minimal",
  "slow",
  "thinking",
  "1m",
  "nvfp4",
  "lightning",
]);

export interface ParsedDevinSlug {
  readonly baseSlug: string;
  readonly baseName: string;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly thinking: boolean;
  readonly contextWindow: string | null;
  readonly upstreamProviderId?: string | undefined;
  readonly upstreamProviderName?: string | undefined;
}

function inferUpstreamProvider(
  baseSlug: string,
  displayName: string,
): { id: string; name: string } | undefined {
  const s = `${baseSlug} ${displayName}`.toLowerCase();
  if (s.includes("moonshot") || s.includes("kimi")) return { id: "moonshot", name: "Moonshot AI" };
  if (s.includes("z.ai") || s.includes("z ai") || s.includes("glm")) {
    return { id: "z-ai", name: "Z.AI" };
  }
  if (s.includes("claude") || s.includes("sonnet") || s.includes("opus") || s.includes("haiku")) {
    return { id: "anthropic", name: "Anthropic" };
  }
  if (s.includes("gpt") || s.startsWith("o1") || s.startsWith("o3")) {
    return { id: "openai", name: "OpenAI" };
  }
  if (s.includes("gemini")) return { id: "google", name: "Google" };
  if (s.includes("deepseek")) return { id: "deepseek", name: "DeepSeek" };
  if (s.includes("grok")) return { id: "xai", name: "SpaceXAI" };
  if (s.includes("inkling")) return { id: "thinking-machines", name: "Thinking Machines" };
  if (s.includes("nemotron")) return { id: "nvidia", name: "NVIDIA" };
  if (s.includes("swe") || s.includes("adaptive")) return { id: "devin", name: "Devin" };
  return undefined;
}

export function parseDevinModelSlug(slug: string, displayName: string): ParsedDevinSlug | null {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return null;
  if (MODE_VALUES.has(trimmedSlug)) return null;

  const isModelPrefix = trimmedSlug.startsWith("MODEL_");
  const sep = isModelPrefix ? "_" : "-";
  const trimmedDisplayName = displayName.trim();
  const slugEchoed =
    trimmedDisplayName.length > 0 && trimmedDisplayName.toLowerCase() === trimmedSlug.toLowerCase();
  const normalizedName = slugEchoed
    ? normalizeDevinModelDisplayName(trimmedSlug, displayName)
    : trimmedDisplayName;
  const hadDisplayOverride = slugEchoed && isModelPrefix;

  // Strip variant suffixes from the right to get baseSlug (guard: keep >= 1 part).
  // Capture what was stripped into variant dimensions (first occurrence wins).
  const parts = trimmedSlug.split(sep);
  let effort: string | null = null;
  let fast = false;
  let thinking = false;
  let contextWindow: string | null = null;
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!last || !SLUG_VARIANT_TOKENS.has(last.toLowerCase())) break;
    const token = last.toLowerCase();
    if (EFFORT_TOKENS.has(token) && effort === null) {
      effort = token;
    } else if (FAST_TOKENS.has(token) && !fast) {
      fast = true;
    } else if (token === "thinking" && !thinking) {
      thinking = true;
    } else if (token === "1m" && contextWindow === null) {
      contextWindow = "1m";
    }
    parts.pop();
  }
  const baseSlug = parts.join(sep);

  // Strip variant words from the right of the display name to get baseName.
  const trimmedName = normalizedName.trim();
  let baseName: string | undefined;
  if (trimmedName) {
    if (hadDisplayOverride) {
      baseName = trimmedName;
    } else {
      const tokens = trimmedName.split(/\s+/);
      while (tokens.length > 0) {
        const last = tokens[tokens.length - 1];
        if (!last || !DISPLAY_VARIANT_WORDS.has(last.toLowerCase())) break;
        tokens.pop();
      }
      const stripped = tokens.join(" ").trim();
      if (stripped && stripped !== trimmedSlug) {
        baseName = stripped;
      }
    }
  }

  if (!baseName) {
    baseName = formatDevinModelSlugDisplay(baseSlug);
  }

  const upstream = inferUpstreamProvider(baseSlug, normalizedName);

  const familyAlias = resolveDevinLegacyModelFamilyAlias(trimmedSlug);
  if (familyAlias) {
    return {
      baseSlug: familyAlias.baseSlug,
      baseName: devinModelDisplayNameOverride(familyAlias.baseSlug) ?? baseName,
      effort,
      fast,
      thinking: familyAlias.thinking || thinking,
      contextWindow,
      upstreamProviderId: upstream?.id,
      upstreamProviderName: upstream?.name,
    };
  }

  return {
    baseSlug,
    baseName,
    effort,
    fast,
    thinking,
    contextWindow,
    upstreamProviderId: upstream?.id,
    upstreamProviderName: upstream?.name,
  };
}
