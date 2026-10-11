import { MessageId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { makeImage, makeQueuedChatTurn } from "../composerDraftStoreTestFixtures";
import {
  clearFailedComposerRetry,
  isCurrentFailedComposerRetry,
  retainFailedComposerRetry,
  useFailedComposerRetries,
  type FailedComposerRetry,
} from "./failedComposerRetry";

function makeRetry(id = "thread-1"): FailedComposerRetry {
  const turn = makeQueuedChatTurn("failed", makeImage({ id: "image", previewUrl: "blob:revoked" }));
  if (turn.kind !== "chat") throw new Error("Expected a chat fixture");
  return {
    threadId: ThreadId.makeUnsafe(id),
    messageId: MessageId.makeUnsafe("failed-message"),
    error: "Connection timed out",
    turn,
  };
}

afterEach(() => useFailedComposerRetries.setState(new Map(), true));

describe("failed composer retry ownership", () => {
  it("consumes an accepted retry without clearing a newer message on the same thread", () => {
    const retry = makeRetry();
    retainFailedComposerRetry(retry);
    clearFailedComposerRetry(retry.threadId, MessageId.makeUnsafe("older-message"));
    expect(useFailedComposerRetries.getState().get(retry.threadId)).toBe(retry);
    clearFailedComposerRetry(retry.threadId, retry.messageId);
    expect(useFailedComposerRetries.getState().has(retry.threadId)).toBe(false);
  });

  it("rejects dismissed, replaced, acknowledged, and other-thread actions", () => {
    const retry = makeRetry();
    const current = { threadId: retry.threadId, error: retry.error, acknowledged: false };
    retainFailedComposerRetry(retry);
    expect(isCurrentFailedComposerRetry(retry, current)).toBe(true);
    expect(isCurrentFailedComposerRetry(retry, { ...current, acknowledged: true })).toBe(false);
    expect(isCurrentFailedComposerRetry(retry, { ...current, error: "New error" })).toBe(false);
    expect(
      isCurrentFailedComposerRetry(retry, { ...current, threadId: ThreadId.makeUnsafe("other") }),
    ).toBe(false);
    clearFailedComposerRetry(retry.threadId);
    expect(isCurrentFailedComposerRetry(retry, current)).toBe(false);
    retainFailedComposerRetry({ ...retry });
    expect(isCurrentFailedComposerRetry(retry, current)).toBe(false);
  });

  it("retains file bytes after an optimistic preview is revoked and bounds old targets", async () => {
    const retry = makeRetry();
    retainFailedComposerRetry(retry);
    expect(await retry.turn.images[0]!.file.arrayBuffer()).toEqual(
      new Uint8Array([1, 1, 1, 1]).buffer,
    );
    for (let index = 0; index < 16; index += 1)
      retainFailedComposerRetry(makeRetry(`other-${index}`));
    expect(useFailedComposerRetries.getState().size).toBe(16);
    expect(useFailedComposerRetries.getState().has(retry.threadId)).toBe(false);
  });
});
