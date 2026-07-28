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

describe("gap backfill coordination (P1 regression)", () => {
  type Event = { sequence: number };

  // Mirrors the __root.tsx wiring: cursor, buffer, in-flight guard, and an
  // attempted-target record written only when shouldStartGapBackfill allows
  // the replay to actually start.
  const createHarness = () => {
    let cursor = 10;
    let buffered: Event[] = [];
    let attemptedTarget: number | undefined;
    let replayInFlight = false;
    const applied: number[] = [];
    const startedReplays: { target: number; resolve: (events: Event[]) => void }[] = [];

    const apply = (item: Event) => {
      cursor = item.sequence;
      applied.push(item.sequence);
    };

    const drain = () => {
      const { applicable, remaining } = drainContiguousSequenceEvents(cursor, buffered);
      buffered = [...remaining];
      for (const item of applicable) {
        apply(item);
      }
      const lastRemaining = remaining.at(-1);
      if (lastRemaining !== undefined) {
        requestBackfill(lastRemaining.sequence - 1);
      }
    };

    const requestBackfill = (targetSequence: number) => {
      if (
        !shouldStartGapBackfill({
          attemptedTargetSequence: attemptedTarget,
          targetSequence,
          replayInFlight,
        })
      ) {
        return;
      }
      attemptedTarget = targetSequence;
      replayInFlight = true;
      startedReplays.push({
        target: targetSequence,
        resolve: (events) => {
          for (const item of events) {
            if (item.sequence > cursor && item.sequence <= targetSequence) {
              apply(item);
            }
          }
          replayInFlight = false;
          drain();
        },
      });
    };

    const receive = (sequence: number) => {
      const progress = classifySequenceProgress(cursor, sequence);
      if (progress.kind === "duplicate") {
        return;
      }
      if (progress.kind === "gap") {
        buffered.push(event(sequence));
        requestBackfill(progress.backfillTargetSequence);
        return;
      }
      apply(event(sequence));
      drain();
    };

    return { receive, startedReplays, applied: () => applied };
  };

  it("replays a larger gap that arrived while the first replay was in flight", () => {
    const harness = createHarness();
    harness.receive(12);
    expect(harness.startedReplays.map((replay) => replay.target)).toEqual([11]);

    // Larger gap arrives before the first replay resolves: must not start a
    // second replay yet, and must not mark target 14 as attempted.
    harness.receive(15);
    expect(harness.startedReplays).toHaveLength(1);

    // First replay resolves with the missing 11; drain applies 11-12, then
    // re-requests the still-missing 13-14 range.
    harness.startedReplays[0]?.resolve([event(11)]);
    expect(harness.applied()).toEqual([11, 12]);
    expect(harness.startedReplays.map((replay) => replay.target)).toEqual([11, 14]);

    // Second replay resolves with 13-14; drain applies them plus buffered 15.
    harness.startedReplays[1]?.resolve([event(13), event(14)]);
    expect(harness.applied()).toEqual([11, 12, 13, 14, 15]);
  });
});
