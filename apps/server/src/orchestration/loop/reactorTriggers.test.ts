import type { CommandId, EventId, OrchestrationEvent, ThreadId } from "@synara/contracts";
import { makeLoop } from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { classifyLoopReactorEvent } from "./reactorTriggers.ts";

const now = "2026-07-19T12:00:00.000Z";
const threadId = "thread-1" as unknown as ThreadId;

function makeEvent(options: {
  type: string;
  payload: unknown;
  commandId?: string | undefined;
}): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: "evt-1" as unknown as EventId,
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: now,
    commandId: (options.commandId ?? "cmd-1") as unknown as CommandId,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: options.type,
    payload: options.payload,
  } as unknown as OrchestrationEvent;
}

function activityEvent(kind: string, commandId?: string): OrchestrationEvent {
  return makeEvent({
    type: "thread.activity-appended",
    commandId,
    payload: {
      threadId,
      activity: {
        id: "activity-1",
        tone: "approval",
        kind,
        summary: "activity",
        payload: {},
        turnId: null,
        createdAt: now,
      },
    },
  });
}

describe("classifyLoopReactorEvent", () => {
  it("syncs and continues on thread.loop-set", () => {
    const loop = makeLoop();
    expect(
      classifyLoopReactorEvent(makeEvent({ type: "thread.loop-set", payload: { threadId, loop } })),
    ).toEqual({ kind: "sync-and-continue", threadId, loop });
  });

  it("only syncs on loop-continued, loop-off, and loop-wait-noted", () => {
    const loop = makeLoop();
    for (const type of ["thread.loop-continued", "thread.loop-off", "thread.loop-wait-noted"]) {
      expect(classifyLoopReactorEvent(makeEvent({ type, payload: { threadId, loop } }))).toEqual({
        kind: "sync",
        threadId,
        loop,
      });
    }
  });

  it("continues on blocker-resolved activity but ignores other activity", () => {
    expect(classifyLoopReactorEvent(activityEvent("approval.resolved"))).toEqual({
      kind: "continue",
      threadId,
    });
    expect(classifyLoopReactorEvent(activityEvent("user-input.resolved"))).toEqual({
      kind: "continue",
      threadId,
    });
    expect(classifyLoopReactorEvent(activityEvent("approval.requested"))).toEqual({
      kind: "ignore",
    });
  });

  it("ignores startup-reconciliation blocker-resolved activity and session-set", () => {
    expect(
      classifyLoopReactorEvent(activityEvent("approval.resolved", "restart-reconcile:thread-1")),
    ).toEqual({ kind: "ignore" });
    expect(
      classifyLoopReactorEvent(
        makeEvent({
          type: "thread.session-set",
          commandId: "restart-reconcile:thread-1",
          payload: { threadId, session: {} },
        }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("continues on session-set and interaction-mode-set", () => {
    expect(
      classifyLoopReactorEvent(
        makeEvent({ type: "thread.session-set", payload: { threadId, session: {} } }),
      ),
    ).toEqual({ kind: "continue", threadId });
    expect(
      classifyLoopReactorEvent(
        makeEvent({
          type: "thread.interaction-mode-set",
          payload: { threadId, interactionMode: "default", updatedAt: now },
        }),
      ),
    ).toEqual({ kind: "continue", threadId });
  });

  it("turns the loop off on archive and delete lifecycle events", () => {
    expect(
      classifyLoopReactorEvent(
        makeEvent({ type: "thread.archived", payload: { threadId, archivedAt: now } }),
      ),
    ).toEqual({ kind: "lifecycle-off", threadId, reason: "thread_archived" });
    expect(
      classifyLoopReactorEvent(
        makeEvent({ type: "thread.deleted", payload: { threadId, deletedAt: now } }),
      ),
    ).toEqual({ kind: "lifecycle-off", threadId, reason: "thread_deleted" });
  });

  it("ignores unrelated events", () => {
    expect(
      classifyLoopReactorEvent(
        makeEvent({ type: "thread.runtime-mode-set", payload: { threadId } }),
      ),
    ).toEqual({ kind: "ignore" });
  });
});
