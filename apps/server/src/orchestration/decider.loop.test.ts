import {
  CommandId,
  EventId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-06-02T10:00:00.000Z";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread-1"),
    occurredAt: NOW,
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

function loopCreatedEvent(status: "active" | "paused" = "active"): OrchestrationEvent {
  return makeEvent({
    sequence: 2,
    type: "thread.loop-created",
    payload: {
      threadId: "thread-1",
      loop: {
        prompt: "Find and fix bugs",
        intervalSeconds: 300,
        status,
        iterationsRun: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  });
}

async function seedReadModel(events: ReadonlyArray<OrchestrationEvent>) {
  let model = createEmptyReadModel(NOW);
  for (const event of events) {
    model = await Effect.runPromise(projectEvent(model, event));
  }
  return model;
}

function decide(
  command: OrchestrationCommand,
  readModel: Awaited<ReturnType<typeof seedReadModel>>,
) {
  return decideOrchestrationCommand({ command, readModel });
}

describe("orchestration decider — loops", () => {
  it("creates a loop on a thread without one", async () => {
    const readModel = await seedReadModel([threadCreatedEvent]);
    const command = {
      type: "thread.loop.create",
      commandId: CommandId.makeUnsafe("cmd-loop-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "Find and fix bugs",
      intervalSeconds: 300,
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.create" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    expect(Array.isArray(event)).toBe(false);
    const single = event as Extract<OrchestrationEvent, { type: "thread.loop-created" }>;
    expect(single.type).toBe("thread.loop-created");
    expect(single.payload.loop.prompt).toBe("Find and fix bugs");
    expect(single.payload.loop.intervalSeconds).toBe(300);
    expect(single.payload.loop.status).toBe("active");
    expect(single.payload.loop.iterationsRun).toBe(0);
  });

  it("rejects creating a second loop while one is active", async () => {
    const readModel = await seedReadModel([threadCreatedEvent, loopCreatedEvent("active")]);
    const command = {
      type: "thread.loop.create",
      commandId: CommandId.makeUnsafe("cmd-loop-create-2"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "Something else",
      intervalSeconds: 60,
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.create" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("allows creating a new loop after the previous one is cleared", async () => {
    const readModel = await seedReadModel([
      threadCreatedEvent,
      loopCreatedEvent("active"),
      makeEvent({
        sequence: 3,
        type: "thread.loop-cleared",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    const command = {
      type: "thread.loop.create",
      commandId: CommandId.makeUnsafe("cmd-loop-create-2"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "New loop",
      intervalSeconds: 120,
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.create" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    const single = event as Extract<OrchestrationEvent, { type: "thread.loop-created" }>;
    expect(single.type).toBe("thread.loop-created");
    expect(single.payload.loop.prompt).toBe("New loop");
  });

  it("pauses an active loop", async () => {
    const readModel = await seedReadModel([threadCreatedEvent, loopCreatedEvent("active")]);
    const command = {
      type: "thread.loop.pause",
      commandId: CommandId.makeUnsafe("cmd-loop-pause"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.pause" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    expect((event as OrchestrationEvent).type).toBe("thread.loop-paused");
  });

  it("rejects pausing when there is no active loop", async () => {
    const readModel = await seedReadModel([threadCreatedEvent]);
    const command = {
      type: "thread.loop.pause",
      commandId: CommandId.makeUnsafe("cmd-loop-pause"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.pause" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects pausing an already-paused loop", async () => {
    const readModel = await seedReadModel([
      threadCreatedEvent,
      loopCreatedEvent("active"),
      makeEvent({
        sequence: 3,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    const command = {
      type: "thread.loop.pause",
      commandId: CommandId.makeUnsafe("cmd-loop-pause-2"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.pause" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("resumes only a paused loop", async () => {
    const activeModel = await seedReadModel([threadCreatedEvent, loopCreatedEvent("active")]);
    const resumeCommand = {
      type: "thread.loop.resume",
      commandId: CommandId.makeUnsafe("cmd-loop-resume"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.resume" }>;

    const exitActive = await Effect.runPromiseExit(decide(resumeCommand, activeModel));
    expect(Exit.isFailure(exitActive)).toBe(true);

    const pausedModel = await seedReadModel([
      threadCreatedEvent,
      loopCreatedEvent("active"),
      makeEvent({
        sequence: 3,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    const event = await Effect.runPromise(decide(resumeCommand, pausedModel));
    expect((event as OrchestrationEvent).type).toBe("thread.loop-resumed");
  });

  it("clears an active loop", async () => {
    const readModel = await seedReadModel([threadCreatedEvent, loopCreatedEvent("active")]);
    const command = {
      type: "thread.loop.clear",
      commandId: CommandId.makeUnsafe("cmd-loop-clear"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.clear" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    expect((event as OrchestrationEvent).type).toBe("thread.loop-cleared");
  });

  it("clears a paused loop", async () => {
    const readModel = await seedReadModel([
      threadCreatedEvent,
      loopCreatedEvent("active"),
      makeEvent({
        sequence: 3,
        type: "thread.loop-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    const command = {
      type: "thread.loop.clear",
      commandId: CommandId.makeUnsafe("cmd-loop-clear"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.clear" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    expect((event as OrchestrationEvent).type).toBe("thread.loop-cleared");
  });

  it("rejects clearing when there is no loop", async () => {
    const readModel = await seedReadModel([threadCreatedEvent]);
    const command = {
      type: "thread.loop.clear",
      commandId: CommandId.makeUnsafe("cmd-loop-clear"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.clear" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects clearing an already-cleared loop", async () => {
    const readModel = await seedReadModel([
      threadCreatedEvent,
      loopCreatedEvent("active"),
      makeEvent({
        sequence: 3,
        type: "thread.loop-cleared",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    const command = {
      type: "thread.loop.clear",
      commandId: CommandId.makeUnsafe("cmd-loop-clear-2"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.clear" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects creating a loop while a goal is active", async () => {
    const readModel = await seedReadModel([
      threadCreatedEvent,
      makeEvent({
        sequence: 2,
        type: "thread.goal-created",
        payload: {
          threadId: "thread-1",
          goal: {
            id: "goal-1",
            objective: "Fix tests",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            turnCount: 0,
            continuationCount: 0,
            timeUsedSeconds: 0,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    ]);
    const command = {
      type: "thread.loop.create",
      commandId: CommandId.makeUnsafe("cmd-loop-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "Find and fix bugs",
      intervalSeconds: 300,
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.create" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects creating a loop on a non-compacting provider (Claude)", async () => {
    const claudeThreadEvent = makeEvent({
      sequence: 1,
      type: "thread.created",
      payload: {
        threadId: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const readModel = await seedReadModel([claudeThreadEvent]);
    const command = {
      type: "thread.loop.create",
      commandId: CommandId.makeUnsafe("cmd-loop-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "Find and fix bugs",
      intervalSeconds: 300,
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.loop.create" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
