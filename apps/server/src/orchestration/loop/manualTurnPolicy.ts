// FILE: manualTurnPolicy.ts
// Purpose: Loop policy for manual user turns: what a `thread.turn.start` or
//          `thread.turn.interrupt` does to an active loop.
// Layer: Orchestration decision logic

import type {
  OrchestrationThread,
  ThreadLoop,
  ThreadLoopContinuedPayload,
  ThreadLoopOffPayload,
  ThreadTurnPurpose,
} from "@synara/contracts";
import { LoopPrompt } from "@synara/contracts";
import { Schema } from "effect";

import { chooseStopReason, isLoopBudgetExhausted, isLoopExpired } from "./budget.ts";
import { RUNNING_SESSION_STATUSES } from "./continuationPolicy.ts";
import { buildPendingLoopStartCancellationDrafts, type LoopEventDraft } from "./turnEvents.ts";

export type ManualMessageLoopDecision =
  | { kind: "none" }
  | { kind: "loop-off"; payload: typeof ThreadLoopOffPayload.Type }
  | {
      kind: "loop-continued";
      payload: typeof ThreadLoopContinuedPayload.Type;
      purpose: ThreadTurnPurpose;
    };

/**
 * Policy for a manual `thread.turn.start` while a loop is active: the message
 * either retires the loop (budget exhausted, unsupported content, racing
 * pending loop start, invalid prompt) or becomes the next loop-owned iteration
 * with the manual text as the new prompt. Shares the budget/expiry math with
 * `decideLoopContinuation` via the same helpers and clock anchor.
 */
export function decideManualMessageWhileLoopActive(input: {
  loop: ThreadLoop;
  thread: OrchestrationThread;
  message: { text: string; hasAttachments: boolean; hasStructuredReferences: boolean };
  createdAt: string;
}): ManualMessageLoopDecision {
  const { loop, thread, message, createdAt } = input;
  const nowMs = Date.parse(createdAt);
  const loopOff = (
    stopReason: NonNullable<ThreadLoop["lastStopReason"]>,
  ): ManualMessageLoopDecision => ({
    kind: "loop-off",
    payload: {
      threadId: thread.id,
      stopReason,
      loop: {
        ...loop,
        active: false,
        lastStopReason: stopReason,
        updatedAt: createdAt,
      },
    },
  });

  const pendingLoopStart =
    thread.pendingTurnStart?.purpose?.kind === "loop-iteration" &&
    thread.pendingTurnStart.purpose.activationId === loop.activationId;

  if (message.hasAttachments || message.hasStructuredReferences) {
    // Text-only v1: loop prompts cannot carry attachments, skill references,
    // or mentions.
    return loopOff("attachments_not_supported");
  }
  if (isLoopExpired(loop, nowMs)) {
    // Duration budget has expired: stop the loop, but let the user's manual
    // message continue as a normal turn.
    return loopOff("budget_duration");
  }
  if (isLoopBudgetExhausted(loop)) {
    // Budget already exhausted: stop the loop, but let the user's manual
    // message continue as a normal turn.
    return loopOff(chooseStopReason(loop));
  }
  if (pendingLoopStart) {
    // A loop-owned turn start is already pending; a racing manual message
    // wins and retires the loop rather than fighting the pending start.
    return loopOff("replaced_by_manual_policy");
  }

  // A manual user message while the loop is active becomes (or replaces)
  // the loop prompt and doubles as the next loop-owned iteration.
  let manualPrompt: LoopPrompt;
  try {
    manualPrompt = Schema.decodeUnknownSync(LoopPrompt)(message.text);
  } catch {
    return loopOff("prompt_invalid");
  }
  const nextIteration = loop.iteration + 1;
  const purpose: ThreadTurnPurpose = {
    kind: "loop-iteration",
    activationId: loop.activationId,
    iteration: nextIteration,
  };
  return {
    kind: "loop-continued",
    purpose,
    payload: {
      threadId: thread.id,
      nextIteration,
      nextConsecutiveErrors: loop.consecutiveErrors,
      loop: {
        ...loop,
        prompt: manualPrompt,
        iteration: nextIteration,
        lastStopReason: null,
        updatedAt: createdAt,
      },
    },
  };
}

export interface TurnStartLoopResolution {
  purpose: ThreadTurnPurpose | undefined;
  // 0..1 of loop-off | loop-continued.
  loopEvents: ReadonlyArray<LoopEventDraft>;
  // Loop-owned turns always queue when a live turn is running so Codex and
  // non-Codex providers share the same replacement semantics.
  dispatchModeOverride: "queue" | null;
}

/**
 * Resolves what an inbound `thread.turn.start` does to the thread's loop:
 * nothing (no active loop), retires it, or claims the turn as the next
 * loop-owned iteration and forces queue dispatch.
 */
export function resolveTurnStartLoopPolicy(input: {
  thread: OrchestrationThread;
  message: { text: string; hasAttachments: boolean; hasStructuredReferences: boolean };
  createdAt: string;
}): TurnStartLoopResolution {
  const loop = input.thread.loop;
  if (loop?.active !== true) {
    return { purpose: undefined, loopEvents: [], dispatchModeOverride: null };
  }
  const decision = decideManualMessageWhileLoopActive({
    loop,
    thread: input.thread,
    message: input.message,
    createdAt: input.createdAt,
  });
  switch (decision.kind) {
    case "none":
      return { purpose: undefined, loopEvents: [], dispatchModeOverride: null };
    case "loop-off":
      return {
        purpose: undefined,
        // The manual message wins the race: durably retire the loop-owned
        // pending start alongside the loop so it can never strand the thread.
        loopEvents: [
          ...buildPendingLoopStartCancellationDrafts({
            thread: input.thread,
            activationId: loop.activationId,
            createdAt: input.createdAt,
          }),
          { type: "thread.loop-off", payload: decision.payload },
        ],
        dispatchModeOverride: null,
      };
    case "loop-continued":
      return {
        purpose: decision.purpose,
        loopEvents: [{ type: "thread.loop-continued", payload: decision.payload }],
        dispatchModeOverride: "queue",
      };
  }
}

/**
 * Stop-now atomicity: interrupting is inherently a stop intent. The loop turns
 * off when the interrupted turn is loop-owned, and also when no concrete turn
 * can be resolved but the session is live (starting/running/stopping) or a
 * loop-owned start is pending — otherwise the loop would silently survive a
 * user's Stop.
 */
export function decideInterruptLoopOff(input: {
  thread: OrchestrationThread;
  interruptTurnId: string | undefined;
  isLoopOwnedInterrupt: boolean;
  createdAt: string;
}): typeof ThreadLoopOffPayload.Type | null {
  const { thread, interruptTurnId, isLoopOwnedInterrupt, createdAt } = input;
  const loop = thread.loop;
  if (loop?.active !== true) {
    return null;
  }
  const pendingLoopStart =
    thread.pendingTurnStart?.purpose?.kind === "loop-iteration" &&
    thread.pendingTurnStart.purpose.activationId === loop.activationId;
  const sessionLive =
    thread.session !== null && RUNNING_SESSION_STATUSES.has(thread.session.status);
  const shouldStop =
    isLoopOwnedInterrupt || (interruptTurnId === undefined && (sessionLive || pendingLoopStart));
  if (!shouldStop) {
    return null;
  }
  return {
    threadId: thread.id,
    stopReason: "user_stop",
    loop: {
      ...loop,
      active: false,
      lastStopReason: "user_stop",
      updatedAt: createdAt,
    },
  };
}
