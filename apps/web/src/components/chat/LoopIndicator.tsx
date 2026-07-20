"use client";

// FILE: LoopIndicator.tsx
// Purpose: Show `/loop` state (active, waiting, running, or just finished) and a stop control above the composer.
// Layer: Chat composer UI

import type { ThreadId, ThreadLoop } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { StopIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import type { Thread } from "../../types";

interface LoopIndicatorProps {
  loop: ThreadLoop;
  thread?: Thread | undefined;
  onStop?: (() => void) | undefined;
  className?: string;
}

const OFF_CHIP_TTL_MS = 10_000;

function formatRemainingTime(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86400)}d`;
}

function formatStopReason(reason: NonNullable<ThreadLoop["lastStopReason"]>): string {
  switch (reason) {
    case "budget_iterations":
    case "budget_duration":
    case "hard_cap":
      return "budget reached";
    case "consecutive_errors":
      return "errors";
    case "user_stop":
    case "toggled_off":
      return "stopped";
    case "replaced_by_manual_policy":
      return "replaced by manual send";
    case "attachments_not_supported":
      return "attachments not supported";
    case "prompt_invalid":
      return "invalid prompt";
    case "thread_archived":
      return "thread archived";
    case "thread_deleted":
      return "thread deleted";
    case "thread_unrunnable":
      return "thread unavailable";
    default:
      return reason satisfies never;
  }
}

function isLoopRecentlyOff(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < OFF_CHIP_TTL_MS;
}

export function isLoopIndicatorVisible(loop: ThreadLoop): boolean {
  // The indicator component itself owns the TTL re-render and will return null
  // once the off-chip grace period expires, so the banner host can key off the
  // durable loop state without its own ticker.
  return loop.active || loop.lastStopReason != null;
}

function isLoopRunning(loop: ThreadLoop, thread: Thread | undefined): boolean {
  const latestTurn = thread?.latestTurn;
  return (
    latestTurn?.state === "running" &&
    latestTurn.turnId != null &&
    latestTurn.purpose?.kind === "loop-iteration" &&
    latestTurn.purpose.activationId === loop.activationId
  );
}

function loopOffToast(reason: NonNullable<ThreadLoop["lastStopReason"]>) {
  switch (reason) {
    case "attachments_not_supported":
      return {
        type: "warning" as const,
        title: "Loop turned off",
        description: "Attachments are not supported while a loop is active.",
      };
    case "budget_iterations":
    case "budget_duration":
    case "hard_cap":
      return {
        type: "info" as const,
        title: "Loop finished",
        description: "The loop stopped because its budget was reached.",
      };
    case "consecutive_errors":
      return {
        type: "error" as const,
        title: "Loop stopped",
        description: "Too many consecutive errors. Fix the issue and re-arm /loop.",
      };
    case "thread_archived":
      return {
        type: "info" as const,
        title: "Loop stopped",
        description: "Thread archived; loop turned off.",
      };
    case "thread_deleted":
      return {
        type: "info" as const,
        title: "Loop stopped",
        description: "Thread deleted; loop turned off.",
      };
    case "thread_unrunnable":
      return {
        type: "warning" as const,
        title: "Loop stopped",
        description: "This thread is not available for loops.",
      };
    case "prompt_invalid":
      return {
        type: "warning" as const,
        title: "Loop stopped",
        description: "Invalid loop prompt.",
      };
    case "replaced_by_manual_policy":
      return {
        type: "info" as const,
        title: "Loop stopped",
        description: "Your manual message replaced the loop, so it turned off.",
      };
    case "user_stop":
    case "toggled_off":
      return {
        type: "info" as const,
        title: "Loop stopped",
        description: "Loop stopped by user.",
      };
    default:
      return reason satisfies never;
  }
}

function useLoopOffToast(loop: ThreadLoop, threadId: ThreadId | undefined) {
  const previousLoopRef = useRef<ThreadLoop | null>(null);

  useEffect(() => {
    const previous = previousLoopRef.current;
    previousLoopRef.current = loop;
    if (previous === null) {
      return;
    }
    if (
      !loop.active &&
      loop.lastStopReason != null &&
      (previous.active ||
        previous.lastStopReason !== loop.lastStopReason ||
        previous.updatedAt !== loop.updatedAt)
    ) {
      const toast = loopOffToast(loop.lastStopReason);
      if (threadId != null) {
        toastManager.add({
          ...toast,
          data: { threadId },
        });
      }
    }
  }, [loop, threadId]);
}

function useLoopTick(loop: ThreadLoop) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!loop.active && (loop.lastStopReason == null || !isLoopRecentlyOff(loop.updatedAt))) {
      return;
    }
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [loop.active, loop.lastStopReason, loop.updatedAt]);
  return tick;
}

export function LoopIndicator({ loop, thread, onStop, className }: LoopIndicatorProps) {
  useLoopTick(loop);
  useLoopOffToast(loop, thread?.id);

  if (!loop.active && (loop.lastStopReason == null || !isLoopRecentlyOff(loop.updatedAt))) {
    return null;
  }
  if (!loop.active) {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-2 rounded-t-lg border-b border-border/50 bg-accent/40 px-3 py-2 text-xs text-accent-foreground",
          className,
        )}
      >
        <span className="font-medium">Loop</span>
        <span className="text-muted-foreground">{`off · ${formatStopReason(loop.lastStopReason!)}`}</span>
      </div>
    );
  }

  const promptMissing = loop.prompt.trim().length === 0;
  const remainingSeconds =
    loop.endsAt !== null
      ? Math.max(0, (new Date(loop.endsAt).getTime() - Date.now()) / 1000)
      : null;

  let statusLabel: string;
  let progressLabel: string | null = null;

  if (promptMissing) {
    statusLabel = "on";
    progressLabel = "waiting for prompt";
  } else if (thread?.hasPendingApprovals === true) {
    statusLabel = "waiting";
    progressLabel = "approval";
  } else if (thread?.hasPendingUserInput === true) {
    statusLabel = "waiting";
    progressLabel = "user input";
  } else if (isLoopRunning(loop, thread)) {
    statusLabel = "running";
    const runningIteration = thread?.latestTurn?.purpose?.iteration;
    progressLabel = runningIteration != null ? `iteration ${runningIteration}` : null;
  } else {
    statusLabel = "on";
    if (loop.maxIterations !== null) {
      progressLabel = `${loop.iteration}/${loop.maxIterations}`;
    } else if (remainingSeconds !== null) {
      progressLabel = `ends in ${formatRemainingTime(remainingSeconds)}`;
    } else {
      progressLabel = null;
    }
  }

  const label = progressLabel ? `Loop ${statusLabel} · ${progressLabel}` : `Loop ${statusLabel}`;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-t-lg border-b border-border/50 bg-accent/40 px-3 py-2 text-xs text-accent-foreground",
        className,
      )}
    >
      <span className="font-medium">Loop</span>
      <span
        className="text-muted-foreground"
        title={loop.prompt.trim().length > 0 ? loop.prompt : undefined}
      >
        {label}
      </span>
      {onStop != null ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Stop loop"
          onClick={onStop}
          className="h-6 w-6"
        >
          <StopIcon className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
