import type { MessageId, ThreadId, ThreadTurnPurpose } from "@synara/contracts";
import { LoopActivationId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildLoopIterationTurnDrafts,
  buildPendingLoopStartCancellationDrafts,
  LOOP_TURN_DEFAULTS,
} from "./turnEvents.ts";

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

describe("buildPendingLoopStartCancellationDrafts", () => {
  const thread = {
    id: "thread-1" as unknown as ThreadId,
    pendingTurnStart: {
      messageId: "msg-pending" as unknown as MessageId,
      requestedAt: now,
      purpose,
    },
  };

  it("emits a cancellation for a matching loop-owned pending start", () => {
    const drafts = buildPendingLoopStartCancellationDrafts({
      thread,
      activationId: purpose.activationId,
      createdAt: now,
    });
    expect(drafts).toEqual([
      {
        type: "thread.turn-start-cancelled",
        payload: {
          threadId: "thread-1",
          messageId: "msg-pending",
          purpose,
          createdAt: now,
        },
      },
    ]);
  });

  it("emits nothing when the pending start belongs to another activation", () => {
    expect(
      buildPendingLoopStartCancellationDrafts({
        thread,
        activationId: LoopActivationId.makeUnsafe("other-activation"),
        createdAt: now,
      }),
    ).toEqual([]);
  });

  it("emits nothing for a manual pending start or no pending start", () => {
    expect(
      buildPendingLoopStartCancellationDrafts({
        thread: {
          id: "thread-1" as unknown as ThreadId,
          pendingTurnStart: {
            messageId: "msg-manual" as unknown as MessageId,
            requestedAt: now,
          },
        },
        activationId: purpose.activationId,
        createdAt: now,
      }),
    ).toEqual([]);
    expect(
      buildPendingLoopStartCancellationDrafts({
        thread: { id: "thread-1" as unknown as ThreadId, pendingTurnStart: null },
        activationId: purpose.activationId,
        createdAt: now,
      }),
    ).toEqual([]);
  });
});
