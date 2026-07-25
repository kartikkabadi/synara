// FILE: LoopRuntimeRail.test.tsx
// Purpose: Covers the runtime rail's visibility, progress segments, ARIA wiring,
// and stop-control gating via static markup rendering. Per-state copy is owned
// by loopPresentation.test.ts.
// Layer: Web chat component tests

import { LoopActivationId } from "@synara/contracts";
import { makeLoop, makeRunningLoopTurn } from "@synara/shared/loopTestFixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isLoopRuntimeRailVisible,
  LoopRuntimeRail,
  type LoopRuntimeRailProps,
} from "./LoopRuntimeRail";

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
      {...overrides}
    />,
  );
}

function countSegments(markup: string): number {
  return markup.split('data-testid="loop-progress-segment"').length - 1;
}

// Extracts the markup of the `role="status"` live region (balanced spans) so
// tests can assert what screen readers are re-announced on.
function statusRegion(markup: string): string {
  const start = markup.indexOf('role="status"');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = markup.lastIndexOf("<span", start);
  let depth = 0;
  let index = open;
  while (index < markup.length) {
    const nextOpen = markup.indexOf("<span", index);
    const nextClose = markup.indexOf("</span>", index);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      index = nextOpen + 5;
    } else {
      depth -= 1;
      if (depth === 0) return markup.slice(open, nextClose + 7);
      index = nextClose + 7;
    }
  }
  throw new Error("unbalanced status region");
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
    expect(markup).toContain("2/5");
    expect(markup).toContain("Stop after turn");
    expect(countSegments(markup)).toBe(5);
  });

  it("exposes ARIA progress attributes on the progress container", () => {
    const markup = renderRail({ latestTurn: makeRunningLoopTurn() });
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Loop progress"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="5"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuetext="Turn 2 of 5"');
    expect(markup).toContain("aria-hidden");
  });

  it("scopes the live region to the status copy only", () => {
    const markup = renderRail({ latestTurn: makeRunningLoopTurn() });
    const region = statusRegion(markup);
    expect(region).toContain("Loop running");
    expect(region).not.toContain('role="progressbar"');
    expect(region).not.toContain("2/5");
    expect(region).not.toContain("Stop");
  });

  it("labels the no-budget progressbar without a determinate value", () => {
    const markup = renderRail({
      loop: makeLoop({ maxIterations: null, endsAt: null }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Loop progress"');
    expect(markup).toContain('aria-valuetext="Loop has run 2 turns; no explicit user budget"');
    expect(markup).not.toContain("aria-valuenow");
  });

  it("caps budgets over twelve turns at twelve proportional segments", () => {
    const markup = renderRail({
      loop: makeLoop({ iteration: 17, maxIterations: 50 }),
      latestTurn: makeRunningLoopTurn({
        purpose: {
          kind: "loop-iteration",
          activationId: LoopActivationId.makeUnsafe("activation-1"),
          iteration: 17,
        },
      }),
    });
    expect(countSegments(markup)).toBe(12);
  });

  it("renders fractional progress as a partial-width segment fill", () => {
    // 3/24 across twelve segments = 1.5: one full segment, one half-filled.
    const markup = renderRail({
      loop: makeLoop({ iteration: 3, maxIterations: 24 }),
      latestTurn: makeRunningLoopTurn({
        purpose: {
          kind: "loop-iteration",
          activationId: LoopActivationId.makeUnsafe("activation-1"),
          iteration: 3,
        },
      }),
    });
    expect(countSegments(markup)).toBe(12);
    expect(markup).toContain("width:100%");
    expect(markup).toContain("width:50%");
    expect(markup).toContain("width:0%");
  });

  it("only spins the icon while running, not while starting", () => {
    const running = renderRail({ latestTurn: makeRunningLoopTurn() });
    expect(running).toContain('data-spinning="true"');
    const starting = renderRail({ loop: makeLoop({ iteration: 0 }) });
    expect(starting).toContain('data-testid="loop-rail-icon"');
    expect(starting).not.toContain("data-spinning");
  });

  it("renders ready state with the stop menu so Edit loop stays reachable", () => {
    const markup = renderRail();
    expect(markup).toContain("Stop loop");
    expect(markup).toContain('data-slot="menu-trigger"');
    expect(markup).not.toContain("Stop after turn");
  });

  it("splits the stop control: primary safe-default button + chevron menu", () => {
    const markup = renderRail({ latestTurn: makeRunningLoopTurn() });
    // The primary segment is a plain button (one-click safe default), not the
    // menu trigger; the chevron owns the menu.
    expect(markup).toContain("Stop after turn</button>");
    expect(markup).toContain('aria-label="More loop actions"');
    const ready = renderRail();
    expect(ready).toContain("Stop loop</button>");
    expect(ready).toContain('aria-label="More loop actions"');
  });

  it("renders armed state without progress and with the stop menu", () => {
    const markup = renderRail({ loop: makeLoop({ prompt: "" }) });
    expect(markup).toContain('data-slot="menu-trigger"');
    expect(countSegments(markup)).toBe(0);
  });

  it("labels the stop trigger by whether a loop-owned turn is running", () => {
    expect(renderRail()).toContain("Stop loop");
    expect(renderRail({ latestTurn: makeRunningLoopTurn() })).toContain("Stop after turn");
  });

  it("only shows the steering tooltip while running or ready", () => {
    expect(renderRail({ latestTurn: makeRunningLoopTurn() })).toContain('tabindex="0"');
    expect(renderRail()).toContain('tabindex="0"');
    const waiting = renderRail({ hasPendingUserInput: true });
    expect(waiting).not.toContain('data-slot="tooltip-trigger"');
  });

  it("pulses only the current filled segment while running", () => {
    const running = renderRail({ latestTurn: makeRunningLoopTurn() });
    expect(running.split("animate-[pulse_2s_ease-in-out_infinite]").length - 1).toBe(1);
    const ready = renderRail();
    expect(ready).not.toContain("animate-[pulse_2s_ease-in-out_infinite]");
  });

  it("renders waiting-approval with counter and stop menu while the turn runs", () => {
    const markup = renderRail({ hasPendingApprovals: true, latestTurn: makeRunningLoopTurn() });
    expect(markup).toContain("2/5");
    expect(markup).toContain("Stop after turn");
  });

  it("renders waiting-plan without a counter", () => {
    const markup = renderRail({ interactionMode: "plan" });
    expect(markup).not.toContain("2/5");
    expect(countSegments(markup)).toBe(0);
  });

  it("renders ending state with counter, progress, and a Stop now button", () => {
    const markup = renderRail({
      loop: makeLoop({ active: false, lastStopReason: "toggled_off" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(markup).toContain("2/5");
    expect(countSegments(markup)).toBe(5);
    expect(markup).not.toContain("Stop after turn");
    expect(markup).toContain("Stop now");
  });

  it("renders stopping state with counter and progress but no stop controls", () => {
    const markup = renderRail({
      loop: makeLoop({ active: false, lastStopReason: "user_stop" }),
      latestTurn: makeRunningLoopTurn(),
    });
    expect(markup).toContain("2/5");
    expect(countSegments(markup)).toBe(5);
    expect(markup).not.toContain("Stop after turn");
    expect(markup).not.toContain("Stop loop");
    expect(markup).not.toContain("Stop now");
  });
});
