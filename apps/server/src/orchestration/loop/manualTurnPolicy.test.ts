import type { OrchestrationThread, ThreadId, ThreadLoop } from "@synara/contracts";
import {
  LOOP_FIXTURE_ACTIVATION_ID,
  makeLoop as makeLoopFixture,
} from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { resolveTurnStartLoopPolicy } from "./manualTurnPolicy.ts";

const now = "2026-07-19T12:00:00.000Z";

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return makeLoopFixture({
    prompt: "fix the tests",
    iteration: 2,
    maxIterations: null,
    endsAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function makeThread(options: {
  loop?: ThreadLoop | null;
  pendingTurnStart?: unknown;
}): OrchestrationThread {
  return {
    id: "thread-1" as unknown as ThreadId,
    loop: options.loop ?? null,
    pendingTurnStart: options.pendingTurnStart ?? null,
  } as unknown as OrchestrationThread;
}

const plainMessage = {
  text: "keep going",
  hasAttachments: false,
  hasStructuredReferences: false,
};

describe("resolveTurnStartLoopPolicy", () => {
  it("does nothing without an active loop", () => {
    const result = resolveTurnStartLoopPolicy({
      thread: makeThread({ loop: makeLoop({ active: false }) }),
      message: plainMessage,
      createdAt: now,
    });
    expect(result).toEqual({ purpose: undefined, loopEvents: [], dispatchModeOverride: null });
  });

  it("claims the turn as the next loop iteration and forces queue dispatch", () => {
    const result = resolveTurnStartLoopPolicy({
      thread: makeThread({ loop: makeLoop() }),
      message: plainMessage,
      createdAt: now,
    });
    expect(result.purpose).toEqual({
      kind: "loop-iteration",
      activationId: LOOP_FIXTURE_ACTIVATION_ID,
      iteration: 3,
    });
    expect(result.dispatchModeOverride).toBe("queue");
    expect(result.loopEvents).toMatchObject([
      {
        type: "thread.loop-continued",
        payload: { nextIteration: 3, loop: { prompt: "keep going" } },
      },
    ]);
  });

  it("retires the loop when the message carries attachments", () => {
    const result = resolveTurnStartLoopPolicy({
      thread: makeThread({ loop: makeLoop() }),
      message: { ...plainMessage, hasAttachments: true },
      createdAt: now,
    });
    expect(result.purpose).toBeUndefined();
    expect(result.dispatchModeOverride).toBeNull();
    expect(result.loopEvents).toMatchObject([
      {
        type: "thread.loop-off",
        payload: { stopReason: "attachments_not_supported", loop: { active: false } },
      },
    ]);
  });

  it("retires an expired loop instead of continuing it", () => {
    const result = resolveTurnStartLoopPolicy({
      thread: makeThread({ loop: makeLoop({ endsAt: "2026-07-19T11:00:00.000Z" }) }),
      message: plainMessage,
      createdAt: now,
    });
    expect(result.loopEvents).toMatchObject([
      { type: "thread.loop-off", payload: { stopReason: "budget_duration" } },
    ]);
  });

  it("retires the loop when a loop-owned turn start is already pending", () => {
    const result = resolveTurnStartLoopPolicy({
      thread: makeThread({
        loop: makeLoop(),
        pendingTurnStart: {
          purpose: {
            kind: "loop-iteration",
            activationId: LOOP_FIXTURE_ACTIVATION_ID,
            iteration: 3,
          },
        },
      }),
      message: plainMessage,
      createdAt: now,
    });
    expect(result.loopEvents).toMatchObject([
      { type: "thread.loop-off", payload: { stopReason: "replaced_by_manual_policy" } },
    ]);
  });
});
