import { type OrchestrationGoal, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoalIndicator } from "./GoalIndicator";

const TEST_THREAD_ID = ThreadId.makeUnsafe("t1");

function makeGoal(overrides?: Partial<OrchestrationGoal>): OrchestrationGoal {
  return {
    id: "goal-1",
    objective: "Make all tests pass",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 3,
    continuationCount: 2,
    timeUsedSeconds: 0,
    blockedReason: null,
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("GoalIndicator", () => {
  it("renders nothing without a goal", () => {
    expect(renderToStaticMarkup(<GoalIndicator goal={null} threadId={TEST_THREAD_ID} />)).toBe("");
    expect(renderToStaticMarkup(<GoalIndicator goal={undefined} threadId={TEST_THREAD_ID} />)).toBe(
      "",
    );
  });

  it("renders nothing for a cleared goal", () => {
    expect(
      renderToStaticMarkup(
        <GoalIndicator goal={makeGoal({ status: "cleared" })} threadId={TEST_THREAD_ID} />,
      ),
    ).toBe("");
  });

  it("shows status, objective, and turn count for an active goal", () => {
    const html = renderToStaticMarkup(
      <GoalIndicator goal={makeGoal()} threadId={TEST_THREAD_ID} />,
    );
    expect(html).toContain("Goal: active");
    expect(html).toContain("3 turns");
    expect(html).toContain('title="Make all tests pass"');
    expect(html).toContain('data-goal-status="active"');
  });

  it("labels budget-limited goals", () => {
    const html = renderToStaticMarkup(
      <GoalIndicator goal={makeGoal({ status: "budget_limited" })} threadId={TEST_THREAD_ID} />,
    );
    expect(html).toContain("budget limited");
    expect(html).toContain('data-goal-status="budget_limited"');
  });

  it("renders paused and completed statuses", () => {
    const paused = renderToStaticMarkup(
      <GoalIndicator goal={makeGoal({ status: "paused" })} threadId={TEST_THREAD_ID} />,
    );
    expect(paused).toContain("Goal: paused");
    expect(paused).toContain('data-goal-status="paused"');

    const completed = renderToStaticMarkup(
      <GoalIndicator goal={makeGoal({ status: "complete" })} threadId={TEST_THREAD_ID} />,
    );
    expect(completed).toContain("Goal: complete");
    expect(completed).toContain('data-goal-status="complete"');
  });
});
