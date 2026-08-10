// FILE: composerPlaceholder.test.ts
// Purpose: Covers the loop-aware composer placeholder derivation, especially
// the streaming-vs-idle split while a loop is active.
// Layer: Pure logic tests

import { describe, expect, it } from "vitest";
import { LOOP_OBJECTIVE_PLACEHOLDER, LOOP_SETUP_COMPOSER_PLACEHOLDER } from "~/lib/loop";
import {
  deriveLoopComposerPlaceholder,
  isLoopSteerSendSignal,
  LOOP_IDLE_COMPOSER_PLACEHOLDER,
  LOOP_STREAMING_COMPOSER_PLACEHOLDER,
  type DeriveLoopComposerPlaceholderInput,
} from "./composerPlaceholder";

function makeInput(
  overrides: Partial<DeriveLoopComposerPlaceholderInput> = {},
): DeriveLoopComposerPlaceholderInput {
  return {
    isApprovalState: false,
    pendingProgressQuestion: null,
    loopSetupOpen: false,
    showPlanFollowUp: false,
    loop: null,
    isLoopOwnedTurnRunning: false,
    isSubagentThread: false,
    hasLiveTurn: false,
    isDisconnected: false,
    ...overrides,
  };
}

describe("deriveLoopComposerPlaceholder", () => {
  it("uses the setup placeholder while the loop composer is open", () => {
    expect(deriveLoopComposerPlaceholder(makeInput({ loopSetupOpen: true }))).toBe(
      LOOP_SETUP_COMPOSER_PLACEHOLDER,
    );
  });

  it("keeps the armed placeholder while the objective is empty", () => {
    expect(deriveLoopComposerPlaceholder(makeInput({ loop: { active: true, prompt: "  " } }))).toBe(
      LOOP_OBJECTIVE_PLACEHOLDER,
    );
  });

  it("offers to queue a new objective while a loop-owned turn streams", () => {
    expect(
      deriveLoopComposerPlaceholder(
        makeInput({
          loop: { active: true, prompt: "keep fixing tests" },
          isLoopOwnedTurnRunning: true,
          hasLiveTurn: true,
        }),
      ),
    ).toBe(LOOP_STREAMING_COMPOSER_PLACEHOLDER);
  });

  it("offers to steer while the loop is idle between iterations", () => {
    expect(
      deriveLoopComposerPlaceholder(
        makeInput({ loop: { active: true, prompt: "keep fixing tests" } }),
      ),
    ).toBe(LOOP_IDLE_COMPOSER_PLACEHOLDER);
  });

  it("ignores non-loop live turns when picking the loop placeholder", () => {
    expect(
      deriveLoopComposerPlaceholder(
        makeInput({ loop: { active: true, prompt: "keep fixing tests" }, hasLiveTurn: true }),
      ),
    ).toBe(LOOP_IDLE_COMPOSER_PLACEHOLDER);
  });

  it("keeps the generic placeholders without an active loop", () => {
    expect(deriveLoopComposerPlaceholder(makeInput({ hasLiveTurn: true }))).toBe(
      "Ask for follow-up changes",
    );
    expect(deriveLoopComposerPlaceholder(makeInput())).toBe(
      "Ask anything, @tag files/folders, or use / to show available commands",
    );
  });
});

describe("isLoopSteerSendSignal", () => {
  it("signals steer for an active loop with a saved objective", () => {
    expect(
      isLoopSteerSendSignal({
        loop: { active: true, prompt: "keep fixing tests" },
        hasUnsupportedLoopContext: false,
      }),
    ).toBe(true);
  });

  it("stays a plain send when the draft carries unsupported loop context", () => {
    expect(
      isLoopSteerSendSignal({
        loop: { active: true, prompt: "keep fixing tests" },
        hasUnsupportedLoopContext: true,
      }),
    ).toBe(false);
  });

  it("stays a plain send without an active loop or saved objective", () => {
    expect(isLoopSteerSendSignal({ loop: null, hasUnsupportedLoopContext: false })).toBe(false);
    expect(
      isLoopSteerSendSignal({
        loop: { active: false, prompt: "keep fixing tests" },
        hasUnsupportedLoopContext: false,
      }),
    ).toBe(false);
    expect(
      isLoopSteerSendSignal({
        loop: { active: true, prompt: "  " },
        hasUnsupportedLoopContext: false,
      }),
    ).toBe(false);
  });
});
