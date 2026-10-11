import type { ProviderCompactionCapabilities } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { supportsThreadCompactionFromCompaction } from "./providerCompaction";

const codexCompaction: ProviderCompactionCapabilities = {
  manual: {
    mode: "same-session",
    mechanism: "native-rpc",
    supportsInstructions: false,
  },
  automatic: {
    mode: "native",
    enabledByDefault: true,
    statusVisibility: "exact",
    triggerVisibility: "exact",
  },
  telemetry: {
    lifecycle: "native",
    contextUsage: "exact",
  },
};

describe("supportsThreadCompactionFromCompaction", () => {
  it("derives the legacy boolean from the manual compaction mode", () => {
    expect(supportsThreadCompactionFromCompaction(codexCompaction)).toBe(true);
    expect(
      supportsThreadCompactionFromCompaction({
        ...codexCompaction,
        manual: { ...codexCompaction.manual, mode: "session-rollover" },
      }),
    ).toBe(true);
    expect(
      supportsThreadCompactionFromCompaction({
        ...codexCompaction,
        manual: {
          mode: "unsupported",
          mechanism: "unsupported",
          supportsInstructions: false,
        },
      }),
    ).toBe(false);
  });
});
