import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThreadRevertSaga,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-revert-saga");
const SAGA_ID = "saga-1";

const SAGA_IN_PROGRESS_ERROR =
  "Thread 'thread-revert-saga' has a revert saga in progress. Wait for it to finish before starting a turn.";

function makeReadModel(input?: {
  readonly revertSaga?: OrchestrationThreadRevertSaga | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-revert-saga"),
        title: "Revert saga",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        revertSaga: input?.revertSaga ?? null,
        handoff: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function activeSaga(
  status: OrchestrationThreadRevertSaga["status"],
): OrchestrationThreadRevertSaga {
  return { status, turnCount: 1, sagaId: SAGA_ID };
}

function revertStartedCommand() {
  return {
    type: "thread.revert.started" as const,
    commandId: CommandId.makeUnsafe("cmd-revert-started"),
    threadId: THREAD_ID,
    turnCount: 1,
    sagaId: SAGA_ID,
    createdAt: NOW,
  };
}

function revertUncertainCommand() {
  return {
    type: "thread.revert.uncertain" as const,
    commandId: CommandId.makeUnsafe("cmd-revert-uncertain"),
    threadId: THREAD_ID,
    turnCount: 1,
    sagaId: SAGA_ID,
    stepId: "step-fs-restore",
    detail: "queue item outcome unknown after restart",
    createdAt: NOW,
  };
}

function turnStartCommand() {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.makeUnsafe("cmd-turn-start"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.makeUnsafe("message-during-saga"),
      role: "user" as const,
      text: "race the saga",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access" as const,
    createdAt: NOW,
  };
}

describe("revert saga decider", () => {
  it("emits thread.revert-started for the thread.revert.started command", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: revertStartedCommand(),
        readModel: makeReadModel(),
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.revert-started",
      payload: {
        threadId: THREAD_ID,
        turnCount: 1,
        sagaId: SAGA_ID,
      },
    });
  });

  it("rejects thread.revert.started while a saga is already active", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: revertStartedCommand(),
          readModel: makeReadModel({ revertSaga: activeSaga("reverting") }),
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.revert.started",
      detail: `Thread '${THREAD_ID}' already has an active revert saga.`,
    });
  });

  it("emits thread.revert-uncertain for the thread.revert.uncertain command", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: revertUncertainCommand(),
        readModel: makeReadModel({ revertSaga: activeSaga("reverting") }),
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.revert-uncertain",
      payload: {
        threadId: THREAD_ID,
        turnCount: 1,
        sagaId: SAGA_ID,
        stepId: "step-fs-restore",
        detail: "queue item outcome unknown after restart",
      },
    });
  });

  it.each([{ status: "reverting" as const }, { status: "uncertain" as const }])(
    "rejects thread.turn.start while the revert saga is $status",
    async ({ status }) => {
      const error = await Effect.runPromise(
        Effect.flip(
          decideOrchestrationCommand({
            command: turnStartCommand(),
            readModel: makeReadModel({ revertSaga: activeSaga(status) }),
          }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.turn.start",
        detail: SAGA_IN_PROGRESS_ERROR,
      });
    },
  );

  it("rejects thread.turn.dispatch-queued while a revert saga is active", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.dispatch-queued",
            commandId: CommandId.makeUnsafe("cmd-dispatch-during-saga"),
            threadId: THREAD_ID,
            messageId: MessageId.makeUnsafe("message-queued"),
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            dispatchMode: "queue",
            createdAt: NOW,
          },
          readModel: makeReadModel({ revertSaga: activeSaga("reverting") }),
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.dispatch-queued",
      detail: SAGA_IN_PROGRESS_ERROR,
    });
  });

  it("rejects thread.message.edit-and-resend while a revert saga is active", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.message.edit-and-resend",
            commandId: CommandId.makeUnsafe("cmd-edit-during-saga"),
            threadId: THREAD_ID,
            messageId: MessageId.makeUnsafe("message-during-saga"),
            text: "edited",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel: makeReadModel({ revertSaga: activeSaga("reverting") }),
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.message.edit-and-resend",
      detail: SAGA_IN_PROGRESS_ERROR,
    });
  });

  it("allows thread.turn.start again once thread.reverted clears the saga", async () => {
    const sagaReadModel = makeReadModel({ revertSaga: activeSaga("reverting") });
    const decidedComplete = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.revert.complete",
          commandId: CommandId.makeUnsafe("cmd-revert-complete"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: NOW,
        },
        readModel: sagaReadModel,
      }),
    );
    const completeEvents = Array.isArray(decidedComplete) ? decidedComplete : [decidedComplete];
    expect(completeEvents.map((event) => event.type)).toEqual([
      "thread.reverted",
      "thread.activity-appended",
    ]);

    let readModel = sagaReadModel;
    for (const [index, event] of completeEvents.entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: index + 2 }),
      );
    }
    expect(readModel.threads[0]?.revertSaga).toBeNull();

    const decidedTurn = await Effect.runPromise(
      decideOrchestrationCommand({
        command: turnStartCommand(),
        readModel,
      }),
    );
    const turnEvents = Array.isArray(decidedTurn) ? decidedTurn : [decidedTurn];
    expect(turnEvents.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});

describe("revert saga projector", () => {
  it("projects thread.revert-started into the reverting state", async () => {
    const initialReadModel = makeReadModel();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: revertStartedCommand(),
        readModel: initialReadModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...events[0]!, sequence: 2 }),
    );

    expect(readModel.threads[0]?.revertSaga).toEqual({
      status: "reverting",
      turnCount: 1,
      sagaId: SAGA_ID,
    });
  });

  it("projects thread.revert-uncertain into the uncertain state", async () => {
    const initialReadModel = makeReadModel({ revertSaga: activeSaga("reverting") });
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: revertUncertainCommand(),
        readModel: initialReadModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...events[0]!, sequence: 2 }),
    );

    expect(readModel.threads[0]?.revertSaga).toEqual({
      status: "uncertain",
      turnCount: 1,
      sagaId: SAGA_ID,
    });
  });

  it("clears the revert saga when thread.reverted is projected", async () => {
    const initialReadModel = makeReadModel({ revertSaga: activeSaga("uncertain") });
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.revert.complete",
          commandId: CommandId.makeUnsafe("cmd-revert-complete-clear"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: NOW,
        },
        readModel: initialReadModel,
      }),
    );
    const revertedEvent = (Array.isArray(decided) ? decided : [decided]).find(
      (event) => event.type === "thread.reverted",
    )!;

    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...revertedEvent, sequence: 2 }),
    );

    expect(readModel.threads[0]?.revertSaga).toBeNull();
  });
});
