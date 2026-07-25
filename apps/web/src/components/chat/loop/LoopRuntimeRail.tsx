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
import { useEffect, useMemo, useRef, useState } from "react";

import { ChevronDownIcon, LoopIcon, PencilIcon, SteerIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuPopupBase, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  deriveLoopPresentationState,
  isLoopOwnedTurnRunning,
  type LoopSemanticColor,
} from "./presentation";

export interface LoopRuntimeRailProps {
  loop: ThreadLoop;
  latestTurn: OrchestrationLatestTurn | null | undefined;
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

export const LOOP_STEERING_TOOLTIP_TEXT =
  "Messages sent while Loop is active become the objective for the next iteration.";

export const LOOP_STOP_AFTER_TURN_DESCRIPTION = "Let the current work finish, then stop.";
export const LOOP_STOP_NOW_DESCRIPTION = "Interrupt current work and stop the loop.";

// Crossfade duration for label/detail swaps.
const LABEL_CROSSFADE_MS = 150;
// How long the transient "Objective updated" detail stays before the
// regular detail crossfades back in.
const OBJECTIVE_UPDATED_HOLD_MS = 4_000;
export const LOOP_OBJECTIVE_UPDATED_DETAIL = "Objective updated";
// Hold before surfacing transitional copy (`Loop on / Starting the next
// turn…`) so quick turn-to-turn gaps don't flash it.
const TRANSITIONAL_STABILIZE_MS = 250;

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
    spinning && "animate-[pulse_2s_ease-in-out_infinite] motion-reduce:animate-none",
  );
}

const RAIL_BUTTON_CLASS_NAME =
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--color-border-light)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:border-destructive/40 hover:bg-destructive/8 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)] dark:hover:bg-destructive/16";

// Split variant of the rail pill: primary segment keeps the left rounding,
// chevron segment the right, sharing the pill border so the pair reads as one
// control.
const RAIL_SPLIT_PRIMARY_CLASS_NAME =
  "inline-flex shrink-0 items-center gap-1 rounded-l-full border border-r-0 border-[color:var(--color-border-light)] py-1 pr-1.5 pl-2.5 text-[11px] font-medium text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)]";
const RAIL_SPLIT_MENU_CLASS_NAME =
  "inline-flex shrink-0 items-center rounded-r-full border border-l border-[color:var(--color-border-light)] border-l-border/50 py-1 pr-2 pl-1.5 text-[11px] font-medium text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)]";

const MENU_ITEM_DESCRIPTION_CLASS_NAME = "text-[10.5px] text-muted-foreground/60";

function filledSegmentClassName(color: LoopSemanticColor): string {
  switch (color) {
    case "waiting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    case "running":
    case "neutral":
      return "bg-foreground/80";
    default:
      return color satisfies never;
  }
}

// Decorative segmented strip (`aria-hidden`); the host owns the ARIA progress
// attributes. While the loop is running, the most recent filled segment pulses.
function LoopProgressSegments({
  segments,
  color,
  pulsing,
}: {
  // Per-segment fill in [0, 1]; > 0 renders as filled.
  segments: number[];
  color: LoopSemanticColor;
  pulsing: boolean;
}) {
  if (segments.length === 0) {
    return null;
  }
  const pulseIndex = pulsing ? segments.findLastIndex((fill) => fill > 0) : -1;
  return (
    <div aria-hidden className="flex w-full max-w-36 items-center gap-1">
      {segments.map((fill, index) => (
        <span
          // Position is the identity of a segment; the list never reorders.
          // oxlint-disable-next-line no-array-index-key
          key={index}
          className={cn(
            "relative h-1 flex-1 overflow-hidden rounded-full bg-muted/60",
            index === pulseIndex &&
              "animate-[pulse_2s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
        >
          {/* Inner fill: partial widths make fractional progress visible. */}
          <span
            data-testid="loop-progress-segment-fill"
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-200 motion-reduce:transition-none",
              filledSegmentClassName(color),
            )}
            style={{ width: `${fill * 100}%` }}
          />
        </span>
      ))}
    </div>
  );
}

// Split stop control: the primary segment performs the safe default in one
// click (`thread.loop.off` — the running turn finishes on its own), while the
// chevron segment opens the menu with the destructive "Stop now" and "Edit
// loop…".
function LoopStopSplitButton({
  onStopAfterTurn,
  onStopNow,
  onEditLoop,
  loopTurnRunning,
}: Pick<LoopRuntimeRailProps, "onStopAfterTurn" | "onStopNow" | "onEditLoop"> & {
  loopTurnRunning: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <button
        className={RAIL_SPLIT_PRIMARY_CLASS_NAME}
        onClick={onStopAfterTurn}
        title={loopTurnRunning ? LOOP_STOP_AFTER_TURN_DESCRIPTION : undefined}
        type="button"
      >
        {loopTurnRunning ? "Stop after turn" : "Stop loop"}
      </button>
      <Menu>
        <MenuTrigger aria-label="More loop actions" className={RAIL_SPLIT_MENU_CLASS_NAME}>
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopupBase align="end">
          <MenuItem onClick={onStopNow} variant="destructive">
            <span className="flex items-start gap-2">
              <StopIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex flex-col items-start">
                <span>Stop now</span>
                <span className={MENU_ITEM_DESCRIPTION_CLASS_NAME}>
                  {LOOP_STOP_NOW_DESCRIPTION}
                </span>
              </span>
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={onEditLoop}>
            <span className="flex items-center gap-2">
              <PencilIcon aria-hidden className="size-3.5 shrink-0" />
              <span>Edit loop…</span>
            </span>
          </MenuItem>
        </MenuPopupBase>
      </Menu>
    </span>
  );
}

// Transient confirmation after a manual retarget: when `loop.prompt` changes
// while the loop stays active, surface `Objective updated` for a few
// seconds; the existing crossfade machinery animates it in and out. Resets
// across loops (activationId) and clears on unmount.
function useObjectiveUpdatedCue(loop: ThreadLoop): boolean {
  const [showing, setShowing] = useState(false);
  const previousRef = useRef<{ activationId: string; prompt: string; active: boolean } | null>(
    null,
  );

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = {
      activationId: loop.activationId,
      prompt: loop.prompt,
      active: loop.active,
    };
    if (
      previous === null ||
      previous.activationId !== loop.activationId ||
      !previous.active ||
      !loop.active ||
      previous.prompt === loop.prompt
    ) {
      if (previous !== null && previous.activationId !== loop.activationId) {
        setShowing(false);
      }
      return;
    }
    setShowing(true);
    const id = setTimeout(() => setShowing(false), OBJECTIVE_UPDATED_HOLD_MS);
    return () => clearTimeout(id);
  }, [loop.activationId, loop.prompt, loop.active]);

  return showing && loop.active;
}

// Crossfades label/detail swaps over 150 ms and holds transitional copy for a
// short stabilization window so back-to-back turns don't flash it.
function useCrossfadedStatusCopy(
  label: string,
  detail: string | null,
  transitional: boolean,
): { displayLabel: string; displayDetail: string | null; fading: boolean } {
  const [display, setDisplay] = useState({ label, detail });
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (label === display.label && detail === display.detail) {
      // Copy reverted to what is already displayed (e.g. a quick ready ->
      // running bounce); cancel any in-flight fade so the rail is not stuck
      // transparent.
      setFading(false);
      return;
    }
    let fadeId: ReturnType<typeof setTimeout> | undefined;
    const startCrossfade = () => {
      setFading(true);
      fadeId = setTimeout(() => {
        setDisplay({ label, detail });
        setFading(false);
      }, LABEL_CROSSFADE_MS);
    };
    const holdId = transitional ? setTimeout(startCrossfade, TRANSITIONAL_STABILIZE_MS) : undefined;
    if (!transitional) startCrossfade();
    return () => {
      if (holdId !== undefined) clearTimeout(holdId);
      if (fadeId !== undefined) clearTimeout(fadeId);
    };
  }, [label, detail, transitional, display.label, display.detail]);

  return { displayLabel: display.label, displayDetail: display.detail, fading };
}

export function LoopRuntimeRail({
  loop,
  latestTurn,
  interactionMode,
  hasPendingApprovals,
  hasPendingUserInput,
  onStopAfterTurn,
  onStopNow,
  onEditLoop,
  className,
}: LoopRuntimeRailProps) {
  const [now, setNow] = useState(() => Date.now());

  const presentation = useMemo(
    () =>
      deriveLoopPresentationState({
        loop,
        latestTurn,
        interactionMode,
        hasPendingApprovals,
        hasPendingUserInput,
        now,
      }),
    [loop, latestTurn, interactionMode, hasPendingApprovals, hasPendingUserInput, now],
  );

  // Presentation-only adaptive ticker: only duration budgets tick, and only at
  // the cadence the presentation model asks for.
  const tickIntervalMs = presentation?.progress?.tickIntervalMs ?? null;
  useEffect(() => {
    if (tickIntervalMs == null) return;
    const id = setInterval(() => setNow(Date.now()), tickIntervalMs);
    return () => clearInterval(id);
  }, [tickIntervalMs]);

  const stateKind = presentation?.state.kind ?? null;
  const label = presentation?.label ?? "";
  const loopTurnRunning = isLoopOwnedTurnRunning(loop, latestTurn);
  // Only `stopping` is control-free: the stop is already dispatched. `ending`
  // keeps "Stop now" so the user can still interrupt the final turn.
  const controlKind: "menu" | "stop-now" | "none" =
    stateKind === null || stateKind === "stopping"
      ? "none"
      : stateKind === "ending"
        ? "stop-now"
        : "menu";
  // The steering claim is only true while the loop is live between/within
  // iterations; waiting/ending states route input elsewhere.
  const showSteeringTooltip = stateKind === "running" || stateKind === "ready";

  // The stop control mounts/unmounts as the loop settles; keep keyboard focus
  // on the control across the swap instead of dropping to body.
  const controlWrapperRef = useRef<HTMLSpanElement | null>(null);
  const controlHadFocusRef = useRef(false);
  const previousControlKindRef = useRef(controlKind);
  useEffect(() => {
    if (previousControlKindRef.current !== controlKind) {
      if (controlHadFocusRef.current && controlKind !== "none") {
        controlWrapperRef.current?.querySelector("button")?.focus();
      }
      previousControlKindRef.current = controlKind;
    }
  });

  // The rail's secondary detail: running carries it in the counter; no-budget
  // loops surface the safety-limit line instead.
  const showObjectiveUpdated = useObjectiveUpdatedCue(loop);
  const rawDetail =
    presentation === null
      ? null
      : showObjectiveUpdated
        ? LOOP_OBJECTIVE_UPDATED_DETAIL
        : (presentation.progress?.detailText ??
          (presentation.state.kind === "running" ? null : presentation.detail));
  const { displayLabel, displayDetail, fading } = useCrossfadedStatusCopy(
    label,
    rawDetail,
    stateKind === "ready",
  );

  // `ended` is unreachable here: isLoopRuntimeRailVisible hides the rail once
  // the loop is off with no owned turn running.
  if (presentation === null) {
    return null;
  }

  const { state, color, progress } = presentation;
  const spinning = state.kind === "running";
  // The active turn's counter and progress remain visible while it settles
  // (ending / stopping) in addition to the live states.
  const showCounter =
    progress !== null &&
    (state.kind === "running" ||
      state.kind === "ready" ||
      state.kind === "waiting-approval" ||
      state.kind === "waiting-input" ||
      state.kind === "ending" ||
      state.kind === "stopping");
  const showSegments = showCounter && progress.segments.length > 0;
  const showProgressbar = showCounter;

  let control: React.ReactNode = null;
  if (controlKind === "menu") {
    control = (
      <LoopStopSplitButton
        loopTurnRunning={loopTurnRunning}
        onEditLoop={onEditLoop}
        onStopAfterTurn={onStopAfterTurn}
        onStopNow={onStopNow}
      />
    );
  } else if (controlKind === "stop-now") {
    control = (
      <button className={RAIL_BUTTON_CLASS_NAME} onClick={onStopNow} type="button">
        Stop now
      </button>
    );
  }

  const status = (
    <>
      <LoopIcon aria-hidden className={iconClassName(color, spinning)} />
      {/* Only the status copy lives in the live region so screen readers are
          not re-announced by progress ticks or control swaps. */}
      <span
        className={cn(
          "flex min-w-0 items-baseline gap-2.5 transition-opacity duration-150 motion-reduce:transition-none",
          fading ? "opacity-0" : "opacity-100",
        )}
        role="status"
      >
        <span className={cn("shrink-0 text-xs font-medium", labelClassName(color))}>
          {displayLabel}
        </span>
        {displayDetail !== null ? (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground">
            {displayDetail === LOOP_OBJECTIVE_UPDATED_DETAIL ? (
              <SteerIcon aria-hidden className="size-3 shrink-0" />
            ) : null}
            <span className="truncate">{displayDetail}</span>
          </span>
        ) : null}
      </span>
    </>
  );

  const progressbar = showProgressbar ? (
    <div
      aria-label="Loop progress"
      aria-valuemax={progress.ariaValueMax ?? undefined}
      aria-valuemin={progress.ariaValueMin}
      aria-valuenow={progress.ariaValueNow ?? undefined}
      aria-valuetext={progress.ariaValueText}
      className="flex min-w-0 flex-1 justify-start"
      role="progressbar"
    >
      {showSegments ? (
        <LoopProgressSegments color={color} pulsing={spinning} segments={progress.segments} />
      ) : null}
    </div>
  ) : (
    <div className="flex-1" />
  );

  return (
    <div className={cn("flex min-h-10 items-center gap-2.5 px-4 py-1.5", className)}>
      {showSteeringTooltip ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="flex min-w-0 items-center gap-2.5" tabIndex={0} />}
          >
            {status}
          </TooltipTrigger>
          <TooltipPopup className="max-w-64">{LOOP_STEERING_TOOLTIP_TEXT}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="flex min-w-0 items-center gap-2.5">{status}</span>
      )}
      {showCounter ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {progress.counterText}
        </span>
      ) : null}
      {progress?.tooltipText != null && showProgressbar ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex min-w-0 flex-1" tabIndex={0} />}>
            {progressbar}
          </TooltipTrigger>
          <TooltipPopup>{progress.tooltipText}</TooltipPopup>
        </Tooltip>
      ) : (
        progressbar
      )}
      <span
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            controlHadFocusRef.current = false;
          }
        }}
        onFocusCapture={() => {
          controlHadFocusRef.current = true;
        }}
        ref={controlWrapperRef}
      >
        {control}
      </span>
    </div>
  );
}
