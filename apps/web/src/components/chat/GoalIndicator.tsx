import type { ReactElement } from "react";
import type { OrchestrationGoal } from "@t3tools/contracts";

const GOAL_STATUS_LABEL: Record<OrchestrationGoal["status"], string> = {
  active: "active",
  paused: "paused",
  budget_limited: "budget limited",
  complete: "complete",
  cleared: "cleared",
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * Compact composer chip for the thread's persisted goal (the agent-agnostic port of
 * pi-goal / Codex goals). Mirrors pi-goal's footer status: shows the lifecycle status,
 * turn count, and running spend (tokens + time) while a goal is live. Hidden when there
 * is no goal or it has been cleared.
 */
export function GoalIndicator({
  goal,
}: {
  goal: OrchestrationGoal | null | undefined;
}): ReactElement | null {
  if (!goal || goal.status === "cleared") {
    return null;
  }

  const budgetHint = goal.tokenBudget !== null ? ` / ${formatTokens(goal.tokenBudget)}` : "";

  return (
    <span
      data-testid="goal-indicator"
      data-goal-status={goal.status}
      title={goal.objective}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground"
    >
      <span aria-hidden>🎯</span>
      <span className="sr-only sm:not-sr-only">Goal: {GOAL_STATUS_LABEL[goal.status]}</span>
      <span className="text-muted-foreground/70">{goal.turnCount} turns</span>
      <span className="text-muted-foreground/70">
        {formatTokens(goal.tokensUsed)}
        {budgetHint} tokens
      </span>
      <span className="text-muted-foreground/70">{formatDuration(goal.timeUsedSeconds)}</span>
    </span>
  );
}
