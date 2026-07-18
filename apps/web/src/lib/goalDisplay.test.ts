import type { OrchestrationGoal } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  formatGoalCompletionSummary,
  formatGoalDuration,
  formatGoalUsageSummary,
} from "./goalDisplay";

const goal: OrchestrationGoal = {
  id: "goal-1",
  objective: "Ship it",
  status: "active",
  tokenBudget: null,
  tokensUsed: 14_000,
  usage: { inputTokens: 10_000, outputTokens: 4_000, totalTokens: 14_000 },
  turnCount: 3,
  continuationCount: 2,
  timeUsedSeconds: 125,
  blockedReason: null,
  createdAt: "2026-06-02T10:00:00.000Z",
  updatedAt: "2026-06-02T10:00:00.000Z",
};

describe("goal display helpers", () => {
  it("formats durations without losing sub-hour detail", () => {
    expect(formatGoalDuration(0)).toBe("0s");
    expect(formatGoalDuration(125)).toBe("2m 5s");
    expect(formatGoalDuration(3_725)).toBe("1h 2m");
  });

  it("formats the persisted usage summary", () => {
    expect(formatGoalUsageSummary(goal)).toBe("14k tokens · 2m 5s");
  });

  it("only formats terminal goal states as completion summaries", () => {
    expect(formatGoalCompletionSummary(goal)).toBeNull();
    expect(formatGoalCompletionSummary({ ...goal, status: "complete" })).toBe(
      "Goal complete · 14k tokens · 2m 5s",
    );
    expect(formatGoalCompletionSummary({ ...goal, status: "budget_limited" })).toBe(
      "Goal budget reached · 14k tokens · 2m 5s",
    );
  });
});
