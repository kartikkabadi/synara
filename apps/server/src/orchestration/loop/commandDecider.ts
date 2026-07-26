// FILE: commandDecider.ts
// Purpose: Single owner of every `/loop` command transition (set/off/toggle/
//          continue). `decider.ts` case arms delegate here so the continuation
//          policy, budget validation, and stop semantics live in one module.
// Layer: Orchestration decision logic
// Depends on: continuationPolicy.ts (pure continuation policy), @synara/shared/loop

import type {
  OrchestrationCommand,
  OrchestrationThread,
  ThreadLoop,
  ThreadTurnPurpose,
} from "@synara/contracts";
import {
  LoopActivationId,
  MessageId,
  LOOP_DEFAULT_HARD_CAP,
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
  LOOP_PROMPT_MAX_INPUT_CHARS,
  LoopPrompt,
} from "@synara/contracts";
import { validateLoopBudget } from "@synara/shared/loop";
import { Schema } from "effect";

import { buildLoopContinuationThreadView, decideLoopContinuation } from "./continuationPolicy.ts";
import {
  buildLoopIterationTurnDrafts,
  buildPendingLoopStartCancellationDrafts,
  type LoopEventDraft,
} from "./turnEvents.ts";

export type LoopCommandDecision =
  | { kind: "invalid"; detail: string }
  | { kind: "events"; events: ReadonlyArray<LoopEventDraft> };

type LoopSetCommand = Extract<OrchestrationCommand, { type: "thread.loop.set" }>;
type LoopOffCommand = Extract<OrchestrationCommand, { type: "thread.loop.off" }>;
type LoopToggleCommand = Extract<OrchestrationCommand, { type: "thread.loop.toggle" }>;
type LoopContinueCommand = Extract<OrchestrationCommand, { type: "thread.loop.continue" }>;

function invalid(detail: string): LoopCommandDecision {
  return { kind: "invalid", detail };
}

function events(drafts: ReadonlyArray<LoopEventDraft>): LoopCommandDecision {
  return { kind: "events", events: drafts };
}

function requireLoopableThread(
  thread: OrchestrationThread,
): { kind: "ok" } | { kind: "invalid"; detail: string } {
  if (thread.parentThreadId !== null) {
    return { kind: "invalid", detail: `Loops are only allowed on top-level threads.` };
  }
  if (thread.deletedAt !== null) {
    return { kind: "invalid", detail: `Thread '${thread.id}' is deleted.` };
  }
  if (thread.archivedAt !== null) {
    return { kind: "invalid", detail: `Thread '${thread.id}' is archived.` };
  }
  return { kind: "ok" };
}

function describeBudgetError(error: NonNullable<ReturnType<typeof validateLoopBudget>>): string {
  switch (error.field) {
    case "budget":
      return `Cannot set both a count and a duration budget.`;
    case "maxIterations":
      return `maxIterations must be between 1 and ${LOOP_MAX_COUNT_BUDGET}.`;
    case "durationSeconds":
      return `durationSeconds must be between 1 and ${LOOP_MAX_DURATION_SECONDS}.`;
  }
}

// Deterministic loop user-message identity: at-least-once command execution
// must never mint divergent message ids for the same continuation.
function loopMessageIdForCommand(command: LoopContinueCommand): MessageId {
  return MessageId.makeUnsafe(`loop-msg:${command.commandId}`);
}

export function decideLoopSet(
  command: LoopSetCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  const loopable = requireLoopableThread(thread);
  if (loopable.kind === "invalid") {
    return invalid(loopable.detail);
  }
  const budgetError = validateLoopBudget({
    maxIterations: command.maxIterations,
    durationSeconds: command.durationSeconds,
  });
  if (budgetError !== null) {
    return invalid(describeBudgetError(budgetError));
  }

  const existingLoop = thread.loop?.active === true ? thread.loop : null;
  if (
    command.expectedActivationId !== undefined &&
    existingLoop?.activationId !== command.expectedActivationId
  ) {
    return invalid(`Loop activation '${command.expectedActivationId}' is no longer active.`);
  }
  const isReconfigure = existingLoop !== null;
  // Duration budget is anchored from server time: client-originated loop
  // commands have `createdAt` re-stamped with the server clock at the dispatch
  // boundary, so a skewed client clock cannot extend or shorten a loop run.
  const endsAt =
    command.durationSeconds !== null
      ? new Date(Date.parse(command.createdAt) + command.durationSeconds * 1000).toISOString()
      : null;

  let prompt: string;
  if (command.prompt !== null && command.prompt.length > 0) {
    try {
      prompt = Schema.decodeUnknownSync(LoopPrompt)(command.prompt);
    } catch {
      return invalid(
        `Loop prompt must be 1-${LOOP_PROMPT_MAX_INPUT_CHARS} characters, not whitespace-only, and cannot start with a slash command.`,
      );
    }
  } else if (command.prompt !== null && command.prompt.length === 0) {
    // Tri-state contract: null preserves, non-empty replaces. An explicit empty
    // string must never silently clear an active loop's prompt.
    if (isReconfigure && existingLoop.prompt !== "") {
      return invalid(
        `Loop prompt cannot be cleared with an empty string; pass null to preserve it or non-empty text to replace it.`,
      );
    }
    prompt = "";
  } else {
    prompt = isReconfigure ? existingLoop.prompt : "";
  }
  // Budget-less arming carries no explicit budget; only the hard cap bounds
  // the activation (issue #49 §3.3).
  const maxIterations = command.maxIterations;

  // Locked reconfigure rule: any successful set while active starts a new
  // activation window — counters reset, new activationId, original createdAt.
  const loop: ThreadLoop = {
    active: true,
    prompt,
    iteration: 0,
    maxIterations,
    endsAt,
    durationSeconds: command.durationSeconds,
    hardCap: LOOP_DEFAULT_HARD_CAP,
    consecutiveErrors: 0,
    lastSettledIteration: 0,
    lastStopReason: null,
    activationId: LoopActivationId.makeUnsafe(command.commandId),
    createdAt: isReconfigure ? existingLoop.createdAt : command.createdAt,
    updatedAt: command.createdAt,
  };
  return events([
    // A reconfigure starts a new activation: durably retire the outgoing
    // activation's pending start so it cannot linger if the provider never
    // binds it to a concrete turn.
    ...(isReconfigure
      ? buildPendingLoopStartCancellationDrafts({
          thread,
          activationId: existingLoop.activationId,
          createdAt: command.createdAt,
        })
      : []),
    {
      type: "thread.loop-set",
      payload: { threadId: command.threadId, loop },
    },
  ]);
}

export function decideLoopOff(
  command: LoopOffCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  const loop = thread.loop;
  // Thread never had a loop: emit nothing rather than fabricating a synthetic
  // ThreadLoop for an activation that never existed.
  if (loop === null || loop === undefined) {
    return events([]);
  }
  const stopReason = command.reason ?? "user_stop";
  return events([
    // Off retires the activation's pending start durably: without this, a
    // stop before the provider binds a concrete turn would strand the pending
    // row forever.
    ...(loop.active
      ? buildPendingLoopStartCancellationDrafts({
          thread,
          activationId: loop.activationId,
          createdAt: command.createdAt,
        })
      : []),
    {
      type: "thread.loop-off",
      payload: {
        threadId: command.threadId,
        stopReason,
        // Idempotent off: an already-off loop is re-emitted unchanged.
        loop: loop.active
          ? {
              ...loop,
              active: false,
              lastStopReason: stopReason,
              updatedAt: command.createdAt,
            }
          : loop,
      },
    },
  ]);
}

export function decideLoopToggle(
  command: LoopToggleCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  if (thread.loop?.active === true) {
    // Bare `/loop` while active toggles future iterations off but leaves a
    // currently running loop-owned turn alone to settle on its own. A pending
    // (not yet running) loop-owned start is durably retired with the loop.
    return events([
      ...buildPendingLoopStartCancellationDrafts({
        thread,
        activationId: thread.loop.activationId,
        createdAt: command.createdAt,
      }),
      {
        type: "thread.loop-off",
        payload: {
          threadId: command.threadId,
          stopReason: "toggled_off",
          loop: {
            ...thread.loop,
            active: false,
            lastStopReason: "toggled_off",
            updatedAt: command.createdAt,
          },
        },
      },
    ]);
  }

  const loopable = requireLoopableThread(thread);
  if (loopable.kind === "invalid") {
    return invalid(loopable.detail);
  }

  const loop: ThreadLoop = {
    active: true,
    prompt: "",
    iteration: 0,
    // Toggle-armed loops carry no explicit budget; the hard cap bounds them.
    maxIterations: null,
    endsAt: null,
    durationSeconds: null,
    hardCap: LOOP_DEFAULT_HARD_CAP,
    consecutiveErrors: 0,
    lastSettledIteration: 0,
    lastStopReason: null,
    activationId: LoopActivationId.makeUnsafe(command.commandId),
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return events([
    {
      type: "thread.loop-set",
      payload: { threadId: command.threadId, loop },
    },
  ]);
}

export function decideLoopContinue(
  command: LoopContinueCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  if (thread.loop?.active !== true) {
    return events([]);
  }
  if (
    command.expectedUpdatedAt !== undefined &&
    thread.loop.updatedAt !== command.expectedUpdatedAt
  ) {
    return events([]);
  }
  if (
    command.expectedActivationId !== undefined &&
    thread.loop.activationId !== command.expectedActivationId
  ) {
    return events([]);
  }
  const decision = decideLoopContinuation({
    loop: thread.loop,
    // `thread.loop.continue` is server-dispatched only, so `createdAt` is
    // already server time; anchoring to the command (not wall clock) keeps
    // at-least-once replays classifying identically.
    nowMs: Date.parse(command.createdAt),
    thread: buildLoopContinuationThreadView(thread),
  });

  if (decision.type === "wait") {
    // Waits persist settlement accounting (a terminal outcome can arrive
    // while the next iteration is already queued) and must still produce an
    // event: a zero-event command is rejected with a durable receipt,
    // permanently burning this deterministic commandId. The dedicated
    // wait-noted event bumps updatedAt to rotate the next continuation
    // commandId without re-triggering LoopReactor the way thread.loop-set
    // would.
    return events([
      {
        type: "thread.loop-wait-noted",
        payload: {
          threadId: command.threadId,
          loop: {
            ...thread.loop,
            consecutiveErrors: decision.nextConsecutiveErrors,
            lastSettledIteration: decision.nextLastSettledIteration,
            updatedAt: command.createdAt,
          },
        },
      },
    ]);
  }
  if (decision.type === "off") {
    return events([
      ...buildPendingLoopStartCancellationDrafts({
        thread,
        activationId: thread.loop.activationId,
        createdAt: command.createdAt,
      }),
      {
        type: "thread.loop-off",
        payload: {
          threadId: command.threadId,
          stopReason: decision.reason,
          loop: {
            ...thread.loop,
            active: false,
            lastStopReason: decision.reason,
            consecutiveErrors: decision.nextConsecutiveErrors,
            lastSettledIteration: decision.nextLastSettledIteration,
            updatedAt: command.createdAt,
          },
        },
      },
    ]);
  }
  const prompt = thread.loop.prompt;
  if (prompt === "") {
    // Unreachable: the decision policy waits on a missing prompt.
    return events([]);
  }
  const messageId = loopMessageIdForCommand(command);
  const nextIteration = decision.nextIteration;
  const loop = {
    ...thread.loop,
    iteration: nextIteration,
    consecutiveErrors: decision.nextConsecutiveErrors,
    lastSettledIteration: decision.nextLastSettledIteration,
    lastStopReason: null,
    updatedAt: command.createdAt,
  } satisfies ThreadLoop;
  const purpose: ThreadTurnPurpose = {
    kind: "loop-iteration",
    activationId: loop.activationId,
    iteration: nextIteration,
  };
  return events([
    ...buildLoopIterationTurnDrafts({
      threadId: command.threadId,
      messageId,
      prompt,
      purpose,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: command.createdAt,
    }),
    {
      type: "thread.loop-continued",
      payload: {
        threadId: command.threadId,
        nextIteration,
        nextConsecutiveErrors: decision.nextConsecutiveErrors,
        loop,
      },
    },
  ]);
}

export function decideLoopCommand(
  command: LoopSetCommand | LoopOffCommand | LoopToggleCommand | LoopContinueCommand,
  thread: OrchestrationThread,
): LoopCommandDecision {
  switch (command.type) {
    case "thread.loop.set":
      return decideLoopSet(command, thread);
    case "thread.loop.off":
      return decideLoopOff(command, thread);
    case "thread.loop.toggle":
      return decideLoopToggle(command, thread);
    case "thread.loop.continue":
      return decideLoopContinue(command, thread);
  }
}
