import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderCompactionCapabilities,
  ProviderComposerCapabilities,
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

    expect(capabilities.compaction?.manual.mode).toBe("same-session");
    expect(capabilities.compaction?.automatic.mode).toBe("native");
    expect(capabilities.compaction?.telemetry.contextUsage).toBe("exact");
    expect(capabilities.supportsThreadCompaction).toBe(true);
  });
});

const decodeModels = Schema.decodeUnknownSync(ProviderListModelsResult);

describe("ProviderListModelsResult", () => {
  it.each([
    { roles: [{ name: "smol", model: "upstream/model", thinkingLevel: "high" }] },
    { roles: [{ name: "", model: null, thinkingLevel: "retired-level" }] },
    { roles: "invalid legacy roles" },
    { roles: null },
  ])("strips legacy roles without discarding model metadata: %j", ({ roles }) => {
    const catalog = {
      models: [
        {
          slug: "upstream/model",
          name: "Model",
          upstreamProviderId: "upstream",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
        },
      ],
      source: "omp-cli",
      cached: true,
    };

    expect(decodeModels({ ...catalog, roles })).toEqual(catalog);
  });

  it("still rejects an invalid model catalog when legacy roles are present", () => {
    expect(() => decodeModels({ models: "invalid", roles: [] })).toThrow();
  });
});
