import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@synara/contracts";

import {
  deriveContextCompactionMeterCopy,
  deriveContextCompactionStatusLine,
  deriveLatestCompactionRuntimeStatus,
  formatCompactionTriggerLabel,
  deriveContextWindowSelectionStatus,
  deriveContextWindowMeterDisplay,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowSnapshot,
  deriveSelectedContextWindowSnapshot,
  formatContextWindowSelectionLabel,
  formatContextWindowTokens,
  inferContextWindowSelectionValue,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("derives percent-only context window snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(5.8);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("derives real zero-percent context window snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(0);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("keeps zero-token usage reliable when runtime reports max tokens", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        maxTokens: 128_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.remainingTokens).toBe(128_000);
    expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
      hasReliableTokenRatio: true,
      tokenUsageLabel: "0",
      compactLabel: "0%",
    });
  });

  it("does not infer remaining tokens from percent-only usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBe(1_000_000);
    expect(snapshot?.remainingTokens).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("uses the configured session max tokens when usage snapshots lag behind", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(23_000);
    expect(snapshot?.maxTokens).toBe(1_000_000);
  });

  it("returns a session snapshot from configured max tokens before usage arrives", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.maxTokens).toBe(1_000_000);
  });

  it("creates an initial selected context window snapshot before runtime usage arrives", () => {
    const snapshot = deriveSelectedContextWindowSnapshot("1m");

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.maxTokens).toBe(1_000_000);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("derives meter display labels without inventing token ratios", () => {
    const percentOnly = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
      }),
    ]);

    expect(percentOnly).not.toBeNull();
    expect(deriveContextWindowMeterDisplay(percentOnly!)).toMatchObject({
      usedPercentageLabel: "5.8%",
      tokenUsageLabel: "0",
      hasReliableTokenRatio: false,
      normalizedPercentage: 5.8,
      compactLabel: "6%",
      ariaLabel: "Context window 5.8% used",
    });
  });

  it("formats context window selection labels for Claude options", () => {
    expect(formatContextWindowSelectionLabel("1m")).toBe("1M");
    expect(formatContextWindowSelectionLabel("200k")).toBe("200k");
  });

  it("uses Cursor cumulative cost without summing it as a turn delta", () => {
    expect(
      deriveCumulativeCostUsd([
        makeActivity("turn-1", "turn.completed", {
          cumulativeCostUsd: 0.2,
        }),
        makeActivity("turn-2", "turn.completed", {
          cumulativeCostUsd: 0.25,
        }),
      ]),
    ).toBe(0.25);
  });

  it("infers the active Claude context window from max tokens", () => {
    expect(inferContextWindowSelectionValue(200_000)).toBe("200k");
    expect(inferContextWindowSelectionValue(1_000_000)).toBe("1m");
    expect(inferContextWindowSelectionValue(333_000)).toBeNull();
  });

  it("marks a selected Claude context window as pending when the live session differs", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]);

    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        selectedValue: "1m",
      }),
    ).toEqual({
      activeLabel: "200k",
      selectedLabel: "1M",
      pendingSelectedLabel: "1M",
    });
  });

  describe("deriveContextCompactionMeterCopy", () => {
    const baseCompaction = {
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
    } as const;

    it("claims provider-managed auto compaction from the descriptor, not the snapshot", () => {
      expect(
        deriveContextCompactionMeterCopy({
          compaction: {
            ...baseCompaction,
            automatic: { mode: "native", statusVisibility: "none", triggerVisibility: "opaque" },
          },
        }),
      ).toBe("provider-auto");
    });

    it("reports compaction as unavailable when neither manual nor automatic exists", () => {
      expect(
        deriveContextCompactionMeterCopy({
          compaction: baseCompaction,
        }),
      ).toBe("unavailable");
    });

    it("stays silent when manual compaction exists without observable native auto", () => {
      expect(
        deriveContextCompactionMeterCopy({
          compaction: {
            ...baseCompaction,
            manual: {
              mode: "same-session",
              mechanism: "control-command",
              supportsInstructions: true,
            },
            automatic: { mode: "none", statusVisibility: "none", triggerVisibility: "opaque" },
          },
        }),
      ).toBeNull();
    });

    it("ignores the legacy snapshot boolean when no descriptor is available", () => {
      expect(deriveContextCompactionMeterCopy({ compaction: null })).toBeNull();
      const legacySnapshot = deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 14_000,
          maxTokens: 258_000,
          compactsAutomatically: true,
        }),
      ]);
      expect(legacySnapshot?.compactsAutomatically).toBe(true);
      expect(deriveContextCompactionMeterCopy({ compaction: null })).toBeNull();
    });
  });

  describe("compaction runtime status", () => {
    const providerAutoStatus = {
      owner: "provider",
      providerAutoEnabled: true,
      manualAvailability: { available: true },
      trigger: { kind: "percent", percent: 85 },
    } as const;

    it("derives the latest runtime status from the activity log", () => {
      const status = deriveLatestCompactionRuntimeStatus([
        makeActivity("activity-1", "thread.compaction-runtime-status.updated", {
          owner: "none",
          providerAutoEnabled: false,
          manualAvailability: { available: false, reason: "Unsupported" },
        }),
        makeActivity("activity-2", "tool.started", {}),
        makeActivity("activity-3", "thread.compaction-runtime-status.updated", {
          ...providerAutoStatus,
        }),
      ]);
      expect(status).toMatchObject({
        owner: "provider",
        trigger: { kind: "percent", percent: 85 },
      });
    });

    it("ignores malformed runtime status payloads", () => {
      expect(
        deriveLatestCompactionRuntimeStatus([
          makeActivity("activity-1", "thread.compaction-runtime-status.updated", {
            owner: "someone",
          }),
        ]),
      ).toBeNull();
    });

    it("formats each trigger kind", () => {
      expect(formatCompactionTriggerLabel({ kind: "percent", percent: 85 })).toBe(
        "Auto-compacts at 85%",
      );
      expect(
        formatCompactionTriggerLabel({ kind: "remaining-tokens", reserveTokens: 16_384 }),
      ).toBe("Keeps 16k tokens free");
      expect(
        formatCompactionTriggerLabel({ kind: "absolute-used-tokens", usedTokens: 200_000 }),
      ).toBe("Auto-compacts at 200k tokens");
      expect(formatCompactionTriggerLabel({ kind: "opaque" })).toBeNull();
      expect(formatCompactionTriggerLabel(null)).toBeNull();
    });

    it("prefers the runtime status trigger and owner over capabilities", () => {
      expect(
        deriveContextCompactionStatusLine({
          compaction: null,
          runtimeStatus: providerAutoStatus,
        }),
      ).toEqual({ kind: "provider-auto", triggerLabel: "Auto-compacts at 85%" });
    });

    it("reports manual-only and unavailable from the runtime status", () => {
      expect(
        deriveContextCompactionStatusLine({
          compaction: null,
          runtimeStatus: {
            owner: "none",
            providerAutoEnabled: false,
            manualAvailability: { available: true },
          },
        }),
      ).toEqual({ kind: "manual" });
      expect(
        deriveContextCompactionStatusLine({
          compaction: null,
          runtimeStatus: {
            owner: "none",
            providerAutoEnabled: false,
            manualAvailability: { available: false },
          },
        }),
      ).toEqual({ kind: "unavailable" });
    });

    it("falls back to capability-derived copy without a runtime status", () => {
      const manualOnlyCompaction = {
        manual: {
          mode: "same-session",
          mechanism: "control-command",
          supportsInstructions: true,
        },
        automatic: { mode: "none", statusVisibility: "none", triggerVisibility: "opaque" },
        telemetry: { lifecycle: "none", contextUsage: "none" },
      } as const;
      expect(deriveContextCompactionStatusLine({ compaction: manualOnlyCompaction })).toEqual({
        kind: "manual",
      });
      expect(deriveContextCompactionStatusLine({ compaction: null })).toBeNull();
    });
  });

  describe("nested V2 usage semantics", () => {
    it("prefers the nested context claim over flat fields", () => {
      const snapshot = deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 500_000,
          maxTokens: 1_000_000,
          context: {
            usedTokens: 90_000,
            maxTokens: 200_000,
            usedPercent: 45,
            measurement: "provider-reported",
            confidence: "exact",
          },
        }),
      ]);

      expect(snapshot?.usedTokens).toBe(90_000);
      expect(snapshot?.maxTokens).toBe(200_000);
      expect(snapshot?.usedPercentage).toBe(45);
      expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
        hasReliableTokenRatio: true,
        compactLabel: "45%",
      });
    });

    it("marks low-confidence context claims as unreliable", () => {
      const snapshot = deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 90_000,
          maxTokens: 200_000,
          context: {
            usedTokens: 90_000,
            maxTokens: 200_000,
            usedPercent: 45,
            measurement: "synara-estimated",
            confidence: "low",
          },
        }),
      ]);

      expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
        hasReliableTokenRatio: false,
        compactLabel: "90k",
      });
    });

    it("only reads total processed tokens from the cumulative claim when present", () => {
      const snapshot = deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 90_000,
          maxTokens: 200_000,
          totalProcessedTokens: 900_000,
          context: {
            usedTokens: 90_000,
            maxTokens: 200_000,
            measurement: "provider-reported",
            confidence: "exact",
          },
          cumulative: { totalProcessedTokens: 750_000 },
        }),
      ]);

      expect(snapshot?.totalProcessedTokens).toBe(750_000);
      expect(snapshot?.usedTokens).toBe(90_000);
    });

    it("keeps legacy flat payloads working without nested claims", () => {
      const snapshot = deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 14_000,
          maxTokens: 258_000,
          totalProcessedTokens: 748_126,
        }),
      ]);

      expect(snapshot?.usedTokens).toBe(14_000);
      expect(snapshot?.maxTokens).toBe(258_000);
      expect(snapshot?.totalProcessedTokens).toBe(748_126);
      expect(snapshot?.context).toBeNull();
    });
  });
});
