// FILE: presentation.ts
// Purpose: Pure derivation of `/loop` runtime presentation — state, copy, progress, tone, ARIA.
// Layer: Web chat presentation helpers
// No JSX, no hooks, no raw colors. Consumers map semantic tones to styling.
// Grouped into three sections: progress, stop copy, and presentation state.

import type {
  LoopStopReason,
  OrchestrationLatestTurn,
  ProviderInteractionMode,
  ThreadLoop,
} from "@synara/contracts";

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

// --- Progress ---

// Visual cap: budgets above this render proportionally across this many
// segments instead of one segment per turn.
const MAX_VISUAL_SEGMENTS = 12;

function pluralizeTurns(count: number): string {
  return count === 1 ? "turn" : "turns";
}

export function isLoopOwnedTurnRunning(
  loop: ThreadLoop,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): boolean {
  return (
    isAnyLoopOwnedTurnRunning(latestTurn) &&
    latestTurn?.purpose?.kind === "loop-iteration" &&
    latestTurn.purpose.activationId === loop.activationId
  );
}

// Activation-agnostic ownership for destructive stop controls: after Edit Loop
// creates a new activation, the still-running turn belongs to the old one, but
// "Stop now" must interrupt it all the same. Current-activation matching
// (isLoopOwnedTurnRunning) stays reserved for progress/iteration presentation.
export function isAnyLoopOwnedTurnRunning(
  latestTurn: OrchestrationLatestTurn | null | undefined,
): boolean {
  return (
    latestTurn?.state === "running" &&
    latestTurn.turnId != null &&
    latestTurn.purpose?.kind === "loop-iteration"
  );
}

// Distributes overall progress across `count` segments with fractional fills:
// completed segments are 1, the boundary segment is partial, the rest 0.
function proportionalSegments(fraction: number, count: number): number[] {
  const clamped = Math.min(1, Math.max(0, fraction));
  return Array.from({ length: count }, (_, index) =>
    Math.min(1, Math.max(0, clamped * count - index)),
  );
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

// Human-readable duration for budget labels (e.g. "10 seconds", "30 minutes", "1 hour").
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "0 seconds";
  if (seconds < 60) {
    const value = Math.ceil(seconds);
    return `${value} ${value === 1 ? "second" : "seconds"}`;
  }
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (minutes === 0) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${hours}h ${minutes}m`;
}

// Stop-reason copy for duration budgets (e.g. "10-second budget reached").
export function formatDurationBudget(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "Time budget reached";
  if (seconds < 60) return `${Math.ceil(seconds)}-second budget reached`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}-minute budget reached`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (minutes === 0) return `${hours}-hour budget reached`;
  return `${hours}h ${minutes}m budget reached`;
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
    const segments = proportionalSegments(iteration / max, Math.min(max, MAX_VISUAL_SEGMENTS));
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
      segments: proportionalSegments(elapsedMs / totalMs, MAX_VISUAL_SEGMENTS),
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

// --- Stop copy ---

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
        reason: formatDurationBudget(loop.durationSeconds),
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
        summary: "Attachments aren't supported in loops",
        reason: "Your message ran as a normal turn instead",
      };
    case "replaced_by_manual_policy":
      return {
        title: "Loop stopped",
        summary: `${iteration} ${pluralizeTurns(iteration)}`,
        reason: "Your message ran as a normal turn instead",
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
// routine lifecycle stops that stay quiet (spec §14.2). `tone` separates
// exceptional failures (error) from informational stops (warning).
export function formatLoopStopReasonShort(
  reason: LoopStopReason,
): { title: string; description: string; tone: "error" | "warning" } | null {
  switch (reason) {
    case "consecutive_errors":
      return {
        title: "Loop stopped after repeated errors",
        description: "Review the latest error before restarting.",
        tone: "error",
      };
    case "prompt_invalid":
      return {
        title: "Loop stopped",
        description: "The saved objective was invalid.",
        tone: "error",
      };
    case "thread_unrunnable":
      return {
        title: "Loop stopped",
        description: "This thread is not available.",
        tone: "error",
      };
    case "attachments_not_supported":
    case "replaced_by_manual_policy":
      return {
        title: "Loop stopped",
        description: "Your message was sent as a normal message.",
        tone: "warning",
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

// --- Presentation state ---

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
