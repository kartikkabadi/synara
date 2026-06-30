import type { ProviderKind } from "@t3tools/contracts";

// Static provider compaction capability map (verified from providerDiscovery.ts +
// adapter source). Provider capabilities don't change at runtime, so a compile-time
// constant avoids a cross-service dependency on ProviderDiscoveryService.
//
// supportsCompaction: provider exposes a compact action (Synara can drive it)
// autoCompacts: provider handles compaction internally (Synara should stay out)
export const PROVIDER_COMPACTION_CAPABILITY: Record<
  ProviderKind,
  { supportsCompaction: boolean; autoCompacts: boolean }
> = {
  codex: { supportsCompaction: true, autoCompacts: true },
  claudeAgent: { supportsCompaction: false, autoCompacts: false },
  cursor: { supportsCompaction: false, autoCompacts: true },
  gemini: { supportsCompaction: false, autoCompacts: true },
  grok: { supportsCompaction: false, autoCompacts: false },
  kilo: { supportsCompaction: false, autoCompacts: false },
  opencode: { supportsCompaction: true, autoCompacts: false },
  pi: { supportsCompaction: true, autoCompacts: false },
};

// A provider can sustain a loop if it either supports compaction (Synara drives it)
// or auto-compacts (the provider handles it internally). Without one of these, the
// loop hits the context limit and stalls within a few iterations.
export function providerCanLoop(provider: ProviderKind): boolean {
  const cap = PROVIDER_COMPACTION_CAPABILITY[provider];
  return cap.supportsCompaction || cap.autoCompacts;
}
