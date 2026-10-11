import type { ProviderCompactionCapabilities } from "@synara/contracts";

// Legacy boolean consumed by older clients; derived from `compaction.manual.mode`.
export function supportsThreadCompactionFromCompaction(
  compaction: ProviderCompactionCapabilities,
): boolean {
  return compaction.manual.mode === "same-session" || compaction.manual.mode === "session-rollover";
}
