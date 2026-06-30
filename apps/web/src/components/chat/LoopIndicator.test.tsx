import type { OrchestrationLoop } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoopIndicator } from "./LoopIndicator";

function makeLoop(overrides?: Partial<OrchestrationLoop>): OrchestrationLoop {
  return {
    prompt: "Find and fix bugs",
    intervalSeconds: 300,
    status: "active",
    iterationsRun: 3,
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("LoopIndicator", () => {
  it("renders nothing without a loop", () => {
    expect(renderToStaticMarkup(<LoopIndicator loop={null} threadId="t1" isWorking={false} />)).toBe("");
    expect(renderToStaticMarkup(<LoopIndicator loop={undefined} threadId="t1" isWorking={false} />)).toBe("");
  });

  it("renders nothing for a cleared loop", () => {
    expect(renderToStaticMarkup(<LoopIndicator loop={makeLoop({ status: "cleared" })} threadId="t1" isWorking={false} />)).toBe("");
  });

  it("shows status, interval, and iteration count for an active loop", () => {
    const html = renderToStaticMarkup(<LoopIndicator loop={makeLoop()} threadId="t1" isWorking={false} />);
    expect(html).toContain("Loop: active");
    expect(html).toContain("every 5m");
    expect(html).toContain("3 runs");
    expect(html).toContain('title="Find and fix bugs"');
    expect(html).toContain('data-loop-status="active"');
  });

  it("formats hour-scale intervals", () => {
    const html = renderToStaticMarkup(<LoopIndicator loop={makeLoop({ intervalSeconds: 3600 })} threadId="t1" isWorking={false} />);
    expect(html).toContain("every 1.0h");
  });

  it("renders paused status", () => {
    const html = renderToStaticMarkup(<LoopIndicator loop={makeLoop({ status: "paused" })} threadId="t1" isWorking={false} />);
    expect(html).toContain("Loop: paused");
    expect(html).toContain('data-loop-status="paused"');
  });
});
