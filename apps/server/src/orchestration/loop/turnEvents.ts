// FILE: turnEvents.ts
// Purpose: Shared builder for the user-message + turn-start event drafts of a
//          loop-owned iteration, so `decideLoopContinue` and the manual
//          `thread.turn.start` path emit the same shape.
// Layer: Orchestration decision logic

import type {
  MessageId,
  ThreadId,
  ThreadLoopContinuedPayload,
  ThreadLoopOffPayload,
  ThreadLoopSetPayload,
  ThreadLoopWaitNotedPayload,
  ThreadMessageSentPayload,
  ThreadTurnPurpose,
  ThreadTurnStartRequestedPayload,
} from "@synara/contracts";
import { DEFAULT_TURN_DISPATCH_MODE } from "@synara/contracts";

export type LoopEventDraft =
  | { type: "thread.loop-set"; payload: typeof ThreadLoopSetPayload.Type }
  | { type: "thread.loop-off"; payload: typeof ThreadLoopOffPayload.Type }
  | { type: "thread.loop-wait-noted"; payload: typeof ThreadLoopWaitNotedPayload.Type }
  | { type: "thread.loop-continued"; payload: typeof ThreadLoopContinuedPayload.Type }
  | { type: "thread.message-sent"; payload: typeof ThreadMessageSentPayload.Type }
  | { type: "thread.turn-start-requested"; payload: typeof ThreadTurnStartRequestedPayload.Type };

export const LOOP_TURN_DEFAULTS = {
  assistantDeliveryMode: "buffered",
  dispatchMode: DEFAULT_TURN_DISPATCH_MODE,
} as const;

export type MessageSentDraft = {
  type: "thread.message-sent";
  payload: typeof ThreadMessageSentPayload.Type;
};

export type TurnStartRequestedDraft = {
  type: "thread.turn-start-requested";
  payload: typeof ThreadTurnStartRequestedPayload.Type;
};

export function buildLoopIterationTurnDrafts(input: {
  threadId: ThreadId;
  messageId: MessageId;
  prompt: string;
  purpose: ThreadTurnPurpose;
  runtimeMode: typeof ThreadTurnStartRequestedPayload.Type.runtimeMode;
  interactionMode: typeof ThreadTurnStartRequestedPayload.Type.interactionMode;
  createdAt: string;
}): [MessageSentDraft, TurnStartRequestedDraft] {
  return [
    {
      type: "thread.message-sent",
      payload: {
        threadId: input.threadId,
        messageId: input.messageId,
        role: "user",
        text: input.prompt,
        dispatchMode: LOOP_TURN_DEFAULTS.dispatchMode,
        turnId: null,
        streaming: false,
        source: "native",
        purpose: input.purpose,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    },
    {
      type: "thread.turn-start-requested",
      payload: {
        threadId: input.threadId,
        messageId: input.messageId,
        assistantDeliveryMode: LOOP_TURN_DEFAULTS.assistantDeliveryMode,
        dispatchMode: LOOP_TURN_DEFAULTS.dispatchMode,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        purpose: input.purpose,
        createdAt: input.createdAt,
      },
    },
  ];
}
