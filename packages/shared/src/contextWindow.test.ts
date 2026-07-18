import { describe, expect, it } from "vitest";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";

import { deriveLatestContextWindowUsage } from "./contextWindow";

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

describe("deriveLatestContextWindowUsage", () => {
  it("uses the latest valid provider snapshot and derives percentages", () => {
    const usage = deriveLatestContextWindowUsage([
      makeActivity("activity-1", "context-window.updated", { usedTokens: 1_000 }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 50_000,
        maxTokens: 100_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(usage).toMatchObject({
      usedPercentage: 50,
      usage: {
        usedTokens: 50_000,
        maxTokens: 100_000,
        compactsAutomatically: true,
      },
    });
  });

  it("keeps percent-only usage and skips unusable snapshots", () => {
    const usage = deriveLatestContextWindowUsage([
      makeActivity("activity-1", "context-window.updated", {}),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.5,
      }),
    ]);

    expect(usage?.usedPercentage).toBe(5.5);
    expect(usage?.usage.usedTokens).toBe(0);
    expect(usage?.usage.maxTokens).toBeUndefined();
  });

  it("clamps provider percentages to the safe context-window range", () => {
    expect(
      deriveLatestContextWindowUsage([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 1,
          usedPercent: 125,
        }),
      ])?.usedPercentage,
    ).toBe(100);
  });
});
