import type { ProviderKind } from "../../packages/contracts/src/orchestration";

export interface CompactionCase {
  provider: ProviderKind;
  model: string;
  instanceId?: string;
  compaction: "manual" | "unavailable";
}

export function parseCases(raw: string | undefined, providers: readonly string[]): CompactionCase[] {
  if (!raw?.trim()) throw new Error("Set SYNARA_E2E_CASES to an explicit JSON array of provider/model cases.");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10) {
    throw new Error("SYNARA_E2E_CASES must contain between one and ten cases.");
  }
  const seen = new Set<string>();
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compaction case.");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["provider", "model", "instanceId", "compaction"].includes(key))) {
      throw new Error("Unknown compaction case field. Use provider, model, instanceId, compaction.");
    }
    if (typeof item.provider !== "string" || !providers.includes(item.provider)) {
      throw new Error("Each case must name a current provider ID exactly.");
    }
    if (typeof item.model !== "string" || !item.model.trim() || item.model !== item.model.trim() || /haiku|replace-with/i.test(item.model)) {
      throw new Error("Each case needs an explicit approved model slug; placeholders and Haiku are not allowed.");
    }
    if (item.compaction !== "manual" && item.compaction !== "unavailable") {
      throw new Error("Declare compaction as manual or unavailable for every case.");
    }
    if (item.instanceId !== undefined && (typeof item.instanceId !== "string" || !item.instanceId.trim())) {
      throw new Error("instanceId must be a nonempty provider instance ID.");
    }
    const key = JSON.stringify([item.provider, item.instanceId, item.model]);
    if (seen.has(key)) throw new Error("Duplicate provider/model case.");
    seen.add(key);
    return {
      provider: item.provider as ProviderKind,
      model: item.model,
      compaction: item.compaction,
      ...(typeof item.instanceId === "string" ? { instanceId: item.instanceId } : {}),
    };
  });
}

export function requiredRunPath(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required; launch through run.sh.`);
  return value;
}
