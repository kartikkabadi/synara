import type { ProviderKind } from "@synara/contracts";

// Keep provider capability decisions shared by the UI and server so unsupported
// automation is hidden before it reaches the command decider.
export const PROVIDER_COMPACTION_CAPABILITY: Readonly<
  Record<ProviderKind, { supportsCompaction: boolean; autoCompacts: boolean }>
> = {
  codex: { supportsCompaction: true, autoCompacts: true },
  claudeAgent: { supportsCompaction: false, autoCompacts: false },
  cursor: { supportsCompaction: false, autoCompacts: true },
  antigravity: { supportsCompaction: false, autoCompacts: false },
  grok: { supportsCompaction: false, autoCompacts: false },
  droid: { supportsCompaction: false, autoCompacts: false },
  kilo: { supportsCompaction: false, autoCompacts: false },
  opencode: { supportsCompaction: true, autoCompacts: false },
  pi: { supportsCompaction: true, autoCompacts: false },
};

export function providerCanLoop(provider: ProviderKind): boolean {
  const capability = PROVIDER_COMPACTION_CAPABILITY[provider];
  return capability.supportsCompaction || capability.autoCompacts;
}
