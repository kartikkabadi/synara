// FILE: useLoopStopErrorToast.ts
// Purpose: One toast when a `/loop` auto-stops exceptionally (spec §14.2).
// Layer: Web chat composer controller
// Routine lifecycle stops (budget, user stop, toggle) stay toast-free; the
// runtime rail and transcript record communicate those.

import type { ThreadId, ThreadLoop } from "@synara/contracts";
import { useEffect, useRef } from "react";
import { formatLoopStopReasonShort } from "./presentation";

interface LoopStopSnapshot {
  activationId: string;
  active: boolean;
}

// ChatView (and this hook) can be mounted several times for the same thread
// (single surface, editor chat pane, dock sidechats, split panes), and loop
// state can flap active->inactive more than once for one activation. Toast at
// most once per unique (thread, activation, reason) stop across all mounts.
const toastedLoopStops = new Set<string>();

export function resetLoopStopToastDedupeForTest(): void {
  toastedLoopStops.clear();
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
  addToast: (toast: {
    title: string;
    description: string;
    tone: "error" | "warning";
    threadId: ThreadId | null;
  }) => void,
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
    if (loop == null || !shouldToastLoopStop(previous, loop)) return;
    const reason = loop.lastStopReason;
    if (reason == null) return;
    const copy = formatLoopStopReasonShort(reason);
    if (copy === null) return;
    const dedupeKey = `${threadId ?? "no-thread"}:${loop.activationId}:${reason}`;
    if (toastedLoopStops.has(dedupeKey)) return;
    toastedLoopStops.add(dedupeKey);
    addToast({ ...copy, threadId });
  }, [threadId, loop, addToast]);
}
