// FILE: ContextWindowMeter.test.tsx
// Purpose: Guards the context meter's compaction copy so capability claims
//   come from the structured compaction descriptor, not blanket snapshot flags.
// Layer: Component rendering tests
// Depends on: ContextWindowMeter and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderCompactionCapabilities } from "@synara/contracts";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeterDetails } from "./ContextWindowMeter";

const usage: ContextWindowSnapshot = {
  usedTokens: 42_000,
  usedPercent: 21,
  totalProcessedTokens: null,
  maxTokens: 200_000,
  remainingTokens: 158_000,
  usedPercentage: 21,
  remainingPercentage: 79,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  updatedAt: "2026-03-23T00:00:00.000Z",
};

const unsupportedCompaction: ProviderCompactionCapabilities = {
  manual: {
    mode: "unsupported",
    mechanism: "unsupported",
    supportsInstructions: false,
  },
  automatic: {
    mode: "unknown",
    statusVisibility: "none",
    triggerVisibility: "opaque",
  },
  telemetry: {
    lifecycle: "none",
    contextUsage: "none",
  },
};

const nativeAutoCompaction: ProviderCompactionCapabilities = {
  ...unsupportedCompaction,
  automatic: {
    mode: "native",
    statusVisibility: "none",
    triggerVisibility: "opaque",
  },
};

describe("ContextWindowMeterDetails", () => {
  it("renders provider-managed auto compaction copy from the descriptor", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeterDetails usage={usage} compaction={nativeAutoCompaction} />,
    );
    expect(markup).toContain("Automatically compacts its context when needed.");
  });

  it("renders unavailable copy when the descriptor rules out compaction", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeterDetails usage={usage} compaction={unsupportedCompaction} />,
    );
    expect(markup).toContain("Context compaction is unavailable.");
    expect(markup).not.toContain("Automatically compacts its context when needed.");
  });

  it("falls back to the legacy snapshot flag without a descriptor", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeterDetails usage={usage} compaction={null} />,
    );
    expect(markup).toContain("Automatically compacts its context when needed.");
  });
});
