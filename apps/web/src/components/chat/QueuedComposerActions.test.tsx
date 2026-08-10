// FILE: QueuedComposerActions.test.tsx
// Purpose: Covers the queued-chip action labels, including the "Next
// objective" relabel while a loop is active (copy-only; behavior unchanged).
// Layer: Web chat component tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { QueuedComposerActions } from "./QueuedComposerActions";

function renderActions(loopActive: boolean): string {
  const queuedTurn = { id: "q-1", previewText: "next thing" } as QueuedComposerTurn;
  return renderToStaticMarkup(
    <QueuedComposerActions
      queuedTurn={queuedTurn}
      loopActive={loopActive}
      onSteer={() => {}}
      onRemove={() => {}}
      onEdit={() => {}}
    />,
  );
}

describe("QueuedComposerActions", () => {
  it("keeps the Steer label without an active loop", () => {
    const markup = renderActions(false);
    expect(markup).toContain("Steer");
    expect(markup).not.toContain("Next objective");
    expect(markup).toContain("Delete queued follow-up");
  });

  it("relabels the chip to Next objective while a loop is active", () => {
    const markup = renderActions(true);
    expect(markup).toContain("Next objective");
    expect(markup).toContain("Delete queued objective");
  });
});
