/**
 * Pure sequencing helpers for the orchestration event streams.
 *
 * Both the thread event stream and the shell event stream deliver events with
 * a monotonically increasing `sequence`. A dropped or out-of-order event must
 * not silently advance the cursor past a gap, or the client desyncs until a
 * manual refresh. These helpers classify each incoming event against the
 * current cursor and drain buffered out-of-order events once the gap fills.
 */

export type SequencedEvent = { readonly sequence: number };

export type SequenceProgress =
  /** Duplicate or stale event: the cursor already covers it. */
  | { readonly kind: "duplicate" }
  /** Contiguous event: apply it and advance the cursor. */
  | { readonly kind: "apply" }
  /** Gap: buffer the event and backfill up to `backfillTargetSequence`. */
  | { readonly kind: "gap"; readonly backfillTargetSequence: number };

export function classifySequenceProgress(
  latestSequence: number,
  incomingSequence: number,
): SequenceProgress {
  if (incomingSequence <= latestSequence) {
    return { kind: "duplicate" };
  }
  if (incomingSequence === latestSequence + 1) {
    return { kind: "apply" };
  }
  return { kind: "gap", backfillTargetSequence: incomingSequence - 1 };
}

/**
 * Decides whether a gap backfill replay to `targetSequence` should start now.
 * The caller records `targetSequence` as attempted only when this returns
 * true. While a replay is in flight the decision is deferred WITHOUT
 * recording: the replay's completion drain re-requests any still-missing
 * range, and recording early would permanently suppress that retry.
 */
export function shouldStartGapBackfill(options: {
  readonly attemptedTargetSequence: number | undefined;
  readonly targetSequence: number;
  readonly replayInFlight: boolean;
}): boolean {
  if (
    options.attemptedTargetSequence !== undefined &&
    options.attemptedTargetSequence >= options.targetSequence
  ) {
    return false;
  }
  return !options.replayInFlight;
}

export type SequenceDrainResult<T extends SequencedEvent> = {
  /** Contiguous buffered events to apply, in sequence order. */
  readonly applicable: readonly T[];
  /** Buffered events still beyond a gap, in sequence order. */
  readonly remaining: readonly T[];
};

/**
 * Splits buffered out-of-order events into the contiguous run that can now be
 * applied on top of `latestSequence` and the events still beyond a gap.
 * Duplicates (at or below the cursor, or repeated sequences) are dropped.
 */
export function drainContiguousSequenceEvents<T extends SequencedEvent>(
  latestSequence: number,
  buffered: readonly T[],
): SequenceDrainResult<T> {
  const applicable: T[] = [];
  const remaining: T[] = [];
  let cursor = latestSequence;
  for (const event of buffered.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.sequence <= cursor) {
      continue;
    }
    if (event.sequence === cursor + 1) {
      cursor = event.sequence;
      applicable.push(event);
    } else {
      remaining.push(event);
    }
  }
  return { applicable, remaining };
}
