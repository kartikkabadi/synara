import { describe, expect, it } from "vitest";

import {
  classifySequenceProgress,
  drainContiguousSequenceEvents,
  shouldStartGapBackfill,
} from "./-eventSequenceGap";

const event = (sequence: number) => ({ sequence });

describe("classifySequenceProgress", () => {
  it("applies the next contiguous sequence", () => {
    expect(classifySequenceProgress(10, 11)).toEqual({ kind: "apply" });
  });

  it("drops an already-present sequence", () => {
    expect(classifySequenceProgress(10, 10)).toEqual({ kind: "duplicate" });
  });

  it("drops a stale out-of-order sequence", () => {
    expect(classifySequenceProgress(10, 7)).toEqual({ kind: "duplicate" });
  });

  it("reports a single-sequence gap with the backfill target", () => {
    expect(classifySequenceProgress(10, 12)).toEqual({
      kind: "gap",
      backfillTargetSequence: 11,
    });
  });

  it("reports a multi-sequence gap with the backfill target", () => {
    expect(classifySequenceProgress(10, 15)).toEqual({
      kind: "gap",
      backfillTargetSequence: 14,
    });
  });
});

describe("drainContiguousSequenceEvents", () => {
  it("applies a buffered event that fills the gap", () => {
    // 12 was buffered on a gap; the missing 11 arrived and advanced the cursor.
    const { applicable, remaining } = drainContiguousSequenceEvents(11, [event(12)]);
    expect(applicable).toEqual([event(12)]);
    expect(remaining).toEqual([]);
  });

  it("applies a contiguous run in order even when buffered out of order", () => {
    const { applicable, remaining } = drainContiguousSequenceEvents(10, [
      event(13),
      event(11),
      event(12),
    ]);
    expect(applicable).toEqual([event(11), event(12), event(13)]);
    expect(remaining).toEqual([]);
  });

  it("keeps events beyond a remaining gap buffered", () => {
    const { applicable, remaining } = drainContiguousSequenceEvents(10, [
      event(11),
      event(14),
      event(15),
    ]);
    expect(applicable).toEqual([event(11)]);
    expect(remaining).toEqual([event(14), event(15)]);
  });

  it("drops buffered duplicates at or below the cursor", () => {
    const { applicable, remaining } = drainContiguousSequenceEvents(12, [
      event(9),
      event(12),
      event(13),
    ]);
    expect(applicable).toEqual([event(13)]);
    expect(remaining).toEqual([]);
  });

  it("drops a repeated buffered sequence after applying it once", () => {
    const { applicable, remaining } = drainContiguousSequenceEvents(10, [event(11), event(11)]);
    expect(applicable).toEqual([event(11)]);
    expect(remaining).toEqual([]);
  });

  it("returns everything as remaining when the gap has not filled", () => {
    const { applicable, remaining } = drainContiguousSequenceEvents(10, [event(12), event(13)]);
    expect(applicable).toEqual([]);
    expect(remaining).toEqual([event(12), event(13)]);
  });
});

describe("shouldStartGapBackfill", () => {
  it("starts a first backfill when no replay is in flight", () => {
    expect(
      shouldStartGapBackfill({
        attemptedTargetSequence: undefined,
        targetSequence: 11,
        replayInFlight: false,
      }),
    ).toBe(true);
  });

  it("does not repeat an already-attempted target", () => {
    expect(
      shouldStartGapBackfill({
        attemptedTargetSequence: 11,
        targetSequence: 11,
        replayInFlight: false,
      }),
    ).toBe(false);
  });

  it("defers (without recording) while a replay is in flight", () => {
    expect(
      shouldStartGapBackfill({
        attemptedTargetSequence: 11,
        targetSequence: 14,
        replayInFlight: true,
      }),
    ).toBe(false);
  });

  it("starts a deferred larger target once the in-flight replay completes", () => {
    // Regression: cursor 10 sees 12 (replay to 11 starts), then 15 arrives
    // mid-replay. The 14 target must not be recorded as attempted while
    // deferred, so the completion drain can still start it.
    expect(
      shouldStartGapBackfill({
        attemptedTargetSequence: 11,
        targetSequence: 14,
        replayInFlight: false,
      }),
    ).toBe(true);
  });
});

describe("filtered global sequences", () => {
  it("holds a sparse event until replay checks the skipped journal range", () => {
    expect(drainContiguousSequenceEvents(10, [event(15)])).toEqual({
      applicable: [],
      remaining: [event(15)],
    });
    expect(drainContiguousSequenceEvents(10, [event(15)], 14)).toEqual({
      applicable: [event(15)],
      remaining: [],
    });
  });

  it("does not release a later range that arrived after the replay started", () => {
    expect(drainContiguousSequenceEvents(10, [event(18), event(12), event(18)], 11)).toEqual({
      applicable: [event(12)],
      remaining: [event(18)],
    });
  });
});
