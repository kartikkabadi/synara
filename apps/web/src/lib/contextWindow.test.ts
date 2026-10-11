import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@synara/contracts";

import {
  deriveContextCompactionMeterCopy,
  deriveContextCompactionStatusLine,
  deriveLatestCompactionRuntimeStatus,
  formatCompactionTriggerLabel,
  deriveContextWindowSelectionStatus,
  deriveComposerContextWindowLabel,
  deriveAppliedContextWindowSelection,
  deriveContextWindowMeterDisplay,
  deriveCumulativeCostUsd,
  deriveObservedClaudeContextBudget,
  contextWindowMeterSectorPath,
  deriveLatestContextWindowState,
  deriveSelectedContextWindowSnapshot,
  formatContextWindowTokens,
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
  it("does not label a runtime threshold as the target when configuration history is missing", () => {
    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: deriveSelectedContextWindowSnapshot("1m"),
        appliedValue: null,
        selectedValue: "auto",
      }),
    ).toEqual({ activeLabel: null, selectedLabel: "Auto", pendingSelectedLabel: null });
  });

  it("uses persisted applied modes so Auto is not permanently pending", () => {
    for (const [payload, appliedValue] of [
      [{ cleared: true }, "auto"],
      [{ maxTokens: 200_000 }, "200k"],
      [{ maxTokens: 1_000_000 }, "1m"],
    ] as const) {
      const applied = deriveAppliedContextWindowSelection([
        makeActivity("configured", "context-window.configured", payload),
      ]);
      expect(applied).toBe(appliedValue);
      expect(
        deriveContextWindowSelectionStatus({
          activeSnapshot: deriveSelectedContextWindowSnapshot("1m"),
          appliedValue: applied,
          selectedValue: appliedValue,
        }).pendingSelectedLabel,
      ).toBeNull();
    }
  });

  it("preserves validated Claude cache evidence from the latest usage snapshot", () => {
    const claudeCache = {
      observedAt: "2026-03-23T00:00:00.000Z",
      state: "unknown",
      source: "request-usage",
      contextTokens: 887_036,
      lastRequest: { messageId: "request-1", cacheCreationInputTokens: 887_036 },
    };
    const derive = (value: OrchestrationThreadActivity["payload"] | undefined) =>
      deriveLatestContextWindowState([
        makeActivity("cache", "context-window.updated", {
          usedTokens: 887_036,
          ...(value === undefined ? {} : { claudeCache: value }),
        }),
      ]).snapshot;
    expect(derive(claudeCache)?.claudeCache).toEqual(claudeCache);
    expect(derive(undefined)?.claudeCache).toBeNull();
    expect(derive({ ...claudeCache, state: "warm" })?.claudeCache).toBeNull();
    expect(derive({ ...claudeCache, contextTokens: -1 })?.claudeCache).toBeNull();
  });

  it("withholds old Claude processed totals while preserving context and other providers", () => {
    for (const provider of ["claudeAgent", "codex"]) {
      const payload = {
        provider,
        usedTokens: 100,
        totalProcessedTokens: 400,
        cumulative: { totalProcessedTokens: 400 },
      };
      const legacy = deriveLatestContextWindowState([
        makeActivity("legacy", "context-window.updated", payload),
      ]).snapshot;
      expect(legacy?.usedTokens).toBe(100);
      expect(legacy?.totalProcessedTokens).toBe(provider === "claudeAgent" ? null : 400);
      expect(legacy?.cumulative).toEqual(
        provider === "claudeAgent" ? null : { totalProcessedTokens: 400 },
      );
      const corrected = deriveLatestContextWindowState([
        makeActivity("corrected", "context-window.updated", {
          ...payload,
          tokenAccountingVersion: 1,
        }),
      ]).snapshot;
      expect(corrected?.totalProcessedTokens).toBe(400);
    }
  });

  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("invalidates earlier usage at a completed compaction until fresh usage arrives", () => {
    const beforeCompaction = [
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "200k",
        maxTokens: 200_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 180_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-compaction", {
        state: "compacted",
      }),
      makeActivity("activity-4", "context-window.updated", {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
      }),
    ];

    expect(deriveLatestContextWindowState(beforeCompaction).snapshot).toBeNull();
    expect(deriveLatestContextWindowState(beforeCompaction).invalidatedByCompaction).toBe(true);

    const afterFreshUsage = deriveLatestContextWindowState([
      ...beforeCompaction,
      makeActivity("activity-5", "context-window.updated", {
        usedTokens: 20_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

    expect(afterFreshUsage?.usedTokens).toBe(20_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {}),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("derives real zero-percent context window snapshots", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(0);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("keeps zero-token usage reliable when runtime reports max tokens", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        maxTokens: 128_000,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.remainingTokens).toBe(128_000);
    expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
      hasReliableTokenRatio: true,
      tokenUsageLabel: "0",
      compactLabel: "0%",
    });
  });

  it("does not infer remaining tokens from percent-only usage", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.remainingTokens).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("invalidates old usage when Auto is applied", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-window.configured", { cleared: true }),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("waits for runtime usage instead of presenting the target as a measurement", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("derives meter display labels without inventing token ratios", () => {
    const percentOnly = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
      }),
    ]).snapshot;

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

  it("marks a selected Claude context window as pending when the live session differs", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

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
      const legacySnapshot = deriveLatestContextWindowState([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 14_000,
          maxTokens: 258_000,
          compactsAutomatically: true,
        }),
      ]).snapshot;
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

    it("keeps persisted settings in the runtime projection", () => {
      const settings = {
        autoEnabled: true,
        trigger: { kind: "percent", percent: 72 },
        cooldownSeconds: 120,
      };
      const status = deriveLatestCompactionRuntimeStatus([
        makeActivity("status", "thread.compaction-runtime-status.updated", {
          ...providerAutoStatus,
          settings,
        }),
      ]);
      expect(status?.settings).toEqual(settings);
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
      const snapshot = deriveLatestContextWindowState([
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
      ]).snapshot;

      expect(snapshot?.usedTokens).toBe(90_000);
      expect(snapshot?.maxTokens).toBe(200_000);
      expect(snapshot?.usedPercentage).toBe(45);
      expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
        hasReliableTokenRatio: true,
        compactLabel: "45%",
      });
    });

    it("marks low-confidence context claims as unreliable", () => {
      const snapshot = deriveLatestContextWindowState([
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
      ]).snapshot;

      expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
        hasReliableTokenRatio: false,
        compactLabel: "90k",
      });
    });

    it("only reads total processed tokens from the cumulative claim when present", () => {
      const snapshot = deriveLatestContextWindowState([
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
      ]).snapshot;

      expect(snapshot?.totalProcessedTokens).toBe(750_000);
      expect(snapshot?.usedTokens).toBe(90_000);
    });

    it("keeps legacy flat payloads working without nested claims", () => {
      const snapshot = deriveLatestContextWindowState([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 14_000,
          maxTokens: 258_000,
          totalProcessedTokens: 748_126,
        }),
      ]).snapshot;

      expect(snapshot?.usedTokens).toBe(14_000);
      expect(snapshot?.maxTokens).toBe(258_000);
      expect(snapshot?.totalProcessedTokens).toBe(748_126);
      expect(snapshot?.context).toBeNull();
    });
  });
});

describe("composer context budget label", () => {
  const model = "claude-fable-5-1";
  it.each([
    ["auto", "auto", 967000, model, "(1M)"],
    ["1m", "1m", 967000, `${model}[1m]`, "(1M)"],
    ["1m", "1m", 167000, model, "(200k)"],
    ["200k", "1m", 167000, model, "(200k · 1M next)"],
    ["1m", "auto", 967000, model, "(1M · Auto next)"],
    [null, "1m", null, null, "(1M next)"],
    [null, "auto", null, null, null],
    ["1m", "1m", 967000, "claude-opus-4-7", "(1M next)"],
    ["1m", "1m", 50000, model, "(1M target)"],
  ])(
    "applied %s, selected %s, budget %s, model %s",
    (applied, selected, maxTokens, observedModel, expected) => {
      const snapshot =
        maxTokens === null
          ? null
          : {
              ...deriveSelectedContextWindowSnapshot("1m")!,
              maxTokens,
              claudeCache: observedModel
                ? {
                    model: observedModel,
                    observedAt: "2026-09-17T00:00:00.000Z",
                    state: "unknown" as const,
                    source: "request-usage" as const,
                  }
                : null,
            };
      const status = deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        appliedValue: applied,
        selectedValue: selected,
      });
      expect(
        deriveComposerContextWindowLabel({ provider: "claudeAgent", model, snapshot, status }),
      ).toBe(expected);
      expect(
        deriveComposerContextWindowLabel({ provider: "codex", model, snapshot, status }),
      ).toBeNull();
    },
  );
});

describe("context window meter glyph", () => {
  it("draws a filled sector from 12 o'clock, clockwise, closed at the centre", () => {
    expect(contextWindowMeterSectorPath(0)).toBeNull();
    // A quarter ends at 3 o'clock.
    expect(contextWindowMeterSectorPath(25)).toBe(
      "M 8 8 L 8 2.75 A 5.25 5.25 0 0 1 13.250 8.000 Z",
    );
    // More than half takes the large arc.
    expect(contextWindowMeterSectorPath(75)).toContain("A 5.25 5.25 0 1 1");
    // A full window is a whole disc, not a degenerate zero-length arc.
    expect(contextWindowMeterSectorPath(100)).toBe(
      "M 8 2.75 A 5.25 5.25 0 1 1 8 13.25 A 5.25 5.25 0 1 1 8 2.75 Z",
    );
  });
});

describe("observed Claude context budget", () => {
  const model = "claude-haiku-5-5";
  const cache = (observedModel: string) => ({
    model: observedModel,
    observedAt: "2026-10-09T21:29:36.000Z",
    state: "unknown" as const,
    source: "request-usage" as const,
  });
  // Recorded from a live Claude Haiku 5.5 turn: provisional catalog budgets, then the
  // end-of-turn correction, then the next turn's provisional budget again.
  const turnActivities = [
    makeActivity("configured", "context-window.configured", { cleared: true }),
    makeActivity("u1", "context-window.updated", {
      usedTokens: 30115,
      maxTokens: 200_000,
      claudeCache: cache(model),
    }),
    makeActivity("u2", "context-window.updated", {
      usedTokens: 30115,
      maxTokens: 1_000_000,
      claudeCache: cache(model),
    }),
    makeActivity("u3", "context-window.updated", {
      usedTokens: 30115,
      maxTokens: 200_000,
      claudeCache: cache(model),
    }),
    // Task usage arrives without a cache observation.
    makeActivity("task", "context-window.updated", { usedTokens: 4000, maxTokens: 200_000 }),
  ];

  it("keeps the largest budget reported for the model, so the label does not flip", () => {
    expect(deriveObservedClaudeContextBudget(turnActivities)).toEqual({
      model,
      maxTokens: 1_000_000,
    });
    const status = deriveContextWindowSelectionStatus({
      activeSnapshot: deriveLatestContextWindowState(turnActivities).snapshot,
      appliedValue: "auto",
      selectedValue: "auto",
    });
    const labels = [];
    for (let count = 2; count <= turnActivities.length; count += 1) {
      const activities = turnActivities.slice(0, count);
      labels.push(
        deriveComposerContextWindowLabel({
          provider: "claudeAgent",
          model,
          snapshot: deriveLatestContextWindowState(activities).snapshot,
          status,
          observedBudget: deriveObservedClaudeContextBudget(activities),
        }),
      );
    }
    expect(labels).toEqual(["(200k)", "(1M)", "(1M)", "(1M)"]);
  });

  it("holds across session restarts and compaction under the same configuration", () => {
    // Recorded: a restarted session reconfigures Auto again, reports cache-only usage,
    // then the provisional 200k before its 1M correction.
    expect(
      deriveObservedClaudeContextBudget([
        ...turnActivities,
        makeActivity("compacted", "context-compaction", { state: "compacted" }),
        makeActivity("restart", "context-window.configured", { cleared: true }),
        makeActivity("cache-only", "context-window.updated", { claudeCache: cache(model) }),
        makeActivity("u4", "context-window.updated", {
          usedTokens: 1000,
          maxTokens: 200_000,
          claudeCache: cache(model),
        }),
      ]),
    ).toEqual({ model, maxTokens: 1_000_000 });
  });

  it("starts over after a completed account handoff even when the context configuration is unchanged", () => {
    const handoff = makeActivity("handoff", "provider.handoff", {});
    expect(deriveObservedClaudeContextBudget([...turnActivities, handoff])).toBeNull();
    expect(
      deriveObservedClaudeContextBudget([
        ...turnActivities,
        makeActivity("failed-handoff", "provider.handoff.failed", {}),
      ]),
    ).toEqual({ model, maxTokens: 1_000_000 });
    expect(
      deriveObservedClaudeContextBudget([
        ...turnActivities,
        handoff,
        makeActivity("new-account", "context-window.configured", { cleared: true }),
        makeActivity("new-usage", "context-window.updated", {
          usedTokens: 1000,
          maxTokens: 200_000,
          claudeCache: cache(model),
        }),
      ]),
    ).toEqual({ model, maxTokens: 200_000 });
  });

  it("starts over when the configured context window changes", () => {
    expect(
      deriveObservedClaudeContextBudget([
        ...turnActivities,
        makeActivity("reconfigured", "context-window.configured", { maxTokens: 200_000 }),
      ]),
    ).toBeNull();
    expect(
      deriveObservedClaudeContextBudget([
        ...turnActivities,
        makeActivity("reconfigured", "context-window.configured", { maxTokens: 200_000 }),
        makeActivity("u5", "context-window.updated", {
          usedTokens: 1000,
          maxTokens: 167_000,
          claudeCache: cache(model),
        }),
      ]),
    ).toEqual({ model, maxTokens: 167_000 });
  });

  it("follows the newest observed model", () => {
    expect(
      deriveObservedClaudeContextBudget([
        ...turnActivities,
        makeActivity("other", "context-window.updated", {
          usedTokens: 1000,
          maxTokens: 200_000,
          claudeCache: cache("claude-sonnet-5"),
        }),
      ]),
    ).toEqual({ model: "claude-sonnet-5", maxTokens: 200_000 });
  });
});
