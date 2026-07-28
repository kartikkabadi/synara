import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderCompactionCapabilities,
  ProviderComposerCapabilities,
  supportsThreadCompactionFromCompaction,
  ProviderListModelsResult,
} from "./providerDiscovery";

const decodeProviderListModelsResult = Schema.decodeUnknownSync(ProviderListModelsResult);
const decodeProviderComposerCapabilities = Schema.decodeUnknownSync(ProviderComposerCapabilities);

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

describe("ProviderComposerCapabilities", () => {
  it("decodes the structured compaction descriptor", () => {
    const capabilities = decodeProviderComposerCapabilities({
      provider: "codex",
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: true,
      supportsPluginDiscovery: true,
      supportsRuntimeModelList: true,
      compaction: codexCompaction,
      supportsThreadCompaction: true,
      supportsThreadImport: true,
    });

    expect(capabilities.compaction.manual.mode).toBe("same-session");
    expect(capabilities.compaction.automatic.mode).toBe("native");
    expect(capabilities.compaction.telemetry.contextUsage).toBe("exact");
    expect(capabilities.supportsThreadCompaction).toBe(true);
  });
});

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

describe("ProviderListModelsResult", () => {
  it("preserves optional runtime model descriptions", () => {
    const result = decodeProviderListModelsResult({
      models: [
        {
          slug: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: "0.4x Factory token rate",
        },
        {
          slug: "custom:GPT-5.6-Luna-0",
          name: "GPT-5.6 Luna",
        },
      ],
      source: "droid-acp",
    });

    expect(result.models[0]?.description).toBe("0.4x Factory token rate");
    expect(result.models[1]?.description).toBeUndefined();
  });
});
