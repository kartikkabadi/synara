import { type ReactElement, useCallback } from "react";
import { type OrchestrationGoal, type ThreadId } from "@t3tools/contracts";
import { formatSecondsCompact } from "~/lib/format";
import { readNativeApi } from "~/nativeApi";
import { newCommandId } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const GOAL_STATUS_LABEL: Record<OrchestrationGoal["status"], string> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  budget_limited: "budget limited",
  complete: "complete",
  cleared: "cleared",
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Compact composer chip for the thread's persisted goal (the agent-agnostic port of
 * pi-goal / Codex goals). Mirrors pi-goal's footer status: shows the lifecycle status,
 * turn count, and running spend (tokens + time) while a goal is live. Hidden when there
 * is no goal or it has been cleared. Clicking opens a popover with details and controls
 * (pause / resume / clear).
 */
export function GoalIndicator({
  goal,
  threadId,
}: {
  goal: OrchestrationGoal | null | undefined;
  threadId: ThreadId | null | undefined;
}): ReactElement | null {
  const dispatch = useCallback(
    (type: "thread.goal.pause" | "thread.goal.resume" | "thread.goal.clear") => {
      const api = readNativeApi();
      if (!api || !threadId) return;
      void api.orchestration.dispatchCommand({
        type,
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
    },
    [threadId],
  );

  if (!goal || goal.status === "cleared") {
    return null;
  }

  const budgetHint = goal.tokenBudget !== null ? ` / ${formatTokens(goal.tokenBudget)}` : "";
  const canPause = goal.status === "active";
  const canResume = goal.status === "paused" || goal.status === "blocked";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="goal-indicator"
            data-goal-status={goal.status}
            title={goal.objective}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
          >
            <span aria-hidden>🎯</span>
            <span className="sr-only sm:not-sr-only">Goal: {GOAL_STATUS_LABEL[goal.status]}</span>
            <span className="text-muted-foreground/70">{goal.turnCount} turns</span>
            <span className="text-muted-foreground/70">
              {formatTokens(goal.tokensUsed)}
              {budgetHint} tokens
            </span>
            <span className="text-muted-foreground/70">
              {formatSecondsCompact(goal.timeUsedSeconds)}
            </span>
          </button>
        }
      />
      <PopoverPopup side="bottom" align="end" className="w-72 max-w-none px-3 py-3">
        <div className="space-y-2 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Goal — {GOAL_STATUS_LABEL[goal.status]}
          </div>
          <div className="text-xs text-foreground">{goal.objective}</div>
          {goal.status === "blocked" && goal.blockedReason ? (
            <div className="rounded-md border border-[var(--color-border-warning,transparent)] bg-[var(--color-background-warning-subtle,transparent)] px-2 py-1.5 text-xs text-foreground">
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Blocker
              </div>
              {goal.blockedReason}
            </div>
          ) : null}
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>{goal.turnCount} turns</span>
            <span>
              {formatTokens(goal.tokensUsed)}
              {budgetHint} tokens
            </span>
            <span>{formatSecondsCompact(goal.timeUsedSeconds)}</span>
          </div>
          <div className="flex gap-2 pt-1">
            {canPause ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => dispatch("thread.goal.pause")}
              >
                Pause
              </Button>
            ) : null}
            {canResume ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => dispatch("thread.goal.resume")}
              >
                Resume
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => dispatch("thread.goal.clear")}
            >
              Clear
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
