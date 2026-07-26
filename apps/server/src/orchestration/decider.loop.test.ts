// FILE: decider.loop.test.ts
// Purpose: Decider tests for `/loop` commands and continuation.
// Layer: Orchestration decision logic tests

import {
  CommandId,
  EventId,
  LoopActivationId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationEvent,
  type ThreadLoop,
  type ThreadTurnPurpose,
} from "@synara/contracts";
import { makeLoop as makeLoopFixture } from "@synara/shared/loopTestFixtures";
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

let nextSequence = 1;

function makeEvent(input: {
  type: OrchestrationEvent["type"];
  aggregateKind?: OrchestrationEvent["aggregateKind"];
  aggregateId?: string;
  occurredAt?: string;
  commandId?: string;
  payload: unknown;
}): OrchestrationEvent {
  const sequence = nextSequence++;
  const aggregateKind = input.aggregateKind ?? "thread";
  const aggregateId = input.aggregateId ?? "thread-loop";
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    type: input.type,
    aggregateKind,
    aggregateId:
      aggregateKind === "project"
        ? ProjectId.makeUnsafe(aggregateId)
        : ThreadId.makeUnsafe(aggregateId),
    occurredAt: input.occurredAt ?? NOW,
    commandId: CommandId.makeUnsafe(input.commandId ?? `cmd-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

type LoopReadModel = Awaited<ReturnType<typeof makeReadModelWithThread>>;

async function projectAll(
  readModel: ReturnType<typeof createEmptyReadModel>,
  events: ReadonlyArray<OrchestrationEvent>,
) {
  let current = readModel;
  for (const event of events) {
    current = await Effect.runPromise(projectEvent(current, event));
  }
  return current;
}

async function makeReadModelWithThread(options: { parentThreadId?: string | null } = {}) {
  return await projectAll(createEmptyReadModel(NOW), [
    makeEvent({
      type: "project.created",
      aggregateKind: "project",
      aggregateId: "project-loop",
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
    makeEvent({
      type: "thread.created",
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
  ]);
}

function makeLoop(overrides: Partial<ThreadLoop> = {}): ThreadLoop {
  return makeLoopFixture({
    prompt: "fix tests",
    iteration: 0,
    maxIterations: null,
    activationId: LoopActivationId.makeUnsafe("test-activation"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

async function projectLoopSet(readModel: LoopReadModel, loop: ThreadLoop = makeLoop()) {
  return await projectAll(readModel, [
    makeEvent({
      type: "thread.loop-set",
      payload: { threadId: "thread-loop", loop },
    }),
  ]);
}

function makeMessageSentEvent(options: {
  messageId: string;
  purpose?: ThreadTurnPurpose;
  createdAt?: string;
}): OrchestrationEvent {
  const occurredAt = options.createdAt ?? NOW;
  return makeEvent({
    type: "thread.message-sent",
    occurredAt,
    payload: {
      threadId: "thread-loop",
      messageId: options.messageId,
      role: "user",
      text: "x",
      turnId: null,
      streaming: false,
      source: "native",
      ...(options.purpose ? { purpose: options.purpose } : {}),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  });
}

function makeTurnSignalEvent(options: {
  type: "thread.turn-queued" | "thread.turn-start-requested";
  messageId: string;
  purpose?: ThreadTurnPurpose;
  createdAt?: string;
}): OrchestrationEvent {
  const occurredAt = options.createdAt ?? NOW;
  return makeEvent({
    type: options.type,
    occurredAt,
    payload: {
      threadId: "thread-loop",
      messageId: options.messageId,
      purpose: options.purpose,
      createdAt: occurredAt,
    },
  });
}

function makeSessionSetEvent(options: {
  activeTurnId: string;
  updatedAt?: string;
}): OrchestrationEvent {
  const updatedAt = options.updatedAt ?? NOW;
  return makeEvent({
    type: "thread.session-set",
    occurredAt: updatedAt,
    payload: {
      threadId: "thread-loop",
      session: {
        threadId: asThreadId("thread-loop"),
        status: "running",
        providerName: null,
        runtimeMode: "full-access",
        activeTurnId: asTurnId(options.activeTurnId),
        lastError: null,
        updatedAt,
      },
    },
  });
}

async function archiveThread(readModel: LoopReadModel) {
  return await projectAll(readModel, [
    makeEvent({
      type: "thread.archived",
      payload: { threadId: "thread-loop", archivedAt: NOW, updatedAt: NOW },
    }),
  ]);
}

async function deleteThread(readModel: LoopReadModel) {
  return await projectAll(readModel, [
    makeEvent({
      type: "thread.deleted",
      payload: { threadId: "thread-loop", deletedAt: NOW, updatedAt: NOW },
    }),
  ]);
}

async function addActiveTurn(
  readModel: LoopReadModel,
  options: { turnId: string; messageId: string; purpose?: ThreadTurnPurpose },
) {
  return await projectAll(readModel, [
    makeMessageSentEvent({
      messageId: options.messageId,
      ...(options.purpose ? { purpose: options.purpose } : {}),
    }),
    makeTurnSignalEvent({
      type: "thread.turn-start-requested",
      messageId: options.messageId,
      ...(options.purpose ? { purpose: options.purpose } : {}),
    }),
    makeSessionSetEvent({ activeTurnId: options.turnId }),
  ]);
}

type DeciderCommand = Parameters<typeof decideOrchestrationCommand>[0]["command"];

async function decide(readModel: LoopReadModel, command: DeciderCommand) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  return Array.isArray(result) ? result : [result];
}

function expectRejected(readModel: LoopReadModel, command: DeciderCommand) {
  return expect(
    Effect.runPromise(decideOrchestrationCommand({ command, readModel })),
  ).rejects.toMatchObject({ commandType: command.type });
}

function loopSetCommand(
  commandId: string,
  overrides: Partial<Extract<DeciderCommand, { type: "thread.loop.set" }>> = {},
): DeciderCommand {
  return {
    type: "thread.loop.set",
    commandId: asCommandId(commandId),
    threadId: asThreadId("thread-loop"),
    prompt: "fix tests",
    maxIterations: null,
    durationSeconds: null,
    createdAt: NOW,
    ...overrides,
  };
}

function loopOffCommand(commandId: string, reason: "user_stop" | "thread_deleted"): DeciderCommand {
  return {
    type: "thread.loop.off",
    commandId: asCommandId(commandId),
    threadId: asThreadId("thread-loop"),
    reason,
    createdAt: NOW,
  };
}

function loopToggleCommand(commandId: string): DeciderCommand {
  return {
    type: "thread.loop.toggle",
    commandId: asCommandId(commandId),
    threadId: asThreadId("thread-loop"),
    createdAt: NOW,
  };
}

function loopContinueCommand(commandId: string, createdAt = NOW): DeciderCommand {
  return {
    type: "thread.loop.continue",
    commandId: asCommandId(commandId),
    threadId: asThreadId("thread-loop"),
    createdAt,
  };
}

function turnStartCommand(commandId: string, messageId: string, text: string): DeciderCommand {
  return {
    type: "thread.turn.start",
    commandId: asCommandId(commandId),
    threadId: asThreadId("thread-loop"),
    message: {
      messageId: asMessageId(messageId),
      role: "user",
      text,
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: NOW,
  };
}

function turnInterruptCommand(commandId: string): DeciderCommand {
  return {
    type: "thread.turn.interrupt",
    commandId: asCommandId(commandId),
    threadId: asThreadId("thread-loop"),
    createdAt: NOW,
  };
}

const LOOP_ITERATION_PURPOSE = {
  kind: "loop-iteration",
  activationId: LoopActivationId.makeUnsafe("test-activation"),
  iteration: 1,
} as ThreadTurnPurpose;

describe("decider loop commands", () => {
  it("emits thread.loop-set on thread.loop.set", async () => {
    const readModel = await makeReadModelWithThread();
    const [event] = await decide(readModel, loopSetCommand("cmd-loop-set", { maxIterations: 3 }));
    expect(event?.type).toBe("thread.loop-set");
    expect(event?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: {
        active: true,
        prompt: "fix tests",
        iteration: 0,
        maxIterations: 3,
        durationSeconds: null,
        consecutiveErrors: 0,
        hardCap: 100,
      },
    });
  });

  it("stores durationSeconds and derives endsAt for duration budgets", async () => {
    const readModel = await makeReadModelWithThread();
    const [event] = await decide(
      readModel,
      loopSetCommand("cmd-loop-set-duration", { durationSeconds: 30 * 60 }),
    );
    expect(event?.type).toBe("thread.loop-set");
    expect(event?.payload).toMatchObject({
      loop: {
        maxIterations: null,
        durationSeconds: 30 * 60,
        endsAt: new Date(Date.parse(NOW) + 30 * 60 * 1000).toISOString(),
      },
    });
  });

  it("re-anchors endsAt to the new budget when reconfiguring a duration loop", async () => {
    const originalCreatedAt = "2026-01-01T00:00:00.000Z";
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({
        active: true,
        durationSeconds: 30 * 60,
        endsAt: "2026-01-01T00:30:00.000Z",
        createdAt: originalCreatedAt,
      }),
    );
    const [event] = await decide(
      readModel,
      loopSetCommand("cmd-loop-reconfigure-duration", { durationSeconds: 45 * 60 }),
    );
    expect(event?.payload).toMatchObject({
      loop: {
        durationSeconds: 45 * 60,
        endsAt: new Date(Date.parse(NOW) + 45 * 60 * 1000).toISOString(),
        // createdAt keeps the original activation start for the Started row.
        createdAt: originalCreatedAt,
      },
    });
  });

  it("arms budget-less thread.loop.set with no explicit budget (hard cap only)", async () => {
    const readModel = await makeReadModelWithThread();
    const [event] = await decide(readModel, loopSetCommand("cmd-loop-set-budgetless"));
    expect(event?.type).toBe("thread.loop-set");
    expect(event?.payload).toMatchObject({
      loop: { maxIterations: null, endsAt: null, durationSeconds: null },
    });
  });

  it("preserves the active prompt on thread.loop.set with a null prompt", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "keep me" }),
    );
    const [event] = await decide(
      readModel,
      loopSetCommand("cmd-loop-set-null-prompt", { prompt: null, maxIterations: 3 }),
    );
    expect(event?.type).toBe("thread.loop-set");
    expect(event?.payload).toMatchObject({ loop: { prompt: "keep me" } });
  });

  it("rejects thread.loop.set clearing an active prompt with an empty string", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "keep me" }),
    );
    await expectRejected(
      readModel,
      loopSetCommand("cmd-loop-set-empty-prompt", { prompt: "", maxIterations: 3 }),
    );
  });

  it("returns no events for thread.loop.off on a thread without a loop", async () => {
    const readModel = await makeReadModelWithThread();
    const events = await decide(readModel, loopOffCommand("cmd-loop-off-no-loop", "user_stop"));
    expect(events).toEqual([]);
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

    const [event] = await decide(
      readModel,
      loopSetCommand("cmd-loop-reconfigure", { prompt: "new prompt", maxIterations: 3 }),
    );
    expect(event?.type).toBe("thread.loop-set");
    expect(event?.payload).toMatchObject({
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
        activationId: asCommandId("cmd-loop-reconfigure"),
      },
    });
  });

  it("accepts thread.loop.set when expectedActivationId matches the active loop", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, activationId: LoopActivationId.makeUnsafe("activation-1") }),
    );
    const [event] = await decide(
      readModel,
      loopSetCommand("cmd-loop-edit", {
        prompt: "new prompt",
        maxIterations: 3,
        expectedActivationId: LoopActivationId.makeUnsafe("activation-1"),
      }),
    );
    expect(event?.type).toBe("thread.loop-set");
  });

  it.each([
    ["the activation no longer matches", { active: true, activationId: "activation-2" }],
    ["no loop is active", { active: false, activationId: "activation-1" }],
  ] as const)("rejects thread.loop.set with expectedActivationId when %s", async (_name, loop) => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({
        active: loop.active,
        activationId: LoopActivationId.makeUnsafe(loop.activationId),
      }),
    );
    await expectRejected(
      readModel,
      loopSetCommand("cmd-loop-edit-guarded", {
        expectedActivationId: LoopActivationId.makeUnsafe("activation-1"),
      }),
    );
  });

  it("rejects thread.loop.set on archived threads", async () => {
    const readModel = await archiveThread(await makeReadModelWithThread());
    await expectRejected(readModel, loopSetCommand("cmd-loop-set-archived"));
  });

  it("rejects thread.loop.set on child threads", async () => {
    const readModel = await makeReadModelWithThread({
      parentThreadId: asThreadId("thread-parent"),
    });
    await expectRejected(readModel, loopSetCommand("cmd-loop-set-child"));
  });

  it("emits thread.loop-off on thread.loop.off", async () => {
    const readModel = await projectLoopSet(await makeReadModelWithThread());
    const [event] = await decide(readModel, loopOffCommand("cmd-loop-off", "user_stop"));
    expect(event?.type).toBe("thread.loop-off");
    expect(event?.payload).toMatchObject({
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
    const [event] = await decide(readModel, loopOffCommand("cmd-loop-off-idempotent", "user_stop"));
    expect(event?.type).toBe("thread.loop-off");
    expect(event?.payload).toMatchObject({
      loop: { active: false, lastStopReason: "user_stop" },
    });
  });

  it("emits thread.loop-off on deleted threads", async () => {
    const readModel = await deleteThread(await projectLoopSet(await makeReadModelWithThread()));
    const [event] = await decide(
      readModel,
      loopOffCommand("cmd-loop-off-deleted", "thread_deleted"),
    );
    expect(event?.type).toBe("thread.loop-off");
    expect(event?.payload).toMatchObject({
      loop: { active: false, lastStopReason: "thread_deleted" },
    });
  });

  it("emits thread.loop-off on thread.loop.toggle when the loop is active", async () => {
    const readModel = await projectLoopSet(await makeReadModelWithThread());
    const [event] = await decide(readModel, loopToggleCommand("cmd-loop-toggle-off"));
    expect(event?.type).toBe("thread.loop-off");
    expect(event?.payload).toMatchObject({
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
    const [event] = await decide(readModel, loopToggleCommand("cmd-loop-toggle-on"));
    expect(event).toMatchObject({
      type: "thread.loop-set",
      payload: {
        threadId: asThreadId("thread-loop"),
        loop: { active: true, prompt: "", maxIterations: null, durationSeconds: null },
      },
    });
  });

  it("rejects thread.loop.toggle on child threads when arming", async () => {
    const readModel = await makeReadModelWithThread({
      parentThreadId: asThreadId("thread-parent"),
    });
    await expectRejected(readModel, loopToggleCommand("cmd-loop-toggle-child"));
  });

  it("emits thread.loop-off and preserves running loop-owned turn on thread.loop.toggle", async () => {
    const readModel = await addActiveTurn(await projectLoopSet(await makeReadModelWithThread()), {
      turnId: "turn-1",
      messageId: "msg-loop-user",
      purpose: LOOP_ITERATION_PURPOSE,
    });

    const events = await decide(readModel, loopToggleCommand("cmd-loop-toggle-interrupt"));
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

    const events = await decide(readModel, loopContinueCommand("cmd-loop-continue-wait", later));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.loop-wait-noted");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      loop: { active: true, iteration: 0, updatedAt: later },
    });
  });

  it("binds the first user message as the loop prompt and iteration body when prompt is omitted", async () => {
    const readModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "" }),
    );

    const events = await decide(
      readModel,
      turnStartCommand(
        "cmd-turn-start-loop-prompt",
        "msg-user-prompt-bind",
        "fix the failing tests",
      ),
    );
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

    const events = await decide(
      readModel,
      turnStartCommand("cmd-turn-start-manual", "msg-user-manual", "actually ignore that"),
    );
    expect(events[0]?.type).toBe("thread.loop-continued");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      nextIteration: 1,
      loop: { active: true, prompt: "actually ignore that", iteration: 1 },
    });
    expect(events[1]?.type).toBe("thread.message-sent");
    expect(events[1]?.payload).toMatchObject({
      purpose: { kind: "loop-iteration", iteration: 1 },
      text: "actually ignore that",
    });
    expect(events[2]?.type).toBe("thread.turn-start-requested");
    expect(events[2]?.payload).toMatchObject({
      purpose: { kind: "loop-iteration", iteration: 1 },
      messageId: asMessageId("msg-user-manual"),
      dispatchMode: "queue",
    });
  });

  it("replaces the loop prompt and queues the replacement while a loop-owned turn is running", async () => {
    const loopReadModel = await projectLoopSet(
      await makeReadModelWithThread(),
      makeLoop({ active: true, prompt: "fix tests", iteration: 1 }),
    );
    const readModel = await addActiveTurn(loopReadModel, {
      turnId: "turn-loop-1",
      messageId: "msg-loop-user-1",
      purpose: LOOP_ITERATION_PURPOSE,
    });

    const events = await decide(
      readModel,
      turnStartCommand(
        "cmd-turn-start-replace-running",
        "msg-user-replace-running",
        "try a different approach",
      ),
    );
    expect(events[0]?.type).toBe("thread.loop-continued");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      nextIteration: 2,
      loop: { active: true, prompt: "try a different approach", iteration: 2 },
    });
    expect(events[1]?.type).toBe("thread.message-sent");
    expect(events[1]?.payload).toMatchObject({
      purpose: { kind: "loop-iteration", iteration: 2 },
      text: "try a different approach",
    });
    expect(events[2]?.type).toBe("thread.turn-queued");
    expect(events[2]?.payload).toMatchObject({
      purpose: { kind: "loop-iteration", iteration: 2 },
      messageId: asMessageId("msg-user-replace-running"),
      dispatchMode: "queue",
    });
  });

  it("retires the loop when a manual message races a pending loop-owned turn start", async () => {
    const readModel = await projectAll(
      await projectLoopSet(
        await makeReadModelWithThread(),
        makeLoop({ active: true, prompt: "fix tests", iteration: 1 }),
      ),
      [
        makeTurnSignalEvent({
          type: "thread.turn-queued",
          messageId: "msg-queued-1",
          purpose: LOOP_ITERATION_PURPOSE,
        }),
      ],
    );

    const events = await decide(
      readModel,
      turnStartCommand(
        "cmd-turn-start-replace-queued",
        "msg-user-replace-queued",
        "refine the prompt",
      ),
    );
    expect(events[0]?.type).toBe("thread.turn-start-cancelled");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      messageId: asMessageId("msg-queued-1"),
    });
    expect(events[1]?.type).toBe("thread.loop-off");
    expect(events[1]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      stopReason: "replaced_by_manual_policy",
      loop: { active: false, lastStopReason: "replaced_by_manual_policy" },
    });
    expect(events[2]?.type).toBe("thread.message-sent");
    const messagePayload = events[2]?.payload as { purpose?: unknown; text?: string };
    expect(messagePayload.purpose).toBeUndefined();
    expect(messagePayload.text).toBe("refine the prompt");
    expect(events[3]?.type).toBe("thread.turn-start-requested");
    const turnPayload = events[3]?.payload as { purpose?: unknown; messageId?: string };
    expect(turnPayload.purpose).toBeUndefined();
    expect(turnPayload.messageId).toBe(asMessageId("msg-user-replace-queued"));
  });

  it("emits thread.loop-off on thread.turn.interrupt when the active turn is loop-owned", async () => {
    const readModel = await addActiveTurn(await projectLoopSet(await makeReadModelWithThread()), {
      turnId: "turn-loop-1",
      messageId: "msg-loop-user-1",
      purpose: LOOP_ITERATION_PURPOSE,
    });

    const events = await decide(readModel, turnInterruptCommand("cmd-turn-interrupt-loop"));
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

    const events = await decide(readModel, turnInterruptCommand("cmd-turn-interrupt-manual"));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.turn-interrupt-requested");
  });

  it("thread.loop.continue emits loop message, turn request, and continued event", async () => {
    const readModel = await projectLoopSet(await makeReadModelWithThread());

    const events = await decide(readModel, loopContinueCommand("cmd-loop-continue"));
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("thread.message-sent");
    expect(events[1]?.type).toBe("thread.turn-start-requested");
    expect(events[2]?.type).toBe("thread.loop-continued");

    expect(events[0]?.payload).toMatchObject({
      purpose: { kind: "loop-iteration", iteration: 1 },
      // Deterministic: at-least-once command execution must mint the same id.
      messageId: "loop-msg:cmd-loop-continue",
    });
    expect(events[1]?.payload).toMatchObject({
      purpose: { kind: "loop-iteration", iteration: 1 },
    });
    expect(events[2]?.payload).toMatchObject({ nextIteration: 1, nextConsecutiveErrors: 0 });
  });
});

describe("durable pending loop start cancellation", () => {
  async function readModelWithPendingLoopStart(options: { purpose?: ThreadTurnPurpose } = {}) {
    return await projectAll(await projectLoopSet(await makeReadModelWithThread()), [
      makeTurnSignalEvent({
        type: "thread.turn-start-requested",
        messageId: "msg-pending-loop-1",
        purpose: options.purpose ?? LOOP_ITERATION_PURPOSE,
      }),
    ]);
  }

  it("thread.loop.off retires a pending loop-owned start durably", async () => {
    const readModel = await readModelWithPendingLoopStart();
    const events = await decide(readModel, loopOffCommand("cmd-loop-off-pending", "user_stop"));
    expect(events[0]?.type).toBe("thread.turn-start-cancelled");
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-loop"),
      messageId: asMessageId("msg-pending-loop-1"),
      purpose: LOOP_ITERATION_PURPOSE,
    });
    expect(events[1]?.type).toBe("thread.loop-off");
  });

  it("thread.loop.set reconfigure retires the outgoing activation's pending start", async () => {
    const readModel = await readModelWithPendingLoopStart();
    const events = await decide(
      readModel,
      loopSetCommand("cmd-loop-reconfigure-pending", { prompt: "new objective" }),
    );
    expect(events[0]?.type).toBe("thread.turn-start-cancelled");
    expect(events[0]?.payload).toMatchObject({ messageId: asMessageId("msg-pending-loop-1") });
    expect(events[1]?.type).toBe("thread.loop-set");
    expect(events[1]?.payload).toMatchObject({
      loop: { activationId: "cmd-loop-reconfigure-pending", iteration: 0 },
    });
  });

  it("thread.loop.toggle off retires a pending loop-owned start", async () => {
    const readModel = await readModelWithPendingLoopStart();
    const events = await decide(readModel, loopToggleCommand("cmd-loop-toggle-pending"));
    expect(events[0]?.type).toBe("thread.turn-start-cancelled");
    expect(events[1]?.type).toBe("thread.loop-off");
    expect(events[1]?.payload).toMatchObject({ stopReason: "toggled_off" });
  });

  it("does not cancel an unrelated manual pending start on loop off", async () => {
    const readModel = await projectAll(await projectLoopSet(await makeReadModelWithThread()), [
      makeTurnSignalEvent({
        type: "thread.turn-start-requested",
        messageId: "msg-pending-manual-1",
      }),
    ]);
    const events = await decide(readModel, loopOffCommand("cmd-loop-off-manual", "user_stop"));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.loop-off");
  });

  it("thread.turn.cancel-start settles the exact pending start", async () => {
    const readModel = await readModelWithPendingLoopStart();
    const events = await decide(readModel, {
      type: "thread.turn.cancel-start",
      commandId: asCommandId("cmd-cancel-start-1"),
      threadId: asThreadId("thread-loop"),
      messageId: asMessageId("msg-pending-loop-1"),
      purpose: LOOP_ITERATION_PURPOSE,
      createdAt: NOW,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.turn-start-cancelled");
    expect(events[0]?.payload).toMatchObject({
      messageId: asMessageId("msg-pending-loop-1"),
      purpose: LOOP_ITERATION_PURPOSE,
    });
  });

  it("thread.turn.cancel-start is a no-op when a newer pending start replaced the message", async () => {
    const readModel = await projectAll(await readModelWithPendingLoopStart(), [
      makeTurnSignalEvent({
        type: "thread.turn-start-requested",
        messageId: "msg-pending-newer-1",
      }),
    ]);
    const events = await decide(readModel, {
      type: "thread.turn.cancel-start",
      commandId: asCommandId("cmd-cancel-start-stale"),
      threadId: asThreadId("thread-loop"),
      messageId: asMessageId("msg-pending-loop-1"),
      createdAt: NOW,
    });
    expect(events).toHaveLength(0);
  });

  it("projecting the cancellation clears the matching pending start only", async () => {
    const readModel = await readModelWithPendingLoopStart();
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-loop"));
    expect(thread?.pendingTurnStart?.messageId).toBe(asMessageId("msg-pending-loop-1"));

    const cleared = await projectAll(readModel, [
      makeEvent({
        type: "thread.turn-start-cancelled",
        payload: {
          threadId: "thread-loop",
          messageId: "msg-pending-loop-1",
          purpose: LOOP_ITERATION_PURPOSE,
          createdAt: NOW,
        },
      }),
    ]);
    const clearedThread = cleared.threads.find((entry) => entry.id === asThreadId("thread-loop"));
    expect(clearedThread?.pendingTurnStart).toBeNull();
    expect(clearedThread?.hasPendingTurnStart).toBe(false);

    // A cancellation for a different message never clears the pending start.
    const mismatched = await projectAll(readModel, [
      makeEvent({
        type: "thread.turn-start-cancelled",
        payload: {
          threadId: "thread-loop",
          messageId: "msg-other-1",
          createdAt: NOW,
        },
      }),
    ]);
    const unchangedThread = mismatched.threads.find(
      (entry) => entry.id === asThreadId("thread-loop"),
    );
    expect(unchangedThread?.pendingTurnStart?.messageId).toBe(asMessageId("msg-pending-loop-1"));
  });
});
