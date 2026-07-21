// FILE: useLoopStopErrorToast.ts
// Purpose: One error toast when a `/loop` auto-stops exceptionally (spec §14.2).
// Layer: Web chat composer controller
// Routine lifecycle stops (budget, user stop, toggle) stay toast-free; the
// runtime rail and transcript record communicate those.

import type { LoopStopReason, ThreadId, ThreadLoop } from "@synara/contracts";
import { useEffect, useRef } from "react";

export interface LoopStopErrorToastCopy {
  title: string;
  description: string;
}

export function getLoopStopErrorToastCopy(reason: LoopStopReason): LoopStopErrorToastCopy | null {
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
        description: "This thread is no longer available.",
      };
    default:
      return null;
  }
}

interface LoopStopSnapshot {
  activationId: string;
  active: boolean;
}

// Only in-session transitions from an observed active loop toast; a loop that
// is already stopped on mount (page refresh) stays quiet — the transcript
// record covers it.
export function shouldToastLoopStop(
  previous: LoopStopSnapshot | null,
  loop: ThreadLoop | null,
): boolean {
  if (loop == null || loop.active || loop.lastStopReason == null) return false;
  if (previous == null) return false;
  return previous.active && previous.activationId === loop.activationId;
}

export function useLoopStopErrorToast(
  threadId: ThreadId | null,
  loop: ThreadLoop | null,
  addToast: (toast: { title: string; description: string; threadId: ThreadId | null }) => void,
): void {
  const previousRef = useRef<{ threadId: ThreadId | null; snapshot: LoopStopSnapshot | null }>({
    threadId: null,
    snapshot: null,
  });

  useEffect(() => {
    const previous =
      previousRef.current.threadId === threadId ? previousRef.current.snapshot : null;
    previousRef.current = {
      threadId,
      snapshot: loop == null ? null : { activationId: loop.activationId, active: loop.active },
    };
    if (!shouldToastLoopStop(previous, loop)) return;
    const copy = loop?.lastStopReason ? getLoopStopErrorToastCopy(loop.lastStopReason) : null;
    if (copy === null) return;
    addToast({ ...copy, threadId });
  }, [threadId, loop, addToast]);
}
