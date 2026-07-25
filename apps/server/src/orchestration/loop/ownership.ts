// FILE: ownership.ts
// Purpose: Determine whether a turn is owned by a `/loop` activation.
// Layer: Orchestration shared utility

import type { OrchestrationThread, TurnId } from "@synara/contracts";

/**
 * Returns true if `turnId` corresponds to a loop-owned turn on the thread.
 * Does not require the turn to belong to the *current* loop activation, so it
 * still matches a stale activation that is still running after a reconfigure.
 */
export function isLoopOwnedTurn(thread: OrchestrationThread, turnId: TurnId): boolean {
  return (
    thread.latestTurn?.turnId === turnId && thread.latestTurn.purpose?.kind === "loop-iteration"
  );
}
