// FILE: loopTestFixtures.ts
// Purpose: Shared `/loop` test fixtures used by server and web loop test suites.
// Layer: Test support (not for production code paths)

import { LoopActivationId, type OrchestrationLatestTurn, type ThreadLoop } from "@synara/contracts";

export const LOOP_FIXTURE_ACTIVATION_ID = LoopActivationId.makeUnsafe("activation-1");

export function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return {
    active: true,
    prompt: "Keep fixing tests",
    iteration: 2,
    maxIterations: 5,
    endsAt: null,
    durationSeconds: null,
    hardCap: 100,
    consecutiveErrors: 0,
    lastSettledIteration: 0,
    unsettled: [],
    lastStopReason: null,
    activationId: LOOP_FIXTURE_ACTIVATION_ID,
    createdAt: "2026-01-01T11:00:00.000Z",
    updatedAt: "2026-01-01T11:30:00.000Z",
    ...overrides,
  } as ThreadLoop;
}

export function makeRunningLoopTurn(
  overrides: Partial<OrchestrationLatestTurn> = {},
): OrchestrationLatestTurn {
  return {
    turnId: "turn-1",
    state: "running",
    requestedAt: "2026-01-01T11:45:00.000Z",
    startedAt: "2026-01-01T11:45:01.000Z",
    completedAt: null,
    assistantMessageId: null,
    purpose: { kind: "loop-iteration", activationId: LOOP_FIXTURE_ACTIVATION_ID, iteration: 2 },
    ...overrides,
  } as OrchestrationLatestTurn;
}
