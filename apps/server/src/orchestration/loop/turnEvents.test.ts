import type { MessageId, ThreadId, ThreadTurnPurpose } from "@synara/contracts";
import { LoopActivationId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildLoopIterationTurnDrafts, LOOP_TURN_DEFAULTS } from "./turnEvents.ts";

const now = "2026-07-19T12:00:00.000Z";

const purpose: ThreadTurnPurpose = {
  kind: "loop-iteration",
  activationId: LoopActivationId.makeUnsafe("loop-activation"),
  iteration: 3,
};

describe("buildLoopIterationTurnDrafts", () => {
  it("builds a paired user message and turn-start request for the iteration", () => {
    const [messageDraft, turnDraft] = buildLoopIterationTurnDrafts({
      threadId: "thread-1" as unknown as ThreadId,
      messageId: "msg-1" as unknown as MessageId,
      prompt: "fix the tests",
      purpose,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    });

    expect(messageDraft.type).toBe("thread.message-sent");
    expect(messageDraft.payload).toMatchObject({
      threadId: "thread-1",
      messageId: "msg-1",
      role: "user",
      text: "fix the tests",
      dispatchMode: LOOP_TURN_DEFAULTS.dispatchMode,
      turnId: null,
      streaming: false,
      source: "native",
      purpose,
      createdAt: now,
      updatedAt: now,
    });

    expect(turnDraft.type).toBe("thread.turn-start-requested");
    expect(turnDraft.payload).toMatchObject({
      threadId: "thread-1",
      messageId: "msg-1",
      assistantDeliveryMode: LOOP_TURN_DEFAULTS.assistantDeliveryMode,
      dispatchMode: LOOP_TURN_DEFAULTS.dispatchMode,
      runtimeMode: "full-access",
      interactionMode: "default",
      purpose,
      createdAt: now,
    });
  });
});
