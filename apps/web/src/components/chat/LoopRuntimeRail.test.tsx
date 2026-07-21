// FILE: LoopRuntimeRail.test.tsx
// Purpose: Covers the runtime rail's state-to-UI mapping, stop controls, progress
// segments, and accessibility attributes via static markup rendering.
// Layer: Web chat component tests

import type { OrchestrationLatestTurn, ThreadLoop } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isLoopRuntimeRailVisible,
  LoopRuntimeRail,
  type LoopRuntimeRailProps,
} from "./LoopRuntimeRail";

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return {
    active: true,
    prompt: "Keep fixing tests",
    iteration: 2,
    maxIterations: 5,
    endsAt: null,
    hardCap: 100,
    consecutiveErrors: 0,
    lastStopReason: null,
    activationId: "activation-1",
    createdAt: "2026-01-01T11:00:00.000Z",
    updatedAt: "2026-01-01T11:30:00.000Z",
    ...overrides,
  } as ThreadLoop;
}

function makeRunningLoopTurn(
  overrides: Partial<OrchestrationLatestTurn> = {},
): OrchestrationLatestTurn {
  return {
    turnId: "turn-1",
    state: "running",
    requestedAt: "2026-01-01T11:45:00.000Z",
    startedAt: "2026-01-01T11:45:01.000Z",
    completedAt: null,
    assistantMessageId: null,
    purpose: { kind: "loop-iteration", activationId: "activation-1", iteration: 2 },
    ...overrides,
  } as OrchestrationLatestTurn;
}

function renderRail(overrides: Partial<LoopRuntimeRailProps> = {}): string {
  return renderToStaticMarkup(
    <LoopRuntimeRail
      hasPendingApprovals={false}
      hasPendingUserInput={false}
      interactionMode="default"
      latestTurn={null}
      loop={makeLoop()}
      onEditLoop={() => {}}
      onStopAfterTurn={() => {}}
      onStopNow={() => {}}
      session={null}
      {...overrides}
    />,
  );
}

function countSegments(markup: string): number {
  return markup.split("h-1 flex-1 rounded-full").length - 1;
}

describe("isLoopRuntimeRailVisible", () => {
  it("is hidden without a loop", () => {
    expect(isLoopRuntimeRailVisible(null, null)).toBe(false);
    expect(isLoopRuntimeRailVisible(undefined, null)).toBe(false);
  });

  it("is visible while the loop is active", () => {
    expect(isLoopRuntimeRailVisible(makeLoop(), null)).toBe(true);
  });

  it("stays visible while a loop-owned turn outlives the toggle", () => {
    expect(
      isLoopRuntimeRailVisible(
        makeLoop({ active: false, lastStopReason: "toggled_off" }),
        makeRunningLoopTurn(),
      ),
    ).toBe(true);
  });

  it("is hidden once an inactive loop has no running turn", () => {
    expect(
      isLoopRuntimeRailVisible(makeLoop({ active: false, lastStopReason: "user_stop" }), null),
    ).toBe(false);
  });
});

describe("LoopRuntimeRail", () => {
  it("renders running state with counter, segments, and the stop menu", () => {
    const markup = renderRail({ latestTurn: makeRunningLoopTurn() });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loop running");
    expect(markup).toContain("2 / 5");
    expect(markup).toContain("Stop after turn");
    expect(countSegments(markup)).toBe(5);
  });

  it("exposes ARIA progress attributes on the progress container", () => {
    const markup = renderRail({ latestTurn: makeRunningLoopTurn() });
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="5"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuetext="2 of 5 loop turns started"');
    expect(markup).toContain("aria-hidden");
  });

  it("normalizes budgets over eight turns to five segments", () => {
    const markup = renderRail({
      loop: makeLoop({ iteration: 17, maxIterations: 50 }),
      latestTurn: makeRunningLoopTurn({
        purpose: { kind: "loop-iteration", activationId: "activation-1", iteration: 17 },
      }),
    });
    expect(markup).toContain("17 / 50");
    expect(countSegments(markup)).toBe(5);
  });

  it("respects reduced motion on the running icon", () => {
    const markup = renderRail({ latestTurn: makeRunningLoopTurn() });
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("renders ready state with a plain Stop loop button", () => {
    const markup = renderRail();
    expect(markup).toContain("Loop on");
    expect(markup).toContain("Starting the next turn…");
    expect(markup).toContain("Stop loop");
    expect(markup).not.toContain("Stop after turn");
  });

  it("renders armed state without progress", () => {
    const markup = renderRail({ loop: makeLoop({ prompt: "" }) });
    expect(markup).toContain("Loop ready");
    expect(markup).toContain("Add a prompt to start");
    expect(countSegments(markup)).toBe(0);
  });

  it("renders waiting-approval with counter and stop menu while the turn runs", () => {
    const markup = renderRail({ hasPendingApprovals: true, latestTurn: makeRunningLoopTurn() });
    expect(markup).toContain("Loop waiting");
    expect(markup).toContain("Approval required");
    expect(markup).toContain("2 / 5");
    expect(markup).toContain("Stop after turn");
  });

  it("renders waiting-input detail", () => {
    const markup = renderRail({ hasPendingUserInput: true });
    expect(markup).toContain("Loop waiting");
    expect(markup).toContain("Your input is required");
  });

  it("renders waiting-plan without a counter", () => {
    const markup = renderRail({ interactionMode: "plan" });
    expect(markup).toContain("Loop waiting");
    expect(markup).toContain("Plan mode is active");
    expect(markup).not.toContain("2 / 5");
  });

  it("renders ending state without stop controls", () => {
    const markup = renderRail({
      loop: makeLoop({ active: false, lastStopReason: "toggled_off" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(markup).toContain("Loop ending");
    expect(markup).toContain("Current turn will finish");
    expect(markup).not.toContain("Stop after turn");
    expect(markup).not.toContain("Stop loop");
  });

  it("renders stopping state without stop controls", () => {
    const markup = renderRail({
      loop: makeLoop({ active: false, lastStopReason: "user_stop" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(markup).toContain("Stopping loop");
    expect(markup).not.toContain("Stop after turn");
    expect(markup).not.toContain("Stop loop");
  });

  it("renders nothing once the loop has ended", () => {
    expect(renderRail({ loop: makeLoop({ active: false, lastStopReason: "user_stop" }) })).toBe("");
  });
});
