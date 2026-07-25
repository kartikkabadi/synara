// FILE: composerPlaceholder.ts
// Purpose: Composer placeholder priority ladder — approval → pending progress →
// loop setup → plan follow-up → active loop → subagent → live turn → disconnected.
// Layer: Web chat presentation helpers (pure; no JSX, no hooks)

import type { ThreadLoop } from "@synara/contracts";
import { LOOP_OBJECTIVE_PLACEHOLDER, LOOP_SETUP_COMPOSER_PLACEHOLDER } from "~/lib/loop";

// Composer placeholder while a loop with a saved objective is active (spec §9).
export const LOOP_ACTIVE_COMPOSER_PLACEHOLDER = "Steer the next iteration…";

export interface DeriveLoopComposerPlaceholderInput {
  isApprovalState: boolean;
  // null when no pending-progress question owns the composer.
  pendingProgressQuestion: "free-form" | "with-options" | null;
  loopSetupOpen: boolean;
  showPlanFollowUp: boolean;
  loop: Pick<ThreadLoop, "active" | "prompt"> | null;
  isSubagentThread: boolean;
  hasLiveTurn: boolean;
  isDisconnected: boolean;
}

export function deriveLoopComposerPlaceholder(input: DeriveLoopComposerPlaceholderInput): string {
  if (input.isApprovalState) return "Resolve this approval request to continue";
  if (input.pendingProgressQuestion !== null) {
    return input.pendingProgressQuestion === "free-form"
      ? "Type your answer to continue"
      : "Type your own answer, or leave this blank to use the selected option";
  }
  if (input.loopSetupOpen) return LOOP_SETUP_COMPOSER_PLACEHOLDER;
  if (input.showPlanFollowUp) {
    return "Add feedback to refine the plan, or leave this blank to implement it";
  }
  if (input.loop?.active) {
    return input.loop.prompt.trim().length === 0
      ? LOOP_OBJECTIVE_PLACEHOLDER
      : LOOP_ACTIVE_COMPOSER_PLACEHOLDER;
  }
  if (input.isSubagentThread) return "Message this subagent while it works";
  if (input.hasLiveTurn) return "Ask for follow-up changes";
  if (input.isDisconnected) return "Ask for follow-up changes or attach images";
  return "Ask anything, @tag files/folders, or use / to show available commands";
}
