import type { ReactElement } from "react";
import type { OrchestrationLoop } from "@t3tools/contracts";

const LOOP_STATUS_LABEL: Record<OrchestrationLoop["status"], string> = {
  active: "active",
  paused: "paused",
  cleared: "cleared",
};

function formatInterval(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * Compact composer chip for the thread's persisted loop. Mirrors GoalIndicator:
 * shows lifecycle status, interval, and iteration count while a loop is live.
 * Hidden when there is no loop or it has been cleared.
 */
export function LoopIndicator({
  loop,
}: {
  loop: OrchestrationLoop | null | undefined;
}): ReactElement | null {
  if (!loop || loop.status === "cleared") {
    return null;
  }

  return (
    <span
      data-testid="loop-indicator"
      data-loop-status={loop.status}
      title={loop.prompt}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground"
    >
      <span aria-hidden>🔄</span>
      <span className="sr-only sm:not-sr-only">Loop: {LOOP_STATUS_LABEL[loop.status]}</span>
      <span className="text-muted-foreground/70">every {formatInterval(loop.intervalSeconds)}</span>
      <span className="text-muted-foreground/70">{loop.iterationsRun} runs</span>
    </span>
  );
}
