"use client";

// FILE: LoopRuntimeRail.tsx
// Purpose: Compact runtime strip at the top of the composer showing `/loop` state,
// progress, and stop controls. All state selection lives in `loopPresentation.ts`.
// Layer: Chat composer UI

import type {
  OrchestrationLatestTurn,
  ProviderInteractionMode,
  ThreadLoop,
} from "@synara/contracts";
import { useEffect, useState } from "react";

import { ChevronDownIcon, LoopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ThreadSession } from "../../types";
import { Menu, MenuItem, MenuPopupBase, MenuSeparator, MenuTrigger } from "../ui/menu";
import { LoopProgressSegments } from "./LoopProgressSegments";
import {
  deriveLoopPresentationState,
  isLoopOwnedTurnRunning,
  type LoopSemanticColor,
} from "./loopPresentation";

export interface LoopRuntimeRailProps {
  loop: ThreadLoop;
  latestTurn: OrchestrationLatestTurn | null | undefined;
  session: ThreadSession | null;
  interactionMode: ProviderInteractionMode;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  // Dispatches `thread.loop.off`; the current turn finishes on its own.
  onStopAfterTurn: () => void;
  // Interrupts the running loop-owned turn, or turns the loop off when idle.
  onStopNow: () => void;
  onEditLoop: () => void;
  className?: string;
}

export function isLoopRuntimeRailVisible(
  loop: ThreadLoop | null | undefined,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): boolean {
  if (loop == null) return false;
  // The rail lives on while a loop-owned turn outlasts the toggle (ending /
  // stopping); the finished state is the transcript record's job.
  return loop.active || isLoopOwnedTurnRunning(loop, latestTurn);
}

function labelClassName(color: LoopSemanticColor): string {
  switch (color) {
    case "waiting":
      return "text-warning";
    case "error":
      return "text-destructive";
    case "running":
    case "neutral":
      return "text-foreground";
    default:
      return color satisfies never;
  }
}

function iconClassName(color: LoopSemanticColor, spinning: boolean): string {
  return cn(
    "size-3.5 shrink-0",
    labelClassName(color),
    spinning && "animate-[spin_3s_linear_infinite] motion-reduce:animate-none",
  );
}

const RAIL_BUTTON_CLASS_NAME =
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--color-border-light)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:border-destructive/40 hover:bg-destructive/8 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)] dark:hover:bg-destructive/16";

function LoopStopMenu({
  onStopAfterTurn,
  onStopNow,
  onEditLoop,
}: Pick<LoopRuntimeRailProps, "onStopAfterTurn" | "onStopNow" | "onEditLoop">) {
  return (
    <Menu>
      <MenuTrigger className={RAIL_BUTTON_CLASS_NAME}>
        Stop after turn
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopupBase align="end">
        <MenuItem onClick={onStopAfterTurn}>Stop after this turn</MenuItem>
        <MenuItem onClick={onStopNow} variant="destructive">
          Stop now
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onEditLoop}>Edit loop…</MenuItem>
      </MenuPopupBase>
    </Menu>
  );
}

export function LoopRuntimeRail({
  loop,
  latestTurn,
  session,
  interactionMode,
  hasPendingApprovals,
  hasPendingUserInput,
  onStopAfterTurn,
  onStopNow,
  onEditLoop,
  className,
}: LoopRuntimeRailProps) {
  const [now, setNow] = useState(() => Date.now());

  const presentation = deriveLoopPresentationState({
    loop,
    latestTurn,
    session,
    interactionMode,
    hasPendingApprovals,
    hasPendingUserInput,
    now,
  });

  // Presentation-only adaptive ticker: only duration budgets tick, and only at
  // the cadence the presentation model asks for.
  const tickIntervalMs = presentation?.progress?.tickIntervalMs ?? null;
  useEffect(() => {
    if (tickIntervalMs == null) return;
    const id = setInterval(() => setNow(Date.now()), tickIntervalMs);
    return () => clearInterval(id);
  }, [tickIntervalMs]);

  if (presentation === null || presentation.state.kind === "ended") {
    return null;
  }

  const { state, label, detail, color, progress } = presentation;
  const loopTurnRunning = isLoopOwnedTurnRunning(loop, latestTurn);
  const spinning = state.kind === "running" || state.kind === "starting";
  const showCounter =
    progress !== null &&
    (state.kind === "running" ||
      state.kind === "ready" ||
      state.kind === "waiting-approval" ||
      state.kind === "waiting-input");
  // For running, the counter already carries the detail text.
  const detailText = state.kind === "running" ? null : detail;
  const showSegments = showCounter && progress.segments.length > 0;

  let control: React.ReactNode = null;
  if (state.kind !== "ending" && state.kind !== "stopping") {
    control = loopTurnRunning ? (
      <LoopStopMenu
        onStopAfterTurn={onStopAfterTurn}
        onStopNow={onStopNow}
        onEditLoop={onEditLoop}
      />
    ) : (
      <button className={RAIL_BUTTON_CLASS_NAME} onClick={onStopAfterTurn} type="button">
        Stop loop
      </button>
    );
  }

  return (
    <div
      className={cn("flex min-h-10 items-center gap-2.5 px-4 py-1.5 sm:px-5", className)}
      role="status"
    >
      <LoopIcon aria-hidden className={iconClassName(color, spinning)} />
      <span className={cn("shrink-0 text-xs font-medium", labelClassName(color))}>{label}</span>
      {showCounter ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {progress.counterText}
        </span>
      ) : null}
      {detailText !== null ? (
        <span className="truncate text-[11px] text-muted-foreground">{detailText}</span>
      ) : null}
      {showSegments ? (
        <div
          aria-valuemax={progress.ariaValueMax ?? undefined}
          aria-valuemin={progress.ariaValueMin}
          aria-valuenow={progress.ariaValueNow ?? undefined}
          aria-valuetext={progress.ariaValueText}
          className="flex min-w-0 flex-1 justify-start"
          role="progressbar"
          {...(progress.tooltipText !== null ? { title: progress.tooltipText } : {})}
        >
          <LoopProgressSegments color={color} segments={progress.segments} />
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {control}
    </div>
  );
}
