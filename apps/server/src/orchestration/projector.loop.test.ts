import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-06-02T10:00:00.000Z";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt?: string;
  aggregateId?: string;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe(input.aggregateId ?? "thread-1"),
    occurredAt: input.occurredAt ?? NOW,
    commandId: CommandId.makeUnsafe(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const threadCreatedEvent = makeEvent({
  sequence: 1,
  type: "thread.created",
  payload: {
    threadId: "thread-1",
    projectId: "project-1",
    title: "demo",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

function loopCreatedEvent(): OrchestrationEvent {
  return makeEvent({
    sequence: 2,
    type: "thread.loop-created",
    payload: {
      threadId: "thread-1",
      loop: {
        prompt: "Find and fix bugs",
        intervalSeconds: 300,
        status: "active",
        iterationsRun: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  });
}

async function applyEvents(events: ReadonlyArray<OrchestrationEvent>) {
  let model = createEmptyReadModel(NOW);
  for (const event of events) {
    model = await Effect.runPromise(projectEvent(model, event));
  }
  return model;
}

function loopIterationMessageEvent(sequence: number): OrchestrationEvent {
  return makeEvent({
    sequence,
    type: "thread.message-sent",
    payload: {
      threadId: "thread-1",
      messageId: `loop-iteration-${sequence}`,
      role: "user",
      text: "Find and fix bugs",
      turnId: null,
      streaming: false,
      source: "loop-iteration",
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
}

describe("orchestration projector — loops", () => {
  it("creates a loop on thread.loop-created", async () => {
    const model = await applyEvents([threadCreatedEvent, loopCreatedEvent()]);
    const loop = model.threads[0]?.loop;
    expect(loop?.status).toBe("active");
    expect(loop?.prompt).toBe("Find and fix bugs");
    expect(loop?.intervalSeconds).toBe(300);
    expect(loop?.iterationsRun).toBe(0);
  });

  it("transitions status through the lifecycle events", async () => {
    const paused = await applyEvents([
      threadCreatedEvent,
      loopCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(paused.threads[0]?.loop?.status).toBe("paused");

    const resumed = await applyEvents([
      threadCreatedEvent,
      loopCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.loop-resumed",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(resumed.threads[0]?.loop?.status).toBe("active");

    const cleared = await applyEvents([
      threadCreatedEvent,
      loopCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.loop-cleared",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(cleared.threads[0]?.loop?.status).toBe("cleared");
  });

  it("counts hidden loop-iteration turns", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      loopCreatedEvent(),
      loopIterationMessageEvent(3),
      loopIterationMessageEvent(4),
    ]);
    expect(model.threads[0]?.loop?.iterationsRun).toBe(2);
  });

  it("does not count loop-iteration turns when the loop is not active", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      loopCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
      loopIterationMessageEvent(4),
    ]);
    expect(model.threads[0]?.loop?.iterationsRun).toBe(0);
  });

  it("does not count non-loop-iteration messages", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      loopCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1",
          messageId: "msg-native-1",
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ]);
    expect(model.threads[0]?.loop?.iterationsRun).toBe(0);
  });

  it("ignores loop lifecycle events when no loop exists", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      makeEvent({
        sequence: 2,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(model.threads[0]?.loop).toBeNull();
  });

  it("ignores loop-created for a non-existent thread", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      makeEvent({
        sequence: 2,
        type: "thread.loop-created",
        aggregateId: "thread-other",
        payload: {
          threadId: "thread-other",
          loop: {
            prompt: "orphan",
            intervalSeconds: 60,
            status: "active",
            iterationsRun: 0,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    ]);
    expect(model.threads[0]?.loop).toBeNull();
  });
});
