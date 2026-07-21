import "../../index.css";

import { EventId, type OrchestrationThreadActivity, TurnId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { type ContextWindowSnapshot, deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

const AUTO_COMPACTION_HINT = "Automatically compacts its context when needed.";

function makeUsageSnapshot(compactsAutomatically: boolean): ContextWindowSnapshot {
  const activity: OrchestrationThreadActivity = {
    id: EventId.makeUnsafe("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "context-window.updated",
    payload: {
      usedTokens: 14_000,
      maxTokens: 258_000,
      compactsAutomatically,
    },
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
  const snapshot = deriveLatestContextWindowSnapshot([activity]);
  if (!snapshot) {
    throw new Error("Expected a context window snapshot");
  }
  return snapshot;
}

describe("ContextWindowMeter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the auto-compaction hint when the usage snapshot compacts automatically", async () => {
    const usage = makeUsageSnapshot(true);
    const screen = await render(<ContextWindowMeter usage={usage} />);

    try {
      await page.getByRole("button", { name: /Context window/ }).hover();
      await expect.element(page.getByText(AUTO_COMPACTION_HINT)).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("omits the auto-compaction hint when the usage snapshot does not compact automatically", async () => {
    const usage = makeUsageSnapshot(false);
    const screen = await render(<ContextWindowMeter usage={usage} />);

    try {
      await page.getByRole("button", { name: /Context window/ }).hover();
      await expect.element(page.getByText("Model window: 258k tokens")).toBeInTheDocument();
      await expect.element(page.getByText(AUTO_COMPACTION_HINT)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
