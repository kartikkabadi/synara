// FILE: queuedTurnAuthority.ts
// Purpose: Pure dispatch gate for loop-owned queued turns: the authoritative
//          ThreadLoop must still be active on the same activation, and the
//          turn must carry the activation's current dispatched iteration count.
// Layer: Orchestration decision logic

import type { ThreadLoop, ThreadTurnPurpose } from "@synara/contracts";

export type LoopTurnAuthority = "authorized" | "stale_activation" | "iteration_mismatch";

export function classifyLoopTurnAuthority(input: {
  readonly thread:
    | {
        readonly deletedAt: string | null;
        readonly archivedAt?: string | null | undefined;
        readonly loop?: ThreadLoop | null | undefined;
      }
    | undefined;
  readonly purpose: ThreadTurnPurpose;
}): LoopTurnAuthority {
  const thread = input.thread;
  const loop = thread?.loop ?? null;
  if (
    thread === undefined ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    loop?.active !== true ||
    input.purpose.activationId !== loop.activationId
  ) {
    return "stale_activation";
  }
  if (input.purpose.iteration !== loop.iteration) {
    // Same live activation but a different iteration count: the loop
    // projection likely lags the event that dispatched this turn. This is
    // transient, not a stale turn.
    return "iteration_mismatch";
  }
  return "authorized";
}
