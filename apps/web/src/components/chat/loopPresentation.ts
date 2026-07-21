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

import type { ThreadSession } from "../../types";

export type LoopSemanticColor = "running" | "waiting" | "neutral" | "error";

export type LoopPresentationState =
  | { kind: "armed" }
  | { kind: "starting" }
  | { kind: "running"; iteration: number }
  | { kind: "ready" }
  | { kind: "waiting-approval" }
  | { kind: "waiting-input" }
  | { kind: "waiting-plan" }
  | { kind: "ending"; iteration: number }
  | { kind: "stopping"; iteration: number }
  | { kind: "ended"; reason: LoopStopReason };

export interface LoopProgress {
  kind: "count" | "duration" | "none";
  // Per-segment fill in [0, 1]. Empty for no-budget loops (no strip drawn).
  segments: number[];
  // Authoritative text counter, e.g. "2 / 5", "18m left", "2 turns".
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
  session: ThreadSession | null;
  interactionMode: ProviderInteractionMode;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  // Epoch milliseconds; injected so derivation stays pure.
  now: number;
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
      counterText: `${iteration} / ${max}`,
      detailText: null,
      tooltipText: null,
      ariaValueMin: 0,
      ariaValueMax: max,
      ariaValueNow: iteration,
      ariaValueText: `${iteration} of ${max} loop turns started`,
      tickIntervalMs: null,
    };
  }

  if (loop.endsAt !== null) {
    const endsAtMs = new Date(loop.endsAt).getTime();
    const createdAtMs = new Date(loop.createdAt).getTime();
    const totalMs = Math.max(1, endsAtMs - createdAtMs);
    const elapsedMs = Math.min(totalMs, Math.max(0, now - createdAtMs));
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

const LOOP_START_LABEL_MAX_PROMPT_CHARS = 60;

// Reconstructs the `/loop` invocation for the transcript start divider,
// e.g. "Loop started · /loop 5 fix the tests". Long prompts are truncated.
export function formatLoopStartLabel(loop: {
  readonly prompt: string;
  readonly maxIterations: number | null;
  readonly endsAt: string | null;
  readonly createdAt: string;
}): string {
  let budgetToken = "";
  if (loop.maxIterations !== null) {
    budgetToken = `${loop.maxIterations} `;
  } else if (loop.endsAt !== null) {
    const totalMs = new Date(loop.endsAt).getTime() - new Date(loop.createdAt).getTime();
    budgetToken = `${Math.max(1, Math.round(totalMs / 60_000))}m `;
  }
  const prompt = loop.prompt.trim();
  const truncatedPrompt =
    prompt.length > LOOP_START_LABEL_MAX_PROMPT_CHARS
      ? `${prompt.slice(0, LOOP_START_LABEL_MAX_PROMPT_CHARS).trimEnd()}…`
      : prompt;
  const invocation = `/loop ${budgetToken}${truncatedPrompt}`.trimEnd();
  return `Loop started · ${invocation}`;
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
  readonly endsAt: string | null;
  readonly createdAt: string;
  readonly hardCap: number;
  readonly consecutiveErrors: number;
}

function configuredBudgetMinutes(loop: LoopStopReasonContext): number {
  if (loop.endsAt === null) return 0;
  const totalMs = new Date(loop.endsAt).getTime() - new Date(loop.createdAt).getTime();
  return Math.max(1, Math.round(totalMs / 60_000));
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
        reason: `${configuredBudgetMinutes(loop)}-minute budget reached`,
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

export function getLoopAriaValueText(state: LoopPresentationState): string {
  switch (state.kind) {
    case "armed":
      return "Loop ready. Add a prompt to start.";
    case "starting":
      return "Starting loop.";
    case "running":
      return `Loop running. Turn ${state.iteration}.`;
    case "ready":
      return "Loop on. Starting the next turn.";
    case "waiting-approval":
      return "Loop waiting for approval.";
    case "waiting-input":
      return "Loop waiting for your input.";
    case "waiting-plan":
      return "Loop waiting. Plan mode is active.";
    case "ending":
      return "Loop will stop after the current turn.";
    case "stopping":
      return "Stopping loop.";
    case "ended": {
      const copy = formatLoopStopReason(
        state.reason,
        { maxIterations: null, endsAt: null, createdAt: "", hardCap: 0, consecutiveErrors: 0 },
        0,
      );
      // The duration reason line is dynamic (minutes) and reads poorly
      // without loop data; fall back to its static summary.
      const useSummary = copy.reason === null || state.reason === "budget_duration";
      return useSummary ? `${copy.title}. ${copy.summary}.` : `${copy.title}. ${copy.reason}.`;
    }
    default:
      return state satisfies never;
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
          state: { kind: "stopping", iteration: loop.iteration },
          label: "Stopping loop",
          detail: null,
          color: "neutral",
          progress,
        };
      }
      return {
        state: { kind: "ending", iteration: loop.iteration },
        label: "Loop ending",
        detail: "Current turn will finish",
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
