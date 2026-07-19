import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";

import { formatModelDisplayName, humanizeModelSlug } from "./model";
import { normalizeDevinModelVariantBaseId } from "./devinModelVariants";

/** Live ACP base slugs from Devin QA discovery (2026-07-02) + known private codenames. */
const DEVIN_KNOWN_MODEL_DISPLAY_NAMES = new Map<string, string>([
  ["model_claude_4_5_opus", "Claude Opus 4.5"],
  ["model_google_gemini_3_0_flash", "Gemini 3 Flash"],
  ["model_gpt_5_2", "GPT-5.2"],
  ["model_private_11", "Claude Haiku 4.5"],
  ["model_private_2", "Claude Sonnet 4.5"],
  ["model_private_3", "Claude Sonnet 4.5 Thinking"],
  ["model_swe_1_5", "SWE 1.5"],
  ["adaptive", "Adaptive"],
  ["claude-5-fable", "Claude 5 Fable"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-opus-4-7", "Claude Opus 4.7"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["deepseek-v4", "DeepSeek V4"],
  ["gemini-3-1-pro", "Gemini 3.1 Pro"],
  ["gemini-3-5-flash", "Gemini 3.5 Flash"],
  ["glm-5-1", "GLM-5.1"],
  ["glm-5-2", "GLM-5.2"],
  ["gpt-5-3-codex", "GPT-5.3 Codex"],
  ["gpt-5-4", "GPT-5.4"],
  ["gpt-5-4-mini", "GPT-5.4 Mini"],
  ["gpt-5-5", "GPT-5.5"],
  ["kimi-k2-6", "Kimi K2.6"],
  ["kimi-k2-7", "Kimi K2.7"],
  ["swe-1-6", "SWE 1.6"],
  ["sonnet-4-5", "Claude Sonnet 4.5"],
  ["haiku-4-5", "Claude Haiku 4.5"],
  ["claude-opus-4-5", "Claude Opus 4.5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
]);

for (const option of MODEL_OPTIONS_BY_PROVIDER.devin) {
  DEVIN_KNOWN_MODEL_DISPLAY_NAMES.set(option.slug.toLowerCase(), option.name);
}

function lookupDevinDisplayName(slug: string): string | undefined {
  return DEVIN_KNOWN_MODEL_DISPLAY_NAMES.get(slug.trim().toLowerCase());
}

function titleCaseWord(word: string): string {
  if (word.length <= 3) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Turn a Devin base slug (MODEL_* or kebab-case) into a picker label. */
export function formatDevinModelSlugDisplay(slug: string): string {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return trimmedSlug;

  const isModelPrefix = trimmedSlug.startsWith("MODEL_");
  const stripped = isModelPrefix ? trimmedSlug.slice("MODEL_".length) : trimmedSlug;
  const sep = isModelPrefix ? "_" : "-";
  const parts = stripped.split(sep).filter((part) => part.length > 0);
  const formatted: string[] = [];
  let numericRun: string[] = [];
  const flushNumeric = () => {
    if (numericRun.length > 0) {
      formatted.push(numericRun.join("."));
      numericRun = [];
    }
  };
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      numericRun.push(part);
    } else {
      flushNumeric();
      formatted.push(titleCaseWord(part));
    }
  }
  flushNumeric();
  return formatted.join(" ");
}

export function resolveDevinModelDisplayName(
  slug: string,
  displayName: string | null | undefined = undefined,
): string {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return trimmedSlug;

  const trimmedName = displayName?.trim() ?? "";
  if (trimmedName.length > 0 && trimmedName.toLowerCase() !== trimmedSlug.toLowerCase()) {
    return trimmedName;
  }

  const knownExact = lookupDevinDisplayName(trimmedSlug);
  if (knownExact) return knownExact;

  const baseSlug = normalizeDevinModelVariantBaseId(trimmedSlug) ?? trimmedSlug;
  const known = lookupDevinDisplayName(baseSlug);
  if (known) return known;

  const catalogName = formatModelDisplayName(baseSlug);
  if (catalogName && catalogName !== humanizeModelSlug(baseSlug)) {
    return catalogName;
  }

  return formatDevinModelSlugDisplay(baseSlug);
}

export function normalizeDevinModelDisplayName(slug: string, displayName: string): string {
  return resolveDevinModelDisplayName(slug, displayName);
}

export function devinModelDisplayNameOverride(slug: string): string | undefined {
  const baseSlug = normalizeDevinModelVariantBaseId(slug) ?? slug;
  return lookupDevinDisplayName(baseSlug) ?? lookupDevinDisplayName(slug);
}
