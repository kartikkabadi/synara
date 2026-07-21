// FILE: decider.loop.test.ts
// Purpose: Decider tests for `/loop` commands and continuation.
// Layer: Orchestration decision logic tests

import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationEvent,
  type ThreadLoop,
  type ThreadTurnPurpose,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string) => CommandId.makeUnsafe(value);
const asThreadId = (value: string) => ThreadId.makeUnsafe(value);
const asTurnId = (value: string) => TurnId.makeUnsafe(value);
const asMessageId = (value: string) => MessageId.makeUnsafe(value);

const NOW = new Date().toISOString();

const modelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
};

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

async function makeReadModelWithThread(options: { parentThreadId?: string | null } = {}) {
  const empty = createEmptyReadModel(NOW);
  const withProject = await Effect.runPromise(
    projectEvent(
      empty,
      makeEvent({
        sequence: 1,
        type: "project.created",
        aggregateKind: "project",
        aggregateId: "project-loop",
        occurredAt: NOW,
        commandId: "cmd-project-create",
        payload: {
          projectId: "project-loop",
          kind: "project",
          title: "Loop Project",
          workspaceRoot: "/tmp/loop",
          defaultModelSelection: null,
          scripts: [],
          isPinned: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ),
  );
  return await Effect.runPromise(
    projectEvent(
      withProject,
      makeEvent({
        sequence: 2,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-loop",
        occurredAt: NOW,
        commandId: "cmd-thread-create",
        payload: {
          threadId: "thread-loop",
          projectId: "project-loop",
          title: "Loop Thread",
          modelSelection,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          parentThreadId: options.parentThreadId ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ),
  );
}

function makeLoop(
  payload: {
    active?: boolean;
    prompt?: string;
    iteration?: number;
    maxIterations?: number | null;
    consecutiveErrors?: number;
    lastStopReason?: ThreadLoop["lastStopReason"];
    activationId?: string;
    createdAt?: string;
    updatedAt?: string;
  } = {},
): ThreadLoop {
  return {
    active: payload.active ?? true,
    prompt: payload.prompt ?? "fix tests",
    iteration: payload.iteration ?? 0,
    maxIterations: payload.maxIterations ?? null,
    endsAt: null,
    hardCap: 100,
    consecutiveErrors: payload.consecutiveErrors ?? 0,
    lastStopReason: payload.lastStopReason ?? null,
    activationId: payload.activationId ?? "test-activation",
    createdAt: payload.createdAt ?? NOW,
    updatedAt: payload.updatedAt ?? NOW,
  };
}

async function projectLoopSet(
  readModel: Awaited<ReturnType<typeof makeReadModelWithThread>>,
  loop: ThreadLoop = makeLoop(),
) {
  return await Effect.runPromise(
    projectEvent(
      readModel,
      makeEvent({
        sequence: 3,
        type: "thread.loop-set",
        aggregateKind: "thread",
        aggregateId: "thread-loop",
        occurredAt: NOW,
        commandId: "cmd-loop-set",
        payload: {
          threadId: "thread-loop",
          loop,
        },
      }),
    ),
  );
}

function makeMessageSentEvent(options: {
  sequence?: number;
  messageId: string;
  role: "user" | "assistant";
  turnId?: string | null;
  purpose?: ThreadTurnPurpose;
  createdAt?: string;
}): OrchestrationEvent {
  const occurredAt = options.createdAt ?? NOW;
  return makeEvent({
    sequence: options.sequence ?? 4,
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: "thread-loop",
    occurredAt,
    commandId: "cmd-message-sent",
    payload: {
      threadId: "thread-loop",
      messageId: options.messageId,
      role: options.role,
      text: "x",
      turnId: options.turnId ?? null,
      streaming: false,
      source: "native",
      ...(options.purpose ? { purpose: options.purpose } : {}),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  });
}

function makeSessionSetEvent(options: {
  sequence?: number;
  activeTurnId: string;
  status?: string;
  updatedAt?: string;
}): OrchestrationEvent {
  const updatedAt = options.updatedAt ?? NOW;
  return makeEvent({
    sequence: options.sequence ?? 5,
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: "thread-loop",
    occurredAt: updatedAt,
    commandId: "cmd-session-set",
    payload: {
      threadId: "thread-loop",
      session: {
        threadId: asThreadId("thread-loop"),
        status: options.status ?? "running",
        providerName: null,
        runtimeMode: "full-access",
        activeTurnId: asTurnId(options.activeTurnId),
        lastError: null,
        updatedAt,
      },
    },
  });
}

function makeTurnQueuedEvent(options: {
  sequence?: number;
  messageId: string;
  purpose?: ThreadTurnPurpose;
  createdAt?: string;
}): OrchestrationEvent {
  const occurredAt = options.createdAt ?? NOW;
  return makeEvent({
    sequence: options.sequence ?? 4,
    type: "thread.turn-queued",
    aggregateKind: "thread",
    aggregateId: "thread-loop",
    occurredAt,
    commandId: "cmd-turn-queued",
    payload: {
      threadId: "thread-loop",
      messageId: options.messageId,
      purpose: options.purpose,
      createdAt: occurredAt,
    },
  });
}

function makeTurnStartRequestedEvent(options: {
  sequence?: number;
  messageId: string;
  purpose?: ThreadTurnPurpose;
  createdAt?: string;
}): OrchestrationEvent {
  const occurredAt = options.createdAt ?? NOW;
  return makeEvent({
    sequence: options.sequence ?? 4,
    type: "thread.turn-start-requested",
    aggregateKind: "thread",
    aggregateId: "thread-loop",
    occurredAt,
    commandId: "cmd-turn-start-requested",
    payload: {
      threadId: "thread-loop",
      messageId: options.messageId,
      purpose: options.purpose,
      createdAt: occurredAt,
    },
  });
}

async function archiveThread(readModel: Awaited<ReturnType<typeof makeReadModelWithThread>>) {
  return await Effect.runPromise(
    projectEvent(
      readModel,
      makeEvent({
        sequence: 3,
        type: "thread.archived",
        aggregateKind: "thread",
        aggregateId: "thread-loop",
        occurredAt: NOW,
        commandId: "cmd-archive",
        payload: {
          threadId: "thread-loop",
          archivedAt: NOW,
          updatedAt: NOW,
        },
      }),
    ),
  );
}

async function deleteThread(
  readModel: Awaited<ReturnType<typeof makeReadModelWithThread>>,
  sequence = 4,
) {
  return await Effect.runPromise(
    projectEvent(
      readModel,
      makeEvent({
        sequence,
        type: "thread.deleted",
        aggregateKind: "thread",
        aggregateId: "thread-loop",
        occurredAt: NOW,
        commandId: "cmd-delete",
        payload: {
          threadId: "thread-loop",
          deletedAt: NOW,
          updatedAt: NOW,
        },
      }),
    ),
  );
}

async function addActiveTurn(
  readModel: Awaited<ReturnType<typeof makeReadModelWithThread>>,
  options: {
    turnId: string;
    messageId: string;
    purpose?: ThreadTurnPurpose;
    messageTimestamp?: string;
  },
) {
  const messageTimestamp = options.messageTimestamp ?? NOW;
  const withMessage = await Effect.runPromise(
    projectEvent(
      readModel,
      makeMessageSentEvent({
        messageId: options.messageId,
        role: "user",
        ...(options.purpose ? { purpose: options.purpose } : {}),
        createdAt: messageTimestamp,
      }),
    ),
  );
  const withStart = await Effect.runPromise(
    projectEvent(
      withMessage,
      makeTurnStartRequestedEvent({
        messageId: options.messageId,
        ...(options.purpose ? { purpose: options.purpose } : {}),
        createdAt: messageTimestamp,
      }),
    ),
  );
  return await Effect.runPromise(
    projectEvent(
      withStart,
      makeSessionSetEvent({ activeTurnId: options.turnId, updatedAt: messageTimestamp }),
    ),
  );
}

describe("decider loop commands", () => {
  it("emits thread.loop-set on thread.loop.set", async () => {
    const readModel = await makeReadModelWithThread();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.set",
          commandId: asCommandId("cmd-loop-set"),
          threadId: asThreadId("thread-loop"),
          prompt: "fix tests",
          maxIterations: 3,
          durationSeconds: null,
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-set");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: {
        active: true,
        prompt: "fix tests",
        iteration: 0,
        maxIterations: 3,
        consecutiveErrors: 0,
        hardCap: 100,
      },
    });
  });

  it("resets iteration and consecutiveErrors on thread.loop.set reconfigure", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({
        active: true,
        prompt: "old prompt",
        iteration: 5,
        consecutiveErrors: 2,
        maxIterations: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.set",
          commandId: asCommandId("cmd-loop-reconfigure"),
          threadId: asThreadId("thread-loop"),
          prompt: "new prompt",
          maxIterations: 3,
          durationSeconds: null,
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-set");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: {
        active: true,
        prompt: "new prompt",
        iteration: 0,
        maxIterations: 3,
        consecutiveErrors: 0,
        hardCap: 100,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: NOW,
      },
    });
    expect((event.payload as { loop: { activationId: unknown } }).loop.activationId).toBe(
      asCommandId("cmd-loop-reconfigure"),
    );
  });

  it("accepts thread.loop.set when expectedActivationId matches the active loop", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, activationId: "activation-1" }),
    );
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.set",
          commandId: asCommandId("cmd-loop-edit"),
          threadId: asThreadId("thread-loop"),
          prompt: "new prompt",
          maxIterations: 3,
          durationSeconds: null,
          expectedActivationId: "activation-1",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-set");
  });

  it("rejects thread.loop.set when expectedActivationId no longer matches", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, activationId: "activation-2" }),
    );
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.loop.set",
            commandId: asCommandId("cmd-loop-edit-stale"),
            threadId: asThreadId("thread-loop"),
            prompt: "new prompt",
            maxIterations: 3,
            durationSeconds: null,
            expectedActivationId: "activation-1",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toMatchObject({
      commandType: "thread.loop.set",
    });
  });

  it("rejects thread.loop.set with expectedActivationId when no loop is active", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: false, activationId: "activation-1" }),
    );
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.loop.set",
            commandId: asCommandId("cmd-loop-edit-ended"),
            threadId: asThreadId("thread-loop"),
            prompt: "new prompt",
            maxIterations: 3,
            durationSeconds: null,
            expectedActivationId: "activation-1",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toMatchObject({
      commandType: "thread.loop.set",
    });
  });

  it("rejects thread.loop.set on archived threads", async () => {
    const readModel = await archiveThread(await makeReadModelWithThread());
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.loop.set",
            commandId: asCommandId("cmd-loop-set-archived"),
            threadId: asThreadId("thread-loop"),
            prompt: "fix tests",
            maxIterations: null,
            durationSeconds: null,
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toMatchObject({
      commandType: "thread.loop.set",
    });
  });

  it("rejects thread.loop.set on child threads", async () => {
    const readModel = await makeReadModelWithThread({
      parentThreadId: asThreadId("thread-parent"),
    });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.loop.set",
            commandId: asCommandId("cmd-loop-set-child"),
            threadId: asThreadId("thread-loop"),
            prompt: "fix tests",
            maxIterations: null,
            durationSeconds: null,
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toMatchObject({
      commandType: "thread.loop.set",
    });
  });

  it("emits thread.loop-off on thread.loop.off", async () => {
    const readModel = await projectLoopSet(await makeReadModelWithThread());

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.off",
          commandId: asCommandId("cmd-loop-off"),
          threadId: asThreadId("thread-loop"),
          reason: "user_stop",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-off");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      stopReason: "user_stop",
      loop: { active: false, lastStopReason: "user_stop" },
    });
  });

  it("emits thread.loop-off idempotently when loop is already off", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: false, lastStopReason: "user_stop" }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.off",
          commandId: asCommandId("cmd-loop-off-idempotent"),
          threadId: asThreadId("thread-loop"),
          reason: "user_stop",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-off");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: { active: false, lastStopReason: "user_stop" },
    });
  });

  it("emits thread.loop-off on deleted threads", async () => {
    const readModel = await deleteThread(await projectLoopSet(await makeReadModelWithThread()));

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.off",
          commandId: asCommandId("cmd-loop-off-deleted"),
          threadId: asThreadId("thread-loop"),
          reason: "thread_deleted",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-off");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: { active: false, lastStopReason: "thread_deleted" },
    });
  });

  it("emits thread.loop-off on thread.loop.toggle when the loop is active", async () => {
    const readModel = await projectLoopSet(await makeReadModelWithThread());

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.toggle",
          commandId: asCommandId("cmd-loop-toggle-off"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-off");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      stopReason: "toggled_off",
      loop: { active: false, lastStopReason: "toggled_off" },
    });
  });

  it("emits thread.loop-set on thread.loop.toggle when the loop is inactive", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: false, lastStopReason: "user_stop" }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.toggle",
          commandId: asCommandId("cmd-loop-toggle-on"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    expect(result).toMatchObject({
      type: "thread.loop-set",
      payload: {
        threadId: asThreadId("thread-loop"),
        loop: { active: true, prompt: "" },
      },
    });
  });

  it("rejects thread.loop.toggle on child threads when arming", async () => {
    const readModel = await makeReadModelWithThread({
      parentThreadId: asThreadId("thread-parent"),
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.loop.toggle",
            commandId: asCommandId("cmd-loop-toggle-child"),
            threadId: asThreadId("thread-loop"),
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toMatchObject({ commandType: "thread.loop.toggle" });
  });

  it("emits thread.loop-off and preserves running loop-owned turn on thread.loop.toggle", async () => {
    const readModel = await addActiveTurn(await projectLoopSet(await makeReadModelWithThread()), {
      turnId: "turn-1",
      messageId: "msg-loop-user",
      purpose: {
        kind: "loop-iteration",
        activationId: "test-activation",
        iteration: 1,
      } as ThreadTurnPurpose,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.toggle",
          commandId: asCommandId("cmd-loop-toggle-interrupt"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    const loopOff = events.find((event) => event.type === "thread.loop-off");
    expect(loopOff).toMatchObject({
      type: "thread.loop-off",
      payload: {
        threadId: asThreadId("thread-loop"),
        stopReason: "toggled_off",
        loop: { active: false },
      },
    });
  });

  it("bumps loop.updatedAt on thread.loop.continue when the decision is wait", async () => {
    const readModel = await addActiveTurn(await projectLoopSet(await makeReadModelWithThread()), {
      turnId: "turn-running",
      messageId: "msg-running-user",
    });
    const later = "2026-07-19T12:30:00.000Z";

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.continue",
          commandId: asCommandId("cmd-loop-continue-wait"),
          threadId: asThreadId("thread-loop"),
          createdAt: later,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.loop-set");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: { active: true, iteration: 0, updatedAt: later },
    });
  });

  it("emits thread.loop-off on thread.loop.continue for a deleted thread", async () => {
    const readModel = await deleteThread(await projectLoopSet(await makeReadModelWithThread()));

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.continue",
          commandId: asCommandId("cmd-loop-continue-deleted"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-off");
    expect(event.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      stopReason: "thread_deleted",
      loop: { active: false, lastStopReason: "thread_deleted" },
    });
  });

  it("binds the first user message as the loop prompt and iteration body when prompt is omitted", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "" }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: asCommandId("cmd-turn-start-loop-prompt"),
          threadId: asThreadId("thread-loop"),
          message: {
            messageId: asMessageId("msg-user-prompt-bind"),
            role: "user",
            text: "fix the failing tests",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.loop-continued");
    expect(events[1]?.type).toBe("thread.message-sent");
    expect(events[2]?.type).toBe("thread.turn-start-requested");
    const messagePayload = events[1]?.payload as { purpose?: unknown };
    expect(messagePayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 1 });
  });

  it("replaces the loop prompt and continues when an ordinary message is sent while the loop is already armed", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "fix tests" }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: asCommandId("cmd-turn-start-manual"),
          threadId: asThreadId("thread-loop"),
          message: {
            messageId: asMessageId("msg-user-manual"),
            role: "user",
            text: "actually ignore that",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.loop-continued");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      nextIteration: 1,
      loop: { active: true, prompt: "actually ignore that", iteration: 1 },
    });
    expect(events[1]?.type).toBe("thread.message-sent");
    const messagePayload = events[1]?.payload as { purpose?: unknown; text?: string };
    expect(messagePayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 1 });
    expect(messagePayload.text).toBe("actually ignore that");
    expect(events[2]?.type).toBe("thread.turn-start-requested");
    const turnPayload = events[2]?.payload as {
      purpose?: unknown;
      messageId?: string;
      dispatchMode?: string;
    };
    expect(turnPayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 1 });
    expect(turnPayload.messageId).toBe(asMessageId("msg-user-manual"));
    expect(turnPayload.dispatchMode).toBe("queue");
  });

  it("replaces the loop prompt and queues the replacement while a loop-owned turn is running", async () => {
    const loopReadModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "fix tests", iteration: 1 }),
    );
    const readModel = await addActiveTurn(loopReadModel, {
      turnId: "turn-loop-1",
      messageId: "msg-loop-user-1",
      purpose: {
        kind: "loop-iteration",
        activationId: "test-activation",
        iteration: 1,
      } as ThreadTurnPurpose,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: asCommandId("cmd-turn-start-replace-running"),
          threadId: asThreadId("thread-loop"),
          message: {
            messageId: asMessageId("msg-user-replace-running"),
            role: "user",
            text: "try a different approach",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.loop-continued");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      nextIteration: 2,
      loop: { active: true, prompt: "try a different approach", iteration: 2 },
    });
    expect(events[1]?.type).toBe("thread.message-sent");
    const messagePayload = events[1]?.payload as { purpose?: unknown; text?: string };
    expect(messagePayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 2 });
    expect(messagePayload.text).toBe("try a different approach");
    expect(events[2]?.type).toBe("thread.turn-queued");
    const turnPayload = events[2]?.payload as {
      purpose?: unknown;
      messageId?: string;
      dispatchMode?: string;
    };
    expect(turnPayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 2 });
    expect(turnPayload.messageId).toBe(asMessageId("msg-user-replace-running"));
    expect(turnPayload.dispatchMode).toBe("queue");
  });

  it("retires the loop when a manual message races a pending loop-owned turn start", async () => {
    const readModel = await Effect.runPromise(
      projectEvent(
        await projectLoopSet(
          await makeReadModelWithThread(),
          makeLoop({ active: true, prompt: "fix tests", iteration: 1 }),
        ),
        makeTurnQueuedEvent({
          messageId: "msg-queued-1",
          purpose: {
            kind: "loop-iteration",
            activationId: "test-activation",
            iteration: 1,
          } as ThreadTurnPurpose,
        }),
      ),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: asCommandId("cmd-turn-start-replace-queued"),
          threadId: asThreadId("thread-loop"),
          message: {
            messageId: asMessageId("msg-user-replace-queued"),
            role: "user",
            text: "refine the prompt",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.loop-off");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      stopReason: "replaced_by_manual_policy",
      loop: { active: false, lastStopReason: "replaced_by_manual_policy" },
    });
    expect(events[1]?.type).toBe("thread.message-sent");
    const messagePayload = events[1]?.payload as { purpose?: unknown; text?: string };
    expect(messagePayload.purpose).toBeUndefined();
    expect(messagePayload.text).toBe("refine the prompt");
    expect(events[2]?.type).toBe("thread.turn-start-requested");
    const turnPayload = events[2]?.payload as {
      purpose?: unknown;
      messageId?: string;
    };
    expect(turnPayload.purpose).toBeUndefined();
    expect(turnPayload.messageId).toBe(asMessageId("msg-user-replace-queued"));
  });

  it("emits thread.loop-off on thread.turn.interrupt when the active turn is loop-owned", async () => {
    const readModel = await addActiveTurn(await projectLoopSet(await makeReadModelWithThread()), {
      turnId: "turn-loop-1",
      messageId: "msg-loop-user-1",
      purpose: {
        kind: "loop-iteration",
        activationId: "test-activation",
        iteration: 1,
      } as ThreadTurnPurpose,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: asCommandId("cmd-turn-interrupt-loop"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.loop-off");
    expect(events[1]?.type).toBe("thread.turn-interrupt-requested");
  });

  it("does not emit thread.loop-off on thread.turn.interrupt for a manual turn", async () => {
    const loopReadModel = await projectLoopSet(await makeReadModelWithThread());
    const readModel = await addActiveTurn(loopReadModel, {
      turnId: "turn-manual-1",
      messageId: "msg-manual-user-1",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: asCommandId("cmd-turn-interrupt-manual"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.turn-interrupt-requested");
  });

  it("thread.loop.continue emits loop message, turn request, and continued event", async () => {
    const readModel = await projectLoopSet(await makeReadModelWithThread());

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.continue",
          commandId: asCommandId("cmd-loop-continue"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("thread.message-sent");
    expect(events[1]?.type).toBe("thread.turn-start-requested");
    expect(events[2]?.type).toBe("thread.loop-continued");

    const messagePayload = events[0]?.payload as { purpose?: unknown };
    expect(messagePayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 1 });

    const turnPayload = events[1]?.payload as { purpose?: unknown };
    expect(turnPayload.purpose).toMatchObject({ kind: "loop-iteration", iteration: 1 });

    const continuedPayload = events[2]?.payload as {
      nextIteration: number;
      nextConsecutiveErrors: number;
    };
    expect(continuedPayload.nextIteration).toBe(1);
    expect(continuedPayload.nextConsecutiveErrors).toBe(0);
  });

  it("thread.loop.continue stops when hard cap is reached", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true }),
    );
    const withHardCap = await Effect.runPromise(
      projectEvent(
        readModel,
        makeEvent({
          sequence: 4,
          type: "thread.loop-set",
          aggregateKind: "thread",
          aggregateId: "thread-loop",
          occurredAt: NOW,
          commandId: "cmd-loop-hardcap",
          payload: {
            threadId: "thread-loop",
            loop: { ...makeLoop({ active: true }), iteration: 1, hardCap: 1 },
          },
        }),
      ),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.loop.continue",
          commandId: asCommandId("cmd-loop-continue"),
          threadId: asThreadId("thread-loop"),
          createdAt: NOW,
        },
        readModel: withHardCap,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.loop-off");
    expect((event.payload as { stopReason: string }).stopReason).toBe("hard_cap");
  });
});
