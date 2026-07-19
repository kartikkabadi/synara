/** Legacy Devin slugs that share a picker row but lack `-thinking` suffixes. */
const DEVIN_LEGACY_FAMILY_ALIASES: Readonly<
  Record<string, { readonly baseSlug: string; readonly thinking: boolean }>
> = {
  MODEL_PRIVATE_3: { baseSlug: "MODEL_PRIVATE_2", thinking: true },
};

export function resolveDevinLegacyModelFamilyAlias(
  slug: string,
): { baseSlug: string; thinking: boolean } | null {
  const trimmed = slug.trim();
  const alias = DEVIN_LEGACY_FAMILY_ALIASES[trimmed];
  return alias ? { baseSlug: alias.baseSlug, thinking: alias.thinking } : null;
}

const DEVIN_VARIANT_TOKENS = new Set([
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
  "thinking",
  "1m",
  "nvfp4",
]);

export function normalizeDevinModelVariantBaseId(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }
  const familyAlias = resolveDevinLegacyModelFamilyAlias(trimmed);
  if (familyAlias) {
    return familyAlias.baseSlug;
  }
  const isModelPrefix = trimmed.startsWith("MODEL_");
  const sep = isModelPrefix ? "_" : "-";
  const parts = trimmed.split(sep);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!last || !DEVIN_VARIANT_TOKENS.has(last.toLowerCase())) {
      break;
    }
    parts.pop();
  }
  return parts.join(sep);
}
