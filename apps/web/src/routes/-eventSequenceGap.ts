// Stream sequences come from a shared journal. A gap needs checking, but may
// contain only events belonging to other streams.

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
 * A successful scoped replay can certify skipped global sequences without
 * advancing the applied cursor. Duplicates are dropped, including beyond a gap.
 */
export function drainContiguousSequenceEvents<T extends SequencedEvent>(
  latestSequence: number,
  buffered: readonly T[],
  replayedThroughSequence = latestSequence,
): SequenceDrainResult<T> {
  const applicable: T[] = [];
  const remaining: T[] = [];
  let cursor = latestSequence;
  let previousSequence = latestSequence;
  for (const event of buffered.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.sequence <= previousSequence) {
      continue;
    }
    previousSequence = event.sequence;
    if (event.sequence <= Math.max(cursor, replayedThroughSequence) + 1) {
      cursor = event.sequence;
      applicable.push(event);
    } else {
      remaining.push(event);
    }
  }
  return { applicable, remaining };
}
