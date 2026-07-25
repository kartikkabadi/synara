// FILE: composerPlaceholder.ts
// Purpose: Composer placeholder priority ladder — approval → pending progress →
// loop setup → plan follow-up → active loop → subagent → live turn → disconnected.
// Layer: Web chat presentation helpers (pure; no JSX, no hooks)

import type { ThreadLoop } from "@synara/contracts";
import { LOOP_OBJECTIVE_PLACEHOLDER, LOOP_SETUP_COMPOSER_PLACEHOLDER } from "~/lib/loop";

// Composer placeholders while a loop with a saved objective is active (spec §9).
// Streaming iteration: Enter queues a chip that replaces the objective when
// the turn ends. Idle between iterations: Enter retargets immediately.
export const LOOP_STREAMING_COMPOSER_PLACEHOLDER = "Queue a new objective for the next iteration…";
export const LOOP_IDLE_COMPOSER_PLACEHOLDER =
  "Steer the loop — your message becomes the new objective";

// Send-slot `↳` signal: the send button only renders while no turn is running,
// so an active loop with a saved objective means Enter retargets — unless the
// draft carries unsupported context, in which case sending stops the loop and
// runs a normal message, so the button must stay a plain send.
export function isLoopSteerSendSignal(input: {
  loop: Pick<ThreadLoop, "active" | "prompt"> | null | undefined;
  hasUnsupportedLoopContext: boolean;
}): boolean {
  return (
    input.loop?.active === true &&
    input.loop.prompt.trim().length > 0 &&
    !input.hasUnsupportedLoopContext
  );
}

export interface DeriveLoopComposerPlaceholderInput {
  isApprovalState: boolean;
  // null when no pending-progress question owns the composer.
  pendingProgressQuestion: "free-form" | "with-options" | null;
  loopSetupOpen: boolean;
  showPlanFollowUp: boolean;
  loop: Pick<ThreadLoop, "active" | "prompt"> | null;
  // Loop-owned precision: a non-loop turn racing the loop must not flip the
  // placeholder to the streaming variant.
  isLoopOwnedTurnRunning: boolean;
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
    if (input.loop.prompt.trim().length === 0) return LOOP_OBJECTIVE_PLACEHOLDER;
    return input.isLoopOwnedTurnRunning
      ? LOOP_STREAMING_COMPOSER_PLACEHOLDER
      : LOOP_IDLE_COMPOSER_PLACEHOLDER;
  }
  if (input.isSubagentThread) return "Message this subagent while it works";
  if (input.hasLiveTurn) return "Ask for follow-up changes";
  if (input.isDisconnected) return "Ask for follow-up changes or attach images";
  return "Ask anything, @tag files/folders, or use / to show available commands";
}
