import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { type OrchestrationLoop, type ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "~/nativeApi";
import { newCommandId } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

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
 * Hidden when there is no loop or it has been cleared. Clicking opens a popover
 * with details and controls (pause / resume / clear).
 *
 * When active and not currently working, shows a live countdown to the next
 * iteration. When active and working (a turn is in progress), pulses to indicate
 * the loop is running an iteration.
 */
export function LoopIndicator({
  loop,
  threadId,
  isWorking,
  lastIterationCompletedAt,
}: {
  loop: OrchestrationLoop | null | undefined;
  threadId: ThreadId | null | undefined;
  isWorking: boolean;
  lastIterationCompletedAt: string | null | undefined;
}): ReactElement | null {
  const dispatch = useCallback(
    (type: "thread.loop.pause" | "thread.loop.resume" | "thread.loop.clear") => {
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

  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!loop || loop.status !== "active" || isWorking || !lastIterationCompletedAt) {
      setSecondsRemaining(null);
      return;
    }
    const update = () => {
      const elapsed = Math.floor(
        (Date.now() - new Date(lastIterationCompletedAt).getTime()) / 1000,
      );
      setSecondsRemaining(Math.max(0, loop.intervalSeconds - elapsed));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [loop, isWorking, lastIterationCompletedAt]);

  // Warn the user once when a loop crosses 50 iterations so unintended loops
  // do not silently burn budget. The ref prevents duplicate toasts on re-render.
  const warnedAt50 = useRef(false);
  useEffect(() => {
    if (loop && loop.iterationsRun >= 50 && !warnedAt50.current) {
      warnedAt50.current = true;
      toastManager.add({
        type: "warning",
        title: "Loop has run 50 times",
        description: "Clear with /loop clear if this is unintended.",
      });
    }
  }, [loop]);

  if (!loop || loop.status === "cleared") {
    return null;
  }

  const canPause = loop.status === "active";
  const canResume = loop.status === "paused";
  const isRunning = loop.status === "active" && isWorking;
  const showCountdown = loop.status === "active" && !isWorking && secondsRemaining !== null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="loop-indicator"
            data-loop-status={loop.status}
            data-loop-running={isRunning ? "true" : "false"}
            title={loop.prompt}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] ${isRunning ? "animate-pulse" : ""}`}
          >
            <span aria-hidden>🔄</span>
            <span className="sr-only sm:not-sr-only">Loop: {LOOP_STATUS_LABEL[loop.status]}</span>
            <span className="text-muted-foreground/70">
              every {formatInterval(loop.intervalSeconds)}
            </span>
            <span className="text-muted-foreground/70">{loop.iterationsRun} runs</span>
            {showCountdown ? (
              <span className="text-muted-foreground/70">next in {secondsRemaining}s</span>
            ) : null}
            {isRunning ? <span className="text-muted-foreground/70">running…</span> : null}
          </button>
        }
      />
      <PopoverPopup side="bottom" align="end" className="w-72 max-w-none px-3 py-3">
        <div className="space-y-2 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Loop — {LOOP_STATUS_LABEL[loop.status]}
          </div>
          <div className="text-xs text-foreground">{loop.prompt}</div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>every {formatInterval(loop.intervalSeconds)}</span>
            <span>{loop.iterationsRun} runs</span>
            {showCountdown ? <span>next in {secondsRemaining}s</span> : null}
            {isRunning ? <span>running…</span> : null}
          </div>
          <div className="flex gap-2 pt-1">
            {canPause ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => dispatch("thread.loop.pause")}
              >
                Pause
              </Button>
            ) : null}
            {canResume ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => dispatch("thread.loop.resume")}
              >
                Resume
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => dispatch("thread.loop.clear")}
            >
              Clear
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
