import { describe, expect, it } from "vitest";

import { classifySequenceProgress, drainContiguousSequenceEvents } from "./-eventSequenceGap";

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
