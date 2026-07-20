"use client";

// FILE: LoopIndicator.tsx
// Purpose: Show `/loop` state (active, waiting, running, or just finished) and a stop control above the composer.
// Layer: Chat composer UI

import type { ThreadId, ThreadLoop } from "@synara/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ClockIcon, RefreshCwIcon, StopIcon, XIcon } from "~/lib/icons";
import { Badge } from "../ui/badge";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import type { Thread } from "../../types";

interface LoopIndicatorProps {
  loop: ThreadLoop;
  thread?: Thread | undefined;
  onStop?: (() => void) | undefined;
  className?: string;
}

const OFF_CHIP_TTL_MS = 60_000;

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

type LoopBadgeVariant = "info" | "warning" | "outline" | "error" | "secondary";

interface LoopIndicatorViewState {
  icon: ReactNode;
  badgeVariant: LoopBadgeVariant;
  badgeLabel: string;
  detail: string | null;
}

function deriveLoopViewState(loop: ThreadLoop, thread: Thread | undefined): LoopIndicatorViewState {
  if (!loop.active) {
    const reason = loop.lastStopReason!;
    const detail =
      loop.iteration > 0
        ? `${formatStopReason(reason)} · ${loop.iteration} ${loop.iteration === 1 ? "iteration" : "iterations"}`
        : formatStopReason(reason);
    return {
      icon: <StopIcon />,
      badgeVariant: reason === "consecutive_errors" ? "error" : "secondary",
      badgeLabel: "Loop off",
      detail,
    };
  }

  const promptMissing = loop.prompt.trim().length === 0;
  const remainingSeconds =
    loop.endsAt !== null
      ? Math.max(0, (new Date(loop.endsAt).getTime() - Date.now()) / 1000)
      : null;

  if (promptMissing) {
    return {
      icon: <RefreshCwIcon />,
      badgeVariant: "outline",
      badgeLabel: "Loop on",
      detail: "next message starts it",
    };
  }
  if (thread?.hasPendingApprovals === true) {
    return {
      icon: <ClockIcon />,
      badgeVariant: "warning",
      badgeLabel: "Loop waiting",
      detail: "approval",
    };
  }
  if (thread?.hasPendingUserInput === true) {
    return {
      icon: <ClockIcon />,
      badgeVariant: "warning",
      badgeLabel: "Loop waiting",
      detail: "user input",
    };
  }
  if (isLoopRunning(loop, thread)) {
    const runningIteration = thread?.latestTurn?.purpose?.iteration;
    return {
      icon: <Spinner className="size-3" />,
      badgeVariant: "info",
      badgeLabel: "Loop running",
      detail: runningIteration != null ? `iteration ${runningIteration}` : null,
    };
  }
  let detail: string;
  if (loop.maxIterations !== null) {
    detail = `${loop.iteration}/${loop.maxIterations} · next message replaces prompt`;
  } else if (remainingSeconds !== null) {
    detail = `ends in ${formatRemainingTime(remainingSeconds)} · next message replaces prompt`;
  } else {
    detail = "next message replaces prompt";
  }
  return {
    icon: <RefreshCwIcon />,
    badgeVariant: "outline",
    badgeLabel: "Loop on",
    detail,
  };
}

export function LoopIndicator({ loop, thread, onStop, className }: LoopIndicatorProps) {
  useLoopTick(loop);
  useLoopOffToast(loop, thread?.id);
  // The banner enters through the shared disclosure motion: it mounts closed and
  // opens on the next frame so the composer surface grows instead of popping.
  const [entered, setEntered] = useState(false);
  // Off-chip dismissal is keyed to the stop event so a later stop re-shows it.
  const [dismissedStopAt, setDismissedStopAt] = useState<string | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const isOffChip = !loop.active;
  const dismissed = isOffChip && dismissedStopAt === loop.updatedAt;
  const visible =
    loop.active ||
    (loop.lastStopReason != null && isLoopRecentlyOff(loop.updatedAt) && !dismissed);

  if (isOffChip && loop.lastStopReason == null) {
    return null;
  }
  if (!visible && !entered) {
    return null;
  }

  const view = deriveLoopViewState(loop, thread);

  return (
    <DisclosureRegion open={visible && entered} className={className}>
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-4 sm:px-6 sm:pt-4.5 sm:pb-5">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant={view.badgeVariant}>
            {view.icon}
            {view.badgeLabel}
          </Badge>
          {view.detail !== null ? (
            <span
              className="truncate text-[11px] text-muted-foreground"
              title={loop.active && loop.prompt.trim().length > 0 ? loop.prompt : undefined}
            >
              {view.detail}
            </span>
          ) : null}
        </div>
        {isOffChip ? (
          <button
            type="button"
            aria-label="Dismiss loop status"
            onClick={() => setDismissedStopAt(loop.updatedAt)}
            className="rounded-full p-1 text-muted-foreground/70 transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)]"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : onStop != null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Stop loop"
                  onClick={onStop}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border-light)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:border-destructive/40 hover:bg-destructive/8 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)] dark:hover:bg-destructive/16"
                >
                  <StopIcon className="size-3" />
                  Stop
                </button>
              }
            />
            <TooltipPopup>Turn the loop off</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </DisclosureRegion>
  );
}
