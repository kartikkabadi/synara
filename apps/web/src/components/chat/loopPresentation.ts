// FILE: loopPresentation.ts
// Purpose: Pure derivation of `/loop` runtime presentation — state, copy, progress, tone, ARIA.
// Layer: Web chat presentation helpers
// No JSX, no hooks, no raw colors. Consumers map semantic tones to styling.

import type {
  LoopStopReason,
  OrchestrationLatestTurn,
  ProviderInteractionMode,
  ThreadLoop,
} from "@synara/contracts";
import { LOOP_OBJECTIVE_PLACEHOLDER, LOOP_SETUP_COMPOSER_PLACEHOLDER } from "~/lib/loop";

export type LoopSemanticColor = "running" | "waiting" | "neutral" | "error";

export type LoopPresentationState =
  | { kind: "armed" }
  | { kind: "starting" }
  | { kind: "running"; iteration: number }
  | { kind: "ready" }
  | { kind: "waiting-approval" }
  | { kind: "waiting-input" }
  | { kind: "waiting-plan" }
  | { kind: "ending" }
  | { kind: "stopping" }
  | { kind: "ended"; reason: LoopStopReason };

export interface LoopProgress {
  kind: "count" | "duration" | "none";
  // Per-segment fill in [0, 1]. Empty for no-budget loops (no strip drawn).
  segments: number[];
  // Authoritative text counter, e.g. "2/5", "18m left", "2 turns".
  counterText: string;
  // Secondary line, e.g. "Safety limit 100" for no-budget loops.
  detailText: string | null;
  // Hover tooltip, e.g. "12 minutes elapsed of 30 minutes".
  tooltipText: string | null;
  ariaValueMin: number;
  ariaValueMax: number | null;
  ariaValueNow: number | null;
  ariaValueText: string;
  // Adaptive presentation refresh cadence; only duration budgets tick.
  tickIntervalMs: number | null;
}

export interface LoopPresentation {
  state: LoopPresentationState;
  label: string;
  detail: string | null;
  color: LoopSemanticColor;
  progress: LoopProgress | null;
}

export interface DeriveLoopPresentationStateInput {
  loop: ThreadLoop | null | undefined;
  latestTurn: OrchestrationLatestTurn | null | undefined;
  interactionMode: ProviderInteractionMode;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  // Epoch milliseconds; injected so derivation stays pure.
  now: number;
}

// Composer placeholder while a loop with a saved objective is active (spec §9).
export const LOOP_ACTIVE_COMPOSER_PLACEHOLDER = "Steer the next iteration…";

export interface DeriveLoopComposerPlaceholderInput {
  isApprovalState: boolean;
  // null when no pending-progress question owns the composer.
  pendingProgressQuestion: "free-form" | "with-options" | null;
  loopSetupOpen: boolean;
  showPlanFollowUp: boolean;
  loop: Pick<ThreadLoop, "active" | "prompt"> | null;
  isSubagentThread: boolean;
  hasLiveTurn: boolean;
  isDisconnected: boolean;
}

// Composer placeholder priority: approval → pending progress → loop setup →
// plan follow-up → active loop → subagent → live turn → disconnected → default.
export function deriveLoopComposerPlaceholder(input: DeriveLoopComposerPlaceholderInput): string {
  if (input.isApprovalState) return "Resolve this approval request to continue";
  if (input.pendingProgressQuestion !== null) {
    return input.pendingProgressQuestion === "free-form"
      ? "Type your answer to continue"
      : "Type your own answer, or leave this blank to use the selected option";
  }
  if (input.loopSetupOpen) return LOOP_SETUP_COMPOSER_PLACEHOLDER;
  if (input.showPlanFollowUp) {
    return "Add feedback to refine the plan, or leave this blank to implement it";
  }
  if (input.loop?.active) {
    return input.loop.prompt.trim().length === 0
      ? LOOP_OBJECTIVE_PLACEHOLDER
      : LOOP_ACTIVE_COMPOSER_PLACEHOLDER;
  }
  if (input.isSubagentThread) return "Message this subagent while it works";
  if (input.hasLiveTurn) return "Ask for follow-up changes";
  if (input.isDisconnected) return "Ask for follow-up changes or attach images";
  return "Ask anything, @tag files/folders, or use / to show available commands";
}

const NORMALIZED_SEGMENT_COUNT = 5;
const MAX_PER_TURN_SEGMENTS = 8;

function pluralizeTurns(count: number): string {
  return count === 1 ? "turn" : "turns";
}

export function isLoopOwnedTurnRunning(
  loop: ThreadLoop,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): boolean {
  return (
    latestTurn?.state === "running" &&
    latestTurn.turnId != null &&
    latestTurn.purpose?.kind === "loop-iteration" &&
    latestTurn.purpose.activationId === loop.activationId
  );
}

function normalizedSegments(fraction: number): number[] {
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * NORMALIZED_SEGMENT_COUNT);
  return Array.from({ length: NORMALIZED_SEGMENT_COUNT }, (_, index) => (index < filled ? 1 : 0));
}

export function formatLoopRemainingTime(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return "Time budget reached";
  if (remainingSeconds < 60) return `${Math.ceil(remainingSeconds)}s left`;
  if (remainingSeconds < 3600) return `${Math.ceil(remainingSeconds / 60)}m left`;
  let hours = Math.floor(remainingSeconds / 3600);
  let minutes = Math.ceil((remainingSeconds % 3600) / 60);
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  return minutes === 0 ? `${hours}h left` : `${hours}h ${minutes}m left`;
}

// Presentation refresh cadence: 30s beyond five minutes, 10s under five
// minutes, every second inside the final minute. Correctness is server-owned.
export function getLoopTickIntervalMs(remainingSeconds: number): number {
  if (remainingSeconds > 300) return 30_000;
  if (remainingSeconds > 60) return 10_000;
  return 1_000;
}

function formatWholeMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function formatAriaRemaining(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return "Time budget reached";
  if (remainingSeconds < 60) {
    const seconds = Math.ceil(remainingSeconds);
    return `${seconds} ${seconds === 1 ? "second" : "seconds"} remaining`;
  }
  const minutes = Math.ceil(remainingSeconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
}

export function deriveLoopProgress(loop: ThreadLoop, now: number): LoopProgress {
  if (loop.maxIterations !== null) {
    const max = loop.maxIterations;
    const iteration = Math.min(loop.iteration, max);
    const segments =
      max <= MAX_PER_TURN_SEGMENTS
        ? Array.from({ length: max }, (_, index) => (index < iteration ? 1 : 0))
        : normalizedSegments(iteration / max);
    return {
      kind: "count",
      segments,
      counterText: `${iteration}/${max}`,
      detailText: null,
      tooltipText: null,
      ariaValueMin: 0,
      ariaValueMax: max,
      ariaValueNow: iteration,
      ariaValueText: `Turn ${iteration} of ${max}`,
      tickIntervalMs: null,
    };
  }

  if (loop.endsAt !== null && loop.durationSeconds != null) {
    const endsAtMs = new Date(loop.endsAt).getTime();
    const totalMs = Math.max(1, loop.durationSeconds * 1000);
    const elapsedMs = Math.min(totalMs, Math.max(0, totalMs - (endsAtMs - now)));
    const remainingSeconds = Math.max(0, (endsAtMs - now) / 1000);
    return {
      kind: "duration",
      segments: normalizedSegments(elapsedMs / totalMs),
      counterText: formatLoopRemainingTime(remainingSeconds),
      detailText: null,
      tooltipText: `${formatWholeMinutes(elapsedMs)} elapsed of ${formatWholeMinutes(totalMs)}`,
      ariaValueMin: 0,
      ariaValueMax: 100,
      ariaValueNow: Math.round((elapsedMs / totalMs) * 100),
      ariaValueText: formatAriaRemaining(remainingSeconds),
      tickIntervalMs: getLoopTickIntervalMs(remainingSeconds),
    };
  }

  return {
    kind: "none",
    segments: [],
    counterText: `${loop.iteration} ${pluralizeTurns(loop.iteration)}`,
    detailText: `Safety limit ${loop.hardCap}`,
    tooltipText: null,
    ariaValueMin: 0,
    ariaValueMax: null,
    ariaValueNow: null,
    ariaValueText: `Loop has run ${loop.iteration} ${pluralizeTurns(loop.iteration)}; no explicit user budget`,
    tickIntervalMs: null,
  };
}

export interface LoopStopReasonCopy {
  // "Loop completed" for budget outcomes, "Loop stopped" otherwise.
  title: string;
  // Stat line, e.g. "5 of 5 turns".
  summary: string;
  // Reason line, e.g. "Budget reached". Null when the summary is the reason.
  reason: string | null;
}

export interface LoopStopReasonContext {
  readonly maxIterations: number | null;
  readonly durationSeconds?: number | null | undefined;
  readonly hardCap: number;
  readonly consecutiveErrors: number;
}

// Whole-minute duration budget from the configured budget; null for loops
// without one. Never derived from endsAt - createdAt: endsAt re-anchors on
// reconfigure while createdAt keeps the original activation start.
export function loopDurationMinutes(loop: {
  readonly durationSeconds?: number | null | undefined;
}): number | null {
  if (loop.durationSeconds == null) return null;
  return Math.max(1, Math.round(loop.durationSeconds / 60));
}

export function formatLoopStopReason(
  reason: LoopStopReason,
  loop: LoopStopReasonContext,
  iteration: number,
): LoopStopReasonCopy {
  switch (reason) {
    case "budget_iterations":
      return {
        title: "Loop completed",
        summary: `${iteration} of ${loop.maxIterations ?? iteration} turns`,
        reason: "Budget reached",
      };
    case "budget_duration":
      return {
        title: "Loop completed",
        summary: "Ran until the time budget ended",
        reason: `${loopDurationMinutes(loop) ?? 0}-minute budget reached`,
      };
    case "hard_cap":
      return {
        title: "Loop stopped",
        summary: `${loop.hardCap} turns`,
        reason: "Safety limit reached",
      };
    case "user_stop":
      return {
        title: "Loop stopped",
        summary: `${iteration} ${pluralizeTurns(iteration)}`,
        reason: "Stopped by you",
      };
    case "toggled_off":
      return {
        title: "Loop stopped",
        summary: `${iteration} ${pluralizeTurns(iteration)}`,
        reason: "Future iterations disabled",
      };
    case "consecutive_errors":
      return {
        title: "Loop stopped",
        summary: `${loop.consecutiveErrors} consecutive errors`,
        reason: "Review the latest error before restarting",
      };
    case "prompt_invalid":
      return {
        title: "Loop stopped",
        summary: "The saved objective was invalid",
        reason: null,
      };
    case "attachments_not_supported":
      return {
        title: "Loop stopped",
        summary: "Loop prompts are text-only",
        reason: null,
      };
    case "replaced_by_manual_policy":
      return {
        title: "Loop stopped",
        summary: `${iteration} ${pluralizeTurns(iteration)}`,
        reason: "Replaced by your manual message",
      };
    case "thread_archived":
      return {
        title: "Loop stopped",
        summary: "This thread was archived",
        reason: null,
      };
    case "thread_deleted":
      return {
        title: "Loop stopped",
        summary: "This thread was deleted",
        reason: null,
      };
    case "thread_unrunnable":
      return {
        title: "Loop stopped",
        summary: "This thread is not available",
        reason: null,
      };
    default:
      return reason satisfies never;
  }
}

// Context-free stop copy for toasts and announcements. Returns null for
// routine lifecycle stops that stay quiet (spec §14.2).
export function formatLoopStopReasonShort(
  reason: LoopStopReason,
): { title: string; description: string } | null {
  switch (reason) {
    case "consecutive_errors":
      return {
        title: "Loop stopped after repeated errors",
        description: "Review the latest error before restarting.",
      };
    case "prompt_invalid":
      return {
        title: "Loop stopped",
        description: "The saved objective was invalid.",
      };
    case "thread_unrunnable":
      return {
        title: "Loop stopped",
        description: "This thread is not available.",
      };
    default:
      return null;
  }
}

function stopReasonColor(reason: LoopStopReason): LoopSemanticColor {
  switch (reason) {
    case "consecutive_errors":
    case "prompt_invalid":
    case "thread_unrunnable":
      return "error";
    default:
      return "neutral";
  }
}

export function deriveLoopPresentationState(
  input: DeriveLoopPresentationStateInput,
): LoopPresentation | null {
  const loop = input.loop;
  if (loop == null) return null;

  const loopTurnRunning = isLoopOwnedTurnRunning(loop, input.latestTurn);
  const progress = deriveLoopProgress(loop, input.now);

  // A matching loop-owned turn can outlive the loop toggle: check running work
  // first, then distinguish active, ending, and stopped.
  if (!loop.active) {
    if (loopTurnRunning) {
      if (loop.lastStopReason === "user_stop") {
        return {
          state: { kind: "stopping" },
          label: "Stopping loop",
          detail: null,
          color: "neutral",
          progress,
        };
      }
      return {
        state: { kind: "ending" },
        label: "Loop ending",
        detail:
          loop.lastStopReason === "budget_duration"
            ? "Time budget reached · current turn finishing"
            : "Current turn will finish",
        color: "neutral",
        progress,
      };
    }
    if (loop.lastStopReason == null) return null;
    const copy = formatLoopStopReason(loop.lastStopReason, loop, loop.iteration);
    return {
      state: { kind: "ended", reason: loop.lastStopReason },
      label: copy.title,
      detail: copy.reason === null ? copy.summary : `${copy.summary} · ${copy.reason}`,
      color: stopReasonColor(loop.lastStopReason),
      progress: null,
    };
  }

  if (loop.prompt.trim().length === 0) {
    return {
      state: { kind: "armed" },
      label: "Loop ready",
      detail: "Add a prompt to start",
      color: "neutral",
      progress: null,
    };
  }

  if (input.hasPendingApprovals) {
    return {
      state: { kind: "waiting-approval" },
      label: "Loop waiting",
      detail: "Approval required",
      color: "waiting",
      progress,
    };
  }

  if (input.hasPendingUserInput) {
    return {
      state: { kind: "waiting-input" },
      label: "Loop waiting",
      detail: "Your input is required",
      color: "waiting",
      progress,
    };
  }

  if (input.interactionMode === "plan") {
    return {
      state: { kind: "waiting-plan" },
      label: "Loop waiting",
      detail: "Plan mode is active",
      color: "waiting",
      progress: null,
    };
  }

  if (loopTurnRunning) {
    const iteration = input.latestTurn?.purpose?.iteration ?? loop.iteration;
    return {
      state: { kind: "running", iteration },
      label: "Loop running",
      detail: progress.counterText,
      color: "running",
      progress,
    };
  }

  if (loop.iteration === 0) {
    return {
      state: { kind: "starting" },
      label: "Starting loop",
      detail: null,
      color: "running",
      progress,
    };
  }

  return {
    state: { kind: "ready" },
    label: "Loop on",
    detail: "Starting the next turn…",
    color: "running",
    progress,
  };
}
