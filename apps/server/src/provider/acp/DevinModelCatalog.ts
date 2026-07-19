/**
 * DevinModelCatalog - Devin model fallback data.
 *
 * PROVENANCE: This is a snapshot of the models advertised by `devin acp`
 * (Devin CLI) as of 2026-06. It is FALLBACK DATA ONLY — the authoritative
 * model list comes from the live ACP session's "model" config option
 * (see listModels in Layers/DevinAdapter.ts). Update this snapshot only when
 * Devin's defaults change; never let UI or tests treat it as runtime truth.
 *
 * @module DevinModelCatalog
 */
import {
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelCapabilities,
} from "@synara/contracts";
import {
  DEFAULT_DEVIN_CONTEXT_WINDOW_LABEL,
  devinModelDisplayNameOverride,
  formatDevinModelSlugDisplay,
  normalizeDevinModelDisplayName,
  resolveDevinLegacyModelFamilyAlias,
} from "@synara/shared/devinModel";

export {
  DEFAULT_DEVIN_CONTEXT_WINDOW_LABEL,
  normalizeDevinModelDisplayName,
} from "@synara/shared/devinModel";

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

function trimOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const DEVIN_FALLBACK_MODELS = MODEL_OPTIONS_BY_PROVIDER.devin.map((option) => {
  const { reasoningEffortLevels, supportsFastMode, supportsThinkingToggle, contextWindowOptions } =
    option.capabilities as ModelCapabilities;

  const supportedReasoningEfforts =
    reasoningEffortLevels.length > 0
      ? reasoningEffortLevels.map((effort) => ({
          value: effort.value,
          label: effort.label,
          description: effort.description,
        }))
      : undefined;
  const defaultReasoningEffort = reasoningEffortLevels.find((effort) => effort.isDefault)?.value;

  const mappedContextWindowOptions =
    contextWindowOptions.length > 0
      ? contextWindowOptions.map((window) => ({
          value: window.value,
          label: window.label,
          isDefault: window.isDefault,
        }))
      : undefined;
  const defaultContextWindow = contextWindowOptions.find((window) => window.isDefault)?.value;

  const parsed = parseDevinModelSlug(option.slug, option.name);

  return {
    slug: option.slug,
    name: option.name,
    upstreamProviderId: parsed?.upstreamProviderId,
    upstreamProviderName: parsed?.upstreamProviderName,
    ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(supportsFastMode ? { supportsFastMode: true } : {}),
    ...(supportsThinkingToggle ? { supportsThinkingToggle: true } : {}),
    ...(mappedContextWindowOptions ? { contextWindowOptions: mappedContextWindowOptions } : {}),
    ...(defaultContextWindow ? { defaultContextWindow } : {}),
  };
});

export function normalizeDevinModelSlug(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  const aliased = MODEL_SLUG_ALIASES_BY_PROVIDER.devin[lower];
  if (typeof aliased === "string") return aliased;
  // Backward compatibility: legacy persisted selections may include a
  // removed `-medium` variant suffix that no longer exists in Devin slugs.
  if (lower.endsWith("-medium")) {
    const base = lower.slice(0, -"-medium".length);
    const baseAliased = MODEL_SLUG_ALIASES_BY_PROVIDER.devin[base];
    return typeof baseAliased === "string" ? baseAliased : base;
  }
  return trimmed;
}

export interface DevinModelVariant {
  readonly slug: string;
  readonly name: string;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly thinking: boolean;
  readonly contextWindow: string | null;
}

export interface DevinBaseModel {
  readonly baseSlug: string;
  readonly baseName: string;
  readonly variants: ReadonlyArray<DevinModelVariant>;
  readonly supportedEfforts: ReadonlyArray<string>;
  readonly supportsFastMode: boolean;
  readonly supportsThinking: boolean;
  readonly contextWindowOptions: ReadonlyArray<string>;
  readonly defaultVariant: DevinModelVariant;
  readonly upstreamProviderId?: string | undefined;
  readonly upstreamProviderName?: string | undefined;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "none", "minimal", "slow"];
const EFFORT_RANK = new Map(EFFORT_ORDER.map((e, i) => [e, i]));

export function buildDevinVariantMatrix(
  models: ReadonlyArray<{
    slug: string;
    name: string;
    upstreamProviderId?: string | undefined;
    upstreamProviderName?: string | undefined;
    groupId?: string | undefined;
    groupName?: string | undefined;
  }>,
): ReadonlyMap<string, DevinBaseModel> {
  // Pair each model with its parsed result so variants retain the original slug/name.
  type Entry = {
    slug: string;
    name: string;
    upstreamProviderId?: string | undefined;
    upstreamProviderName?: string | undefined;
    groupId?: string | undefined;
    groupName?: string | undefined;
    parsed: ParsedDevinSlug;
  };
  const groups = new Map<string, Entry[]>();
  for (const model of models) {
    const parsed = parseDevinModelSlug(model.slug, model.name);
    if (!parsed) continue;
    const entry: Entry = { ...model, parsed };
    const group = groups.get(parsed.baseSlug);
    if (group) {
      group.push(entry);
    } else {
      groups.set(parsed.baseSlug, [entry]);
    }
  }

  const matrix = new Map<string, DevinBaseModel>();
  for (const [baseSlug, entries] of groups) {
    const variants: DevinModelVariant[] = entries.map((e) => ({
      slug: e.slug,
      name: e.name,
      effort: e.parsed.effort,
      fast: e.parsed.fast,
      thinking: e.parsed.thinking,
      contextWindow: e.parsed.contextWindow,
    }));

    const effortSet = new Set<string>();
    const contextSet = new Set<string>();
    let supportsFastMode = false;
    let supportsThinking = false;
    for (const v of variants) {
      if (v.effort !== null) effortSet.add(v.effort);
      if (v.fast) supportsFastMode = true;
      if (v.thinking) supportsThinking = true;
      if (v.contextWindow !== null) contextSet.add(v.contextWindow);
    }
    const supportedEfforts = [...effortSet].sort(
      (a, b) =>
        (EFFORT_RANK.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (EFFORT_RANK.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    const contextWindowOptions = [...contextSet];

    const bare = variants.find(
      (v) => v.effort === null && !v.fast && !v.thinking && v.contextWindow === null,
    );
    const medium = variants.find((v) => v.effort === "medium");
    const defaultVariant: DevinModelVariant = bare ?? medium ?? variants[0]!;

    const entriesBySlug = [...entries].sort((a, b) =>
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
    );
    const pickEntryValue = (selector: (entry: Entry) => string | undefined): string | undefined => {
      for (const entry of entriesBySlug) {
        const value = trimOptionalString(selector(entry));
        if (value) return value;
      }
      return undefined;
    };
    const baseName =
      pickEntryValue((entry) => entry.parsed.baseName) ?? entriesBySlug[0]!.parsed.baseName;

    matrix.set(baseSlug, {
      baseSlug,
      baseName,
      variants,
      supportedEfforts,
      supportsFastMode,
      supportsThinking,
      contextWindowOptions,
      defaultVariant,
      upstreamProviderId:
        pickEntryValue((entry) => entry.groupId) ??
        pickEntryValue((entry) => entry.upstreamProviderId) ??
        pickEntryValue((entry) => entry.parsed.upstreamProviderId),
      upstreamProviderName:
        pickEntryValue((entry) => entry.groupName) ??
        pickEntryValue((entry) => entry.upstreamProviderName) ??
        pickEntryValue((entry) => entry.parsed.upstreamProviderName),
    });
  }
  return matrix;
}

export function resolveDevinModelSlug(
  model: string,
  options:
    | { reasoningEffort?: string; fastMode?: boolean; thinking?: boolean; contextWindow?: string }
    | undefined,
  matrix: ReadonlyMap<string, DevinBaseModel>,
): string | null {
  const base = matrix.get(model);
  if (!base) return model;

  const hasOptions =
    options !== undefined &&
    (options.reasoningEffort !== undefined ||
      options.fastMode !== undefined ||
      options.thinking !== undefined ||
      options.contextWindow !== undefined);
  if (!hasOptions) return base.defaultVariant.slug;

  const targetEffort = options.reasoningEffort ?? base.defaultVariant.effort;
  const targetFast = options.fastMode ?? base.defaultVariant.fast;
  const targetThinking = options.thinking ?? base.defaultVariant.thinking;
  const rawContext = options.contextWindow ?? base.defaultVariant.contextWindow;
  const targetContext = rawContext === DEFAULT_DEVIN_CONTEXT_WINDOW_LABEL ? null : rawContext;

  const exact = base.variants.find(
    (v) =>
      v.effort === targetEffort &&
      v.fast === targetFast &&
      v.thinking === targetThinking &&
      v.contextWindow === targetContext,
  );
  if (exact) return exact.slug;

  const effortOnly = base.variants.find(
    (v) => v.effort === targetEffort && !v.fast && !v.thinking && v.contextWindow === null,
  );
  if (effortOnly) return effortOnly.slug;

  return base.defaultVariant.slug;
}
