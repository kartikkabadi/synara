// FILE: ComposerGoalHeader.tsx
// Purpose: Persistent thread-goal strip stacked flush onto the top of the composer,
// mirroring the live file-changes/queued headers. Collapsed it shows a one-line
// preview that fades out at the end plus the live pursuit timer; the chevron
// expands the full objective. Edit / pause-resume / delete act on the persisted goal.
// Layer: Chat composer UI
// Exports: ComposerGoalHeader, goalElapsedMs, goalHeaderLabel, formatGoalTokenCount

import { useState } from "react";

import type { ThreadGoalPauseReason } from "@synara/contracts";

import { useNowMs } from "~/hooks/useNowMs";
import { GoalIcon, PauseOutlineIcon, PencilIcon, PlayOutlineIcon, TrashCanIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { formatClockDuration } from "../../session-logic";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { IconButton } from "../ui/icon-button";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

/**
 * Elapsed pursuit time for a goal, or null when the thread predates goal timing
 * (no `goalStartedAt`). While paused the clock freezes at `goalPausedAt`; the
 * server rebases `goalStartedAt` on resume so the paused span never counts.
 */
export function goalElapsedMs(
  input: {
    readonly goalStartedAt?: string | null | undefined;
    readonly goalPausedAt?: string | null | undefined;
  },
  nowMs: number,
): number | null {
  const startedMs = Date.parse(input.goalStartedAt ?? "");
  if (!Number.isFinite(startedMs)) {
    return null;
  }
  const pausedMs = Date.parse(input.goalPausedAt ?? "");
  const endMs = Number.isFinite(pausedMs) ? pausedMs : nowMs;
  return Math.max(0, endMs - startedMs);
}

export function formatGoalTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 10_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}

export function goalHeaderLabel(input: {
  readonly paused: boolean;
  readonly goalPausedReason?: ThreadGoalPauseReason | null | undefined;
  readonly goalBudgetLimitedAt?: string | null | undefined;
}): string {
  if (input.paused) {
    switch (input.goalPausedReason ?? "user") {
      case "blocked":
        return "Goal blocked";
      case "error":
        return "Goal paused after error";
      case "budget":
        return "Goal budget reached";
      default:
        return "Goal paused";
    }
  }
  // The wrap-up turn granted at budget exhaustion is still in flight.
  if ((input.goalBudgetLimitedAt ?? null) !== null) {
    return "Goal: wrapping up";
  }
  return "Pursuing goal";
}

interface ComposerGoalHeaderProps {
  goal: string;
  goalStartedAt?: string | null | undefined;
  goalPausedAt?: string | null | undefined;
  goalPausedReason?: ThreadGoalPauseReason | null | undefined;
  goalTokenBudget?: number | null | undefined;
  goalTokensUsed?: number | undefined;
  goalBudgetLimitedAt?: string | null | undefined;
  onEdit: () => void;
  onSetPaused: (paused: boolean) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  attachedToPrevious?: boolean;
  // False while the goal is only staged on a draft thread: pursuit has not
  // started, so pausing has nothing to act on and the control is hidden.
  canPause?: boolean;
}

export function ComposerGoalHeader({
  goal,
  goalStartedAt,
  goalPausedAt,
  goalPausedReason,
  goalTokenBudget,
  goalTokensUsed,
  goalBudgetLimitedAt,
  onEdit,
  onSetPaused,
  onClear,
  attachedToPrevious: attachedToPreviousProp,
  canPause = true,
}: ComposerGoalHeaderProps) {
  const [open, setOpen] = useState(false);
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const paused = (goalPausedAt ?? null) !== null;
  const nowMs = useNowMs(!paused && goalStartedAt != null);
  const elapsedMs = goalElapsedMs({ goalStartedAt, goalPausedAt }, nowMs);
  const label = canPause
    ? goalHeaderLabel({ paused, goalPausedReason, goalBudgetLimitedAt })
    : "Goal";
  const budgetLabel =
    (goalTokenBudget ?? null) !== null
      ? `${formatGoalTokenCount(goalTokensUsed ?? 0)}/${formatGoalTokenCount(goalTokenBudget ?? 0)} tokens`
      : null;

  return (
    <ComposerStackedPanel
      attachedToPrevious={attachedToPrevious}
      data-testid="composer-goal-header"
    >
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          <GoalIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ComposerStackedPanelRowLabel className="shrink-0">{label}</ComposerStackedPanelRowLabel>
          {open ? null : (
            <span
              data-testid="composer-goal-preview"
              // Fade-out instead of an ellipsis so the preview reads as a peek
              // into the full objective behind the chevron.
              className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground/80 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]"
            >
              {goal}
            </span>
          )}
          {budgetLabel !== null ? (
            <span className="shrink-0 tabular-nums text-muted-foreground/80">{budgetLabel}</span>
          ) : null}
          {elapsedMs !== null ? (
            <span className="shrink-0 tabular-nums text-muted-foreground/80">
              {formatClockDuration(elapsedMs)}
            </span>
          ) : null}
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0">
          <IconButton variant="ghost" size="icon-chip" label="Edit goal" onClick={onEdit}>
            <PencilIcon />
          </IconButton>
          {canPause ? (
            <IconButton
              variant="ghost"
              size="icon-chip"
              label={paused ? "Resume goal" : "Pause goal"}
              onClick={() => void onSetPaused(!paused)}
            >
              {paused ? <PlayOutlineIcon /> : <PauseOutlineIcon />}
            </IconButton>
          ) : null}
          <IconButton
            variant="ghost"
            size="icon-chip"
            label="Delete goal"
            onClick={() => void onClear()}
          >
            <TrashCanIcon />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-chip"
            label={open ? "Collapse goal" : "Expand goal"}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <DisclosureChevron open={open} />
          </IconButton>
        </div>
      </ComposerStackedPanelRow>
      <DisclosureRegion open={open}>
        <div
          className={cn(
            COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
            COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
          )}
        >
          <p className="whitespace-pre-wrap break-words text-ui text-muted-foreground/80">{goal}</p>
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
}
