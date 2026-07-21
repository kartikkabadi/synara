import type {
  ProviderCompactionCapabilities,
  SynaraAutoCompactionOptions,
  ThreadCompactionRuntimeStatus,
  ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { decideAutoCompaction } from "./decideCompaction.ts";

const manualCapability: ProviderCompactionCapabilities = {
  manual: { mode: "same-session", mechanism: "native-rpc", supportsInstructions: true },
  automatic: { mode: "none", statusVisibility: "none", triggerVisibility: "opaque" },
  telemetry: { lifecycle: "none", contextUsage: "exact" },
};

const nativeCapability: ProviderCompactionCapabilities = {
  ...manualCapability,
  automatic: { mode: "native", statusVisibility: "partial", triggerVisibility: "derived" },
};

const unsupportedCapability: ProviderCompactionCapabilities = {
  ...manualCapability,
  manual: { mode: "unsupported", mechanism: "unsupported", supportsInstructions: false },
};

const idleStatus: ThreadCompactionRuntimeStatus = {
  owner: "synara",
  providerAutoEnabled: false,
  manualAvailability: { available: true },
  phase: { status: "idle" },
};

const options: SynaraAutoCompactionOptions = {
  enabled: true,
  trigger: { kind: "percent", percent: 90 },
};

const usage = (overrides?: Partial<ThreadTokenUsageSnapshot>): ThreadTokenUsageSnapshot => ({
  usedTokens: 95_000,
  maxTokens: 100_000,
  ...overrides,
});

const baseInput = {
  usage: usage(),
  options,
  capability: manualCapability,
  runtimeStatus: idleStatus,
  threadState: "ready" as const,
  activeTurnId: undefined,
  now: 1_000_000,
  lastAutoCompactionAt: undefined,
};

describe("decideAutoCompaction", () => {
  it("compacts when the percent trigger is reached on an idle thread", () => {
    expect(decideAutoCompaction(baseInput)).toEqual({
      action: "compact",
      reason: "trigger-reached",
    });
  });

  it("does nothing below the trigger", () => {
    expect(decideAutoCompaction({ ...baseInput, usage: usage({ usedTokens: 50_000 }) })).toEqual({
      action: "none",
      reason: "below-trigger",
    });
  });

  it("does nothing when disabled", () => {
    expect(decideAutoCompaction({ ...baseInput, options: { ...options, enabled: false } })).toEqual(
      { action: "none", reason: "auto-compaction-disabled" },
    );
  });

  it("defers to native provider auto-compaction", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        capability: nativeCapability,
        runtimeStatus: { ...idleStatus, providerAutoEnabled: true },
      }),
    ).toEqual({ action: "none", reason: "provider-native-auto" });
  });

  it("acts when native auto-compaction is disabled provider-side", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        capability: nativeCapability,
        runtimeStatus: { ...idleStatus, providerAutoEnabled: false },
      }),
    ).toEqual({ action: "compact", reason: "trigger-reached" });
  });

  it("does nothing when the provider does not support manual compaction", () => {
    expect(decideAutoCompaction({ ...baseInput, capability: unsupportedCapability })).toEqual({
      action: "none",
      reason: "manual-compaction-unsupported",
    });
  });

  it.each(["pending", "running", "uncertain"] as const)(
    "does nothing while an operation is %s",
    (status) => {
      expect(
        decideAutoCompaction({
          ...baseInput,
          runtimeStatus: { ...idleStatus, phase: { status } },
        }),
      ).toEqual({ action: "none", reason: `operation-${status}` });
    },
  );

  it("does nothing while suspended", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        runtimeStatus: {
          ...idleStatus,
          phase: { status: "suspended", reason: "compaction-thrashing" },
        },
      }),
    ).toEqual({ action: "none", reason: "suspended" });
  });

  it("respects the cooldown window", () => {
    const input = {
      ...baseInput,
      options: { ...options, cooldownMs: 60_000 },
      lastAutoCompactionAt: baseInput.now - 30_000,
    };
    expect(decideAutoCompaction(input)).toEqual({ action: "none", reason: "cooldown" });
    expect(
      decideAutoCompaction({ ...input, lastAutoCompactionAt: baseInput.now - 90_000 }),
    ).toEqual({ action: "compact", reason: "trigger-reached" });
  });

  it("goes pending behind an active turn", () => {
    expect(decideAutoCompaction({ ...baseInput, activeTurnId: "turn-1" })).toEqual({
      action: "pending",
      reason: "active-turn",
    });
  });

  it("does nothing when the thread is not idle", () => {
    expect(decideAutoCompaction({ ...baseInput, threadState: "error" })).toEqual({
      action: "none",
      reason: "thread-not-idle",
    });
  });

  it("cannot evaluate a percent trigger without maxTokens or usedPercent", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        usage: usage({ maxTokens: undefined }),
      }),
    ).toEqual({ action: "none", reason: "usage-unavailable" });
  });

  it("uses a provider-reported usedPercent when maxTokens is missing", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        usage: usage({ maxTokens: undefined, usedPercent: 95 }),
      }),
    ).toEqual({ action: "compact", reason: "trigger-reached" });
  });

  it("prefers the nested context snapshot over flat fields", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        usage: usage({
          usedTokens: 99_000,
          context: {
            usedTokens: 10_000,
            maxTokens: 100_000,
            measurement: "provider-reported",
            confidence: "exact",
          },
        }),
      }),
    ).toEqual({ action: "none", reason: "below-trigger" });
  });

  it("goes pending instead of compacting on low-confidence usage", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        usage: usage({
          context: {
            usedTokens: 95_000,
            maxTokens: 100_000,
            measurement: "synara-estimated",
            confidence: "low",
          },
        }),
      }),
    ).toEqual({ action: "pending", reason: "usage-unavailable" });
  });

  it("goes pending when the provider only reports processed totals", () => {
    expect(
      decideAutoCompaction({
        ...baseInput,
        capability: {
          ...manualCapability,
          telemetry: { lifecycle: "none", contextUsage: "processed-total-only" },
        },
      }),
    ).toEqual({ action: "pending", reason: "usage-unavailable" });
  });

  it("evaluates a remaining-tokens trigger", () => {
    const remaining = {
      ...baseInput,
      options: {
        ...options,
        trigger: { kind: "remaining-tokens", reserveTokens: 10_000 } as const,
      },
    };
    expect(decideAutoCompaction(remaining)).toEqual({
      action: "compact",
      reason: "trigger-reached",
    });
    expect(decideAutoCompaction({ ...remaining, usage: usage({ usedTokens: 50_000 }) })).toEqual({
      action: "none",
      reason: "below-trigger",
    });
    expect(decideAutoCompaction({ ...remaining, usage: usage({ maxTokens: undefined }) })).toEqual({
      action: "none",
      reason: "usage-unavailable",
    });
  });

  it("evaluates an absolute-used-tokens trigger without maxTokens", () => {
    const absolute = {
      ...baseInput,
      usage: usage({ maxTokens: undefined }),
      options: {
        ...options,
        trigger: { kind: "absolute-used-tokens", usedTokens: 90_000 } as const,
      },
    };
    expect(decideAutoCompaction(absolute)).toEqual({
      action: "compact",
      reason: "trigger-reached",
    });
    expect(
      decideAutoCompaction({
        ...absolute,
        usage: usage({ usedTokens: 10_000, maxTokens: undefined }),
      }),
    ).toEqual({ action: "none", reason: "below-trigger" });
  });
});
