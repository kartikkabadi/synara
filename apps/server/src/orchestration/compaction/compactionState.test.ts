import type { ThreadTokenUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  IDLE_COMPACTION_STATE,
  PENDING_ACTIVE_TURN_REASON,
  compactionReducer,
  type CompactionControlState,
} from "./compactionState.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const usage: ThreadTokenUsageSnapshot = { usedTokens: 1000 };

const requested = (requestId = "req-1") =>
  ({
    type: "thread.compaction-requested",
    payload: { requestId, trigger: "manual", createdAt: NOW },
  }) as const;

const started = (requestId = "req-1") =>
  ({
    type: "thread.compaction-started",
    payload: {
      requestId,
      owner: "synara",
      trigger: "manual",
      beforeUsage: usage,
      createdAt: NOW,
    },
  }) as const;

const completed = (requestId = "req-1") =>
  ({
    type: "thread.compaction-completed",
    payload: { requestId, sessionEffect: "same-session", createdAt: NOW },
  }) as const;

const failed = (requestId = "req-1", outcomeKnown = true) =>
  ({
    type: "thread.compaction-failed",
    payload: {
      requestId,
      outcomeKnown,
      retryable: outcomeKnown,
      failureKind: "test-failure",
      createdAt: NOW,
    },
  }) as const;

describe("compactionReducer", () => {
  it("moves idle -> pending -> running -> idle across a full lifecycle", () => {
    const pending = compactionReducer(IDLE_COMPACTION_STATE, requested());
    expect(pending).toEqual({
      status: "pending",
      requestId: "req-1",
      trigger: "manual",
      reason: PENDING_ACTIVE_TURN_REASON,
      requestedAt: NOW,
    });

    const running = compactionReducer(pending, started());
    expect(running).toEqual({
      status: "running",
      requestId: "req-1",
      owner: "synara",
      trigger: "manual",
      startedAt: NOW,
      beforeUsage: usage,
    });

    expect(compactionReducer(running, completed())).toEqual(IDLE_COMPACTION_STATE);
  });

  it("ignores a duplicate request while an operation is pending or running", () => {
    const pending = compactionReducer(IDLE_COMPACTION_STATE, requested());
    expect(compactionReducer(pending, requested("req-2"))).toBe(pending);
    const running = compactionReducer(pending, started());
    expect(compactionReducer(running, requested("req-2"))).toBe(running);
  });

  it("ignores terminal events for a different request id", () => {
    const running = compactionReducer(IDLE_COMPACTION_STATE, started());
    expect(compactionReducer(running, completed("req-other"))).toBe(running);
    expect(compactionReducer(running, failed("req-other"))).toBe(running);
  });

  it("settles a known failure back to idle", () => {
    const running = compactionReducer(IDLE_COMPACTION_STATE, started());
    expect(compactionReducer(running, failed("req-1", true))).toEqual(IDLE_COMPACTION_STATE);
  });

  it("marks an unknown-outcome failure as uncertain", () => {
    const running = compactionReducer(IDLE_COMPACTION_STATE, started());
    const uncertain = compactionReducer(running, failed("req-1", false));
    expect(uncertain).toEqual({
      status: "uncertain",
      requestId: "req-1",
      detail: "test-failure",
      since: NOW,
    });
  });

  it("suspends from any state and records the reason", () => {
    const running: CompactionControlState = compactionReducer(IDLE_COMPACTION_STATE, started());
    const suspended = compactionReducer(running, {
      type: "thread.compaction-suspended",
      payload: { reason: "provider-unavailable", detail: "adapter offline", createdAt: NOW },
    });
    expect(suspended).toEqual({
      status: "suspended",
      reason: "provider-unavailable",
      detail: "adapter offline",
      since: NOW,
    });
  });
});
