import type { OrchestrationGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { applyGoalTurnAccounting } from "./goalProjection.ts";

const CREATED_AT = "2026-06-02T10:00:00.000Z";

function makeGoal(overrides?: Partial<OrchestrationGoal>): OrchestrationGoal {
  return {
    id: "goal-1",
    objective: "Ship it",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    continuationCount: 0,
        blockedReason: null,
    timeUsedSeconds: 120,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe("applyGoalTurnAccounting", () => {
  it("keeps timeUsedSeconds monotonic when a later event has an earlier elapsed time", () => {
    const goal = makeGoal({ timeUsedSeconds: 120 });
    const next = applyGoalTurnAccounting(goal, {}, "2026-06-02T10:00:30.000Z");

    expect(next.timeUsedSeconds).toBe(120);
    expect(next.turnCount).toBe(goal.turnCount + 1);
  });

  it("advances timeUsedSeconds when elapsed time increases", () => {
    const goal = makeGoal({ timeUsedSeconds: 10 });
    const next = applyGoalTurnAccounting(goal, {}, "2026-06-02T10:05:00.000Z");

    expect(next.timeUsedSeconds).toBe(300);
  });
});
