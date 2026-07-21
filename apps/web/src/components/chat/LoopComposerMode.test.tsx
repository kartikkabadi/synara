// FILE: LoopComposerMode.test.tsx
// Purpose: Guards loop setup header messaging and budget picker selection state.
// Layer: Component rendering tests
// Depends on: LoopComposerMode components and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoopBudgetPicker, LoopComposerModeHeader, loopBudgetRadioValue } from "./LoopComposerMode";
import {
  LOOP_BUDGET_COUNT_ERROR,
  LOOP_BUDGET_DURATION_MAX_ERROR,
  LOOP_BUDGET_DURATION_MIN_ERROR,
  LOOP_CHOOSE_BUDGET_NOTE,
  LOOP_UNSUPPORTED_CONTEXT_MESSAGE,
} from "./useLoopComposerMode";

describe("LoopComposerModeHeader", () => {
  const baseProps = {
    mode: {
      kind: "create",
      budget: { kind: "count", turns: 5 },
      sourceDraft: "",
    } as const,
    isDispatching: false,
    isLoopTurnRunning: false,
    isUnsupportedContext: false,
    onBudgetChange: () => {},
  };

  it("renders the note as quiet muted text without an alert role", () => {
    const markup = renderToStaticMarkup(
      <LoopComposerModeHeader {...baseProps} note={LOOP_CHOOSE_BUDGET_NOTE} error={null} />,
    );
    expect(markup).toContain(LOOP_CHOOSE_BUDGET_NOTE);
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain('role="alert"');
  });

  it("renders the error as a destructive alert", () => {
    const markup = renderToStaticMarkup(
      <LoopComposerModeHeader {...baseProps} note={null} error={LOOP_BUDGET_COUNT_ERROR} />,
    );
    expect(markup).toContain(LOOP_BUDGET_COUNT_ERROR);
    expect(markup).toContain("text-destructive");
    expect(markup).toContain('role="alert"');
  });

  it("prioritizes the unsupported-context message over note and error", () => {
    const markup = renderToStaticMarkup(
      <LoopComposerModeHeader
        {...baseProps}
        isUnsupportedContext
        note={LOOP_CHOOSE_BUDGET_NOTE}
        error={LOOP_BUDGET_COUNT_ERROR}
      />,
    );
    expect(markup).toContain(LOOP_UNSUPPORTED_CONTEXT_MESSAGE);
    expect(markup).not.toContain(LOOP_BUDGET_COUNT_ERROR);
  });
});

describe("loopBudgetRadioValue", () => {
  const noCustom = { kind: "none" } as const;

  it("marks preset counts and durations as selected", () => {
    expect(loopBudgetRadioValue({ kind: "count", turns: 25 }, noCustom)).toBe("count-25");
    expect(loopBudgetRadioValue({ kind: "duration", seconds: 1800 }, noCustom)).toBe(
      "duration-1800",
    );
    expect(loopBudgetRadioValue({ kind: "until-stopped" }, noCustom)).toBe("until-stopped");
  });

  it("marks non-preset values as the matching custom entry", () => {
    expect(loopBudgetRadioValue({ kind: "count", turns: 7 }, noCustom)).toBe("custom-count");
    expect(loopBudgetRadioValue({ kind: "duration", seconds: 2700 }, noCustom)).toBe(
      "custom-duration",
    );
  });

  it("keeps the open custom entry selected while typing", () => {
    expect(loopBudgetRadioValue({ kind: "count", turns: 5 }, { kind: "count", raw: "" })).toBe(
      "custom-count",
    );
    expect(
      loopBudgetRadioValue(
        { kind: "count", turns: 5 },
        { kind: "duration", raw: "", unit: "minutes" },
      ),
    ).toBe("custom-duration");
  });
});

describe("LoopBudgetPicker", () => {
  // Budget validation renders through the header error prop, not the picker.
  it("shows no validation message for a valid budget", () => {
    const markup = renderToStaticMarkup(
      <LoopBudgetPicker
        budget={{ kind: "count", turns: 5 }}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(markup).not.toContain(LOOP_BUDGET_COUNT_ERROR);
    expect(markup).not.toContain(LOOP_BUDGET_DURATION_MIN_ERROR);
    expect(markup).not.toContain(LOOP_BUDGET_DURATION_MAX_ERROR);
    expect(markup).toContain("Stop after 5 turns");
  });
});
