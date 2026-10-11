import type { MessageId, ThreadId } from "@synara/contracts";
import { create } from "zustand";

import type { QueuedComposerChatTurn } from "../composerDraftDomain";

export interface FailedComposerRetry {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly error: string;
  readonly turn: QueuedComposerChatTurn;
}

// Session-only recovery for a rejected send whose original draft could not be
// restored. Retain Files, not staged upload tokens or owned preview URLs.
const MAX_FAILED_COMPOSER_RETRIES = 16;
export const useFailedComposerRetries = create<ReadonlyMap<ThreadId, FailedComposerRetry>>(
  () => new Map(),
);

export function retainFailedComposerRetry(retry: FailedComposerRetry): void {
  const next = new Map(useFailedComposerRetries.getState());
  next.delete(retry.threadId);
  next.set(retry.threadId, retry);
  while (next.size > MAX_FAILED_COMPOSER_RETRIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  useFailedComposerRetries.setState(next, true);
}

export function clearFailedComposerRetry(threadId: ThreadId, expectedMessageId?: MessageId): void {
  const current = useFailedComposerRetries.getState();
  const retry = current.get(threadId);
  if (!retry || (expectedMessageId !== undefined && retry.messageId !== expectedMessageId)) return;
  const next = new Map(current);
  next.delete(threadId);
  useFailedComposerRetries.setState(next, true);
}

export function isCurrentFailedComposerRetry(
  retry: FailedComposerRetry,
  input: {
    threadId: ThreadId | null;
    error: string | null | undefined;
    acknowledged: boolean;
  },
): boolean {
  return (
    input.threadId === retry.threadId &&
    input.error === retry.error &&
    !input.acknowledged &&
    useFailedComposerRetries.getState().get(retry.threadId) === retry
  );
}
