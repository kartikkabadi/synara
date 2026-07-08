import type { ProviderComposerCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { supportsRollback } from "./providerDiscoveryReactQuery";

const baseCapabilities = {
  provider: "devin",
  supportsSkillMentions: false,
  supportsSkillDiscovery: false,
  supportsNativeSlashCommandDiscovery: false,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: true,
  supportsThreadCompaction: true,
  supportsRollback: true,
} as const satisfies ProviderComposerCapabilities;

describe("supportsRollback", () => {
  it("is false while capabilities are still loading", () => {
    expect(supportsRollback(undefined)).toBe(false);
  });

  it("is false when the provider explicitly disables rollback", () => {
    expect(supportsRollback({ ...baseCapabilities, supportsRollback: false })).toBe(false);
  });

  it("defaults to true once capabilities have loaded without an explicit false", () => {
    const { supportsRollback: _omit, ...withoutFlag } = baseCapabilities;
    expect(supportsRollback(withoutFlag)).toBe(true);
    expect(supportsRollback({ ...baseCapabilities, supportsRollback: true })).toBe(true);
  });
});
