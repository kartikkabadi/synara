import { describe, expect, it } from "vitest";
import type { ProviderCompactionCapabilities } from "@synara/contracts";

import type { ThreadCompactionOperation } from "../../persistence/Services/ThreadCompactionOperations.ts";
import {
  compactionSummaryFromOperation,
  deriveThreadCompactionRuntimeStatus,
} from "./compactionRuntimeStatus.ts";

const nativeCapabilities: ProviderCompactionCapabilities = {
  manual: { mode: "same-session", mechanism: "native-rpc", supportsInstructions: true },
  automatic: { mode: "native", statusVisibility: "partial", triggerVisibility: "derived" },
  telemetry: { lifecycle: "native", contextUsage: "exact" },
};

const noAutoCapabilities: ProviderCompactionCapabilities = {
  manual: { mode: "unsupported", mechanism: "unsupported", supportsInstructions: false },
  automatic: { mode: "none", statusVisibility: "none", triggerVisibility: "opaque" },
  telemetry: { lifecycle: "none", contextUsage: "none" },
};

describe("deriveThreadCompactionRuntimeStatus", () => {
  it("reports provider ownership with the Claude absolute trigger", () => {
    const status = deriveThreadCompactionRuntimeStatus({
      provider: "claudeAgent",
      capabilities: nativeCapabilities,
      contextWindowMaxTokens: 200_000,
    });
    expect(status.owner).toBe("provider");
    expect(status.providerAutoEnabled).toBe(true);
    expect(status.manualAvailability.available).toBe(true);
    expect(status.trigger).toEqual({ kind: "absolute-used-tokens", usedTokens: 200_000 });
  });

  it("reports the Grok percent and Pi reserve triggers", () => {
    expect(
      deriveThreadCompactionRuntimeStatus({ provider: "grok", capabilities: nativeCapabilities })
        .trigger,
    ).toEqual({ kind: "percent", percent: 85 });
    expect(
      deriveThreadCompactionRuntimeStatus({ provider: "pi", capabilities: nativeCapabilities })
        .trigger,
    ).toEqual({ kind: "remaining-tokens", reserveTokens: 16_384 });
  });

  it("reports an opaque trigger for Codex and OpenCode", () => {
    for (const provider of ["codex", "opencode", "kilo"]) {
      expect(
        deriveThreadCompactionRuntimeStatus({ provider, capabilities: nativeCapabilities }).trigger,
      ).toEqual({ kind: "opaque" });
    }
  });

  it("reports no owner or trigger when the provider has no native pass", () => {
    const status = deriveThreadCompactionRuntimeStatus({
      provider: "cursor",
      capabilities: noAutoCapabilities,
    });
    expect(status.owner).toBe("none");
    expect(status.providerAutoEnabled).toBe(false);
    expect(status.trigger).toBeUndefined();
    expect(status.manualAvailability).toMatchObject({ available: false });
  });

  it("reports unknown auto state without capabilities", () => {
    const status = deriveThreadCompactionRuntimeStatus({ provider: null, capabilities: null });
    expect(status.owner).toBe("none");
    expect(status.providerAutoEnabled).toBeNull();
    expect(status.manualAvailability.available).toBe(false);
  });
});

describe("compactionSummaryFromOperation", () => {
  const baseOperation: ThreadCompactionOperation = {
    threadId: "thread-1",
    requestId: "req-1",
    status: "completed",
    owner: "provider",
    trigger: "provider-auto",
    sessionEffect: "same-session",
    failureKind: null,
    detail: null,
    retryable: null,
    outcomeKnown: null,
    beforeUsage: null,
    afterUsage: null,
    requestedAt: null,
    startedAt: "2026-03-23T00:00:00.000Z",
    completedAt: "2026-03-23T00:00:01.000Z",
    updatedAt: "2026-03-23T00:00:01.000Z",
  };

  it("summarizes a settled operation", () => {
    expect(compactionSummaryFromOperation(baseOperation)).toEqual({
      requestId: "req-1",
      owner: "provider",
      trigger: "provider-auto",
      result: "completed",
      sessionEffect: "same-session",
      startedAt: "2026-03-23T00:00:00.000Z",
      completedAt: "2026-03-23T00:00:01.000Z",
    });
  });

  it("marks failed and uncertain operations as failed with detail", () => {
    const summary = compactionSummaryFromOperation({
      ...baseOperation,
      status: "uncertain",
      sessionEffect: null,
      detail: "outcome unknown",
    });
    expect(summary).toMatchObject({ result: "failed", failureDetail: "outcome unknown" });
  });

  it("yields null for unsettled operations", () => {
    expect(compactionSummaryFromOperation({ ...baseOperation, status: "running" })).toBeNull();
  });
});
