import type {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId,
  ThreadLoop,
  ThreadTurnPurpose,
  TurnId,
} from "@synara/contracts";
import { LOOP_DEFAULT_HARD_CAP } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Option, Queue, Ref, Scope, Stream } from "effect";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  QueuedTurnPromotionRepository,
  type QueuedTurnPromotionRepositoryShape,
} from "../../persistence/Services/QueuedTurnPromotions.ts";
import {
  ProjectionThreadLoopRepository,
  type ProjectionThreadLoopRepositoryShape,
} from "../../persistence/Services/ProjectionThreadLoop.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { LoopReactor } from "../Services/LoopReactor.ts";
import { LoopReactorLive } from "./LoopReactor.ts";

const now = "2026-07-19T12:00:00.000Z";

function asThreadId(value: string) {
  return value as unknown as ThreadId;
}

function asTurnId(value: string) {
  return value as unknown as TurnId;
}

function asMessageId(value: string) {
  return value as unknown as MessageId;
}

function asEventId(value: string) {
  return value as unknown as EventId;
}

function asCommandId(value: string) {
  return value as unknown as CommandId;
}

function makeLoop(overrides?: Partial<ThreadLoop>): ThreadLoop {
  return {
    active: true,
    prompt: "fix the tests",
    iteration: 0,
    maxIterations: null,
    endsAt: null,
    hardCap: LOOP_DEFAULT_HARD_CAP,
    consecutiveErrors: 0,
    lastStopReason: null,
    activationId: "loop-activation",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ThreadLoop;
}

function makeMessage(options: {
  role: "user" | "assistant";
  turnId?: string;
  purpose?: ThreadTurnPurpose;
}) {
  return {
    id: asMessageId("msg-" + Math.random().toString(36).slice(2)),
    role: options.role,
    text: "x",
    turnId: options.turnId ? asTurnId(options.turnId) : null,
    streaming: false,
    source: "native",
    purpose: options.purpose,
    createdAt: now,
    updatedAt: now,
  };
}

function makeThread(options: {
  loop?: ThreadLoop | null;
  messages?: unknown[];
  latestTurn?: unknown;
  session?: unknown;
  hasPendingTurnStart?: boolean;
}): OrchestrationThread {
  return {
    id: asThreadId("thread-1"),
    loop: options.loop ?? makeLoop(),
    messages: options.messages ?? [],
    hasPendingTurnStart: options.hasPendingTurnStart ?? false,
    ...(options.latestTurn ? { latestTurn: options.latestTurn } : {}),
    ...(options.session ? { session: options.session } : {}),
  } as unknown as OrchestrationThread;
}

function makeBaseEventFields() {
  return {
    sequence: 1,
    eventId: asEventId("evt-1"),
    aggregateKind: "thread" as const,
    aggregateId: asThreadId("thread-1"),
    occurredAt: now,
    commandId: asCommandId("cmd-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function makeLoopSetEvent(loop: ThreadLoop): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    type: "thread.loop-set",
    payload: {
      threadId: asThreadId("thread-1"),
      loop,
    },
  } as unknown as OrchestrationEvent;
}

function makeSession(options: {
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  activeTurnId?: string | null;
}): unknown {
  return {
    threadId: asThreadId("thread-1"),
    status: options.status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: options.activeTurnId != null ? asTurnId(options.activeTurnId) : null,
    lastError: null,
    updatedAt: now,
  };
}

function makeLatestTurn(options: {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  purpose?: ThreadTurnPurpose;
}): unknown {
  return {
    turnId: asTurnId(options.turnId),
    state: options.state,
    requestedAt: now,
    startedAt: now,
    completedAt: options.state === "running" ? null : now,
    assistantMessageId: asMessageId("msg-assistant"),
    ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
  };
}

function makeSessionSetEvent(options: {
  commandId?: string;
  session: unknown;
}): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    commandId: asCommandId(options.commandId ?? "cmd-session-set"),
    type: "thread.session-set",
    payload: {
      threadId: asThreadId("thread-1"),
      session: options.session,
    },
  } as unknown as OrchestrationEvent;
}

function makeArchivedEvent(): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    type: "thread.archived",
    payload: {
      threadId: asThreadId("thread-1"),
      archivedAt: now,
      updatedAt: now,
    },
  } as unknown as OrchestrationEvent;
}

function makeDeletedEvent(): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    type: "thread.deleted",
    payload: {
      threadId: asThreadId("thread-1"),
      deletedAt: now,
    },
  } as unknown as OrchestrationEvent;
}

function makeActivityAppendedEvent(kind: string): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    type: "thread.activity-appended",
    payload: {
      threadId: asThreadId("thread-1"),
      activity: {
        id: asEventId("activity-1"),
        tone: "approval",
        kind,
        summary: "activity",
        payload: {},
        turnId: null,
        createdAt: now,
      },
    },
  } as unknown as OrchestrationEvent;
}

function makeSnapshot(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    threads: [thread],
  } as unknown as OrchestrationReadModel;
}

function makeFakes(snapshot: OrchestrationReadModel, thread: Option.Option<OrchestrationThread>) {
  const eventQueue = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
  const dispatchLog = Effect.runSync(Ref.make<OrchestrationCommand[]>([]));

  const fakeEngine: OrchestrationEngineShape = {
    quiesce: Effect.void,
    drain: Effect.void,
    stop: Effect.void,
    getCatchUpStatus: Effect.succeed({
      state: "healthy",
      inFlight: false,
      retryAttempts: 0,
      lastFailure: null,
    } as const),
    dispatch: (command: OrchestrationCommand) =>
      Ref.update(dispatchLog, (commands) => [...commands, command]).pipe(
        Effect.as({ sequence: 1 }),
      ),
    refreshCommandReadModel: () =>
      Effect.succeed({ threads: [] } as unknown as OrchestrationReadModel),
    streamDomainEvents: Stream.fromQueue(eventQueue),
  } as unknown as OrchestrationEngineShape;

  const fakeSnapshotQuery: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.succeed({ threads: [] } as unknown as OrchestrationReadModel),
    getSnapshot: () => Effect.succeed(snapshot),
    getCounts: () => Effect.succeed({ threadCount: 0, projectCount: 0 } as unknown as never),
    getSnapshotSequence: () => Effect.succeed({ sequence: 0, updatedAt: now } as unknown as never),
    getShellSnapshot: () =>
      Effect.succeed({
        threads: snapshot.threads as unknown as ReadonlyArray<OrchestrationThreadShell>,
        snapshotSequence: { sequence: 0, updatedAt: now },
      } as unknown as never),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    listGeneratedImageActivitiesByTurn: () => Effect.succeed([]),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () =>
      Effect.succeed(thread as unknown as Option.Option<OrchestrationThreadShell>),
    findSyntheticSubagentParentThread: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(thread),
    getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
    getThreadDetailForExportById: () => Effect.succeed(Option.none()),
  } as unknown as ProjectionSnapshotQueryShape;

  const fakeProjectionTurnRepository: ProjectionTurnRepositoryShape = {
    upsertByTurnId: () => Effect.void,
    replacePendingTurnStart: () => Effect.void,
    getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
    deletePendingTurnStartByThreadId: () => Effect.void,
    listByThreadId: () => Effect.succeed([]),
    getByTurnId: () => Effect.succeed(Option.none()),
    clearCheckpointTurnConflict: () => Effect.void,
    deleteByThreadId: () => Effect.void,
  } as unknown as ProjectionTurnRepositoryShape;

  const fakeQueuedTurnPromotionRepository: QueuedTurnPromotionRepositoryShape = {
    getBySequence: () => Effect.succeed(Option.none()),
    enqueue: () => Effect.void,
    claimNext: () => Effect.succeed(Option.none()),
    markPromoted: () => Effect.succeed(true),
    releaseClaim: () => Effect.succeed(true),
    cancelMessage: () => Effect.succeed(true),
    cancelThread: () => Effect.void,
    hasPendingMessage: () => Effect.succeed(false),
    listPendingThreadIds: () => Effect.succeed([]),
  } as unknown as QueuedTurnPromotionRepositoryShape;

  const fakeProjectionThreadLoopRepository: ProjectionThreadLoopRepositoryShape = {
    upsert: () => Effect.void,
    getByThreadId: () =>
      Effect.succeed(
        Option.isSome(thread)
          ? Option.some({
              threadId: thread.value.id,
              loop: thread.value.loop ?? makeLoop(),
              updatedAt: now,
            })
          : Option.none(),
      ),
    deleteByThreadId: () => Effect.void,
  } as unknown as ProjectionThreadLoopRepositoryShape;

  return {
    eventQueue,
    dispatchLog,
    fakeEngine,
    fakeSnapshotQuery,
    fakeProjectionTurnRepository,
    fakeQueuedTurnPromotionRepository,
    fakeProjectionThreadLoopRepository,
  };
}

function makeRuntime(snapshot: OrchestrationReadModel, thread: Option.Option<OrchestrationThread>) {
  const {
    eventQueue,
    dispatchLog,
    fakeEngine,
    fakeSnapshotQuery,
    fakeProjectionTurnRepository,
    fakeQueuedTurnPromotionRepository,
    fakeProjectionThreadLoopRepository,
  } = makeFakes(snapshot, thread);
  const runtime = ManagedRuntime.make(
    Layer.provide(
      LoopReactorLive,
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, fakeEngine),
        Layer.succeed(ProjectionSnapshotQuery, fakeSnapshotQuery),
        Layer.succeed(ProjectionTurnRepository, fakeProjectionTurnRepository),
        Layer.succeed(QueuedTurnPromotionRepository, fakeQueuedTurnPromotionRepository),
        Layer.succeed(ProjectionThreadLoopRepository, fakeProjectionThreadLoopRepository),
      ),
    ),
  );
  return { runtime, eventQueue, dispatchLog };
}

describe("LoopReactor", () => {
  it("dispatches arm continue on thread.loop-set when loop is active", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(Queue.offer(eventQueue, makeLoopSetEvent(loop)));
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const loopContinues = commands.filter((command) => command.type === "thread.loop.continue");
    expect(loopContinues.length).toBeGreaterThan(0);
    const continueCommand = loopContinues[loopContinues.length - 1];
    expect(continueCommand).toMatchObject({
      threadId: thread.id,
      commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
      expectedUpdatedAt: loop.updatedAt,
      expectedActivationId: loop.activationId,
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches continue on session settlement when the latest loop-owned turn completed", async () => {
    const loop = makeLoop();
    const _turnId = asTurnId("turn-1");
    const thread = makeThread({
      loop,
      messages: [
        makeMessage({
          role: "user",
          turnId: "turn-1",
          purpose: {
            kind: "loop-iteration",
            activationId: "loop-activation",
            iteration: 1,
          },
        }),
        makeMessage({ role: "assistant", turnId: "turn-1" }),
      ],
      session: makeSession({ status: "ready", activeTurnId: null }),
      latestTurn: makeLatestTurn({
        turnId: "turn-1",
        state: "completed",
        purpose: {
          kind: "loop-iteration",
          activationId: "loop-activation",
          iteration: 1,
        },
      }),
    });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(
      Queue.offer(
        eventQueue,
        makeSessionSetEvent({
          session: makeSession({ status: "ready", activeTurnId: null }),
        }),
      ),
    );
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const loopContinues = commands.filter((command) => command.type === "thread.loop.continue");
    expect(loopContinues.length).toBeGreaterThan(0);
    const continueCommand = loopContinues[loopContinues.length - 1];
    expect(continueCommand).toMatchObject({
      threadId: thread.id,
      commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
      expectedUpdatedAt: loop.updatedAt,
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches continue on session settlement using latestTurn when assistant message is missing", async () => {
    const loop = makeLoop();
    const turnId = asTurnId("turn-1");
    const thread = makeThread({
      loop,
      messages: [
        makeMessage({
          role: "user",
          purpose: {
            kind: "loop-iteration",
            activationId: "loop-activation",
            iteration: 1,
          },
        }),
      ],
      session: makeSession({ status: "ready", activeTurnId: null }),
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: asMessageId("missing-assistant"),
        purpose: {
          kind: "loop-iteration",
          activationId: "loop-activation",
          iteration: 1,
        },
      },
    });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(
      Queue.offer(
        eventQueue,
        makeSessionSetEvent({
          session: makeSession({ status: "ready", activeTurnId: null }),
        }),
      ),
    );
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const loopContinues = commands.filter((command) => command.type === "thread.loop.continue");
    expect(loopContinues.length).toBeGreaterThan(0);
    const continueCommand = loopContinues[loopContinues.length - 1];
    expect(continueCommand).toMatchObject({
      threadId: thread.id,
      expectedUpdatedAt: loop.updatedAt,
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches continue on approval.resolved activity when loop is active", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(
      Queue.offer(eventQueue, makeActivityAppendedEvent("approval.resolved")),
    );
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const loopContinues = commands.filter((command) => command.type === "thread.loop.continue");
    expect(loopContinues.length).toBeGreaterThan(0);
    const continueCommand = loopContinues[loopContinues.length - 1];
    expect(continueCommand).toMatchObject({
      threadId: thread.id,
      expectedUpdatedAt: loop.updatedAt,
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches thread.loop.off with thread_archived on thread.archived", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(Queue.offer(eventQueue, makeArchivedEvent()));
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const offCommands = commands.filter((command) => command.type === "thread.loop.off");
    expect(offCommands.length).toBeGreaterThan(0);
    const offCommand = offCommands[offCommands.length - 1];
    expect(offCommand).toMatchObject({
      threadId: thread.id,
      reason: "thread_archived",
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches thread.loop.off with thread_deleted on thread.deleted", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(Queue.offer(eventQueue, makeDeletedEvent()));
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const offCommands = commands.filter((command) => command.type === "thread.loop.off");
    expect(offCommands.length).toBeGreaterThan(0);
    const offCommand = offCommands[offCommands.length - 1];
    expect(offCommand).toMatchObject({
      threadId: thread.id,
      reason: "thread_deleted",
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches startup restore for active loop via restoreActiveLoops", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const { runtime, dispatchLog } = makeRuntime(makeSnapshot(thread), Option.some(thread));

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    await Effect.runPromise(reactor.restoreActiveLoops);

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const continueCommand = commands.find((command) => command.type === "thread.loop.continue");
    expect(continueCommand).toBeDefined();
    expect(continueCommand).toMatchObject({
      commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
      expectedUpdatedAt: loop.updatedAt,
      expectedActivationId: loop.activationId,
    });

    await runtime.dispose();
  });

  it("ignores thread.session-set from restart reconciliation and leaves startup restore to restoreActiveLoops", async () => {
    const loop = makeLoop();
    const thread = makeThread({
      loop,
      session: makeSession({ status: "interrupted", activeTurnId: null }),
      latestTurn: makeLatestTurn({ turnId: "turn-1", state: "interrupted" }),
    });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(
      Queue.offer(
        eventQueue,
        makeSessionSetEvent({
          commandId: `restart-reconcile:${thread.id}:now`,
          session: makeSession({ status: "interrupted", activeTurnId: null }),
        }),
      ),
    );
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const continueCommand = commands.find((command) => command.type === "thread.loop.continue");
    expect(continueCommand).toBeUndefined();

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches continue for thread.session-set when a loop-owned turn is aborted", async () => {
    const loop = makeLoop();
    const turnId = asTurnId("turn-1");
    const thread = makeThread({
      loop,
      messages: [
        makeMessage({
          role: "user",
          turnId: turnId as unknown as string,
          purpose: {
            kind: "loop-iteration",
            activationId: "loop-activation",
            iteration: 1,
          },
        }),
        makeMessage({ role: "assistant", turnId: turnId as unknown as string }),
      ],
      session: makeSession({ status: "interrupted", activeTurnId: null }),
      latestTurn: makeLatestTurn({
        turnId: "turn-1",
        state: "interrupted",
        purpose: {
          kind: "loop-iteration",
          activationId: "loop-activation",
          iteration: 1,
        },
      }),
    });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(
      Queue.offer(
        eventQueue,
        makeSessionSetEvent({
          commandId: "provider:evt:thread-session-set:thread-1",
          session: makeSession({ status: "interrupted", activeTurnId: null }),
        }),
      ),
    );
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const continueCommand = commands.find((command) => command.type === "thread.loop.continue");
    expect(continueCommand).toBeDefined();
    expect(continueCommand).toMatchObject({
      threadId: thread.id,
      expectedUpdatedAt: loop.updatedAt,
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  it("dispatches continue on settlement even when loop.iteration advanced for a queued manual replacement", async () => {
    const loop = makeLoop({ iteration: 2, consecutiveErrors: 1 });
    const thread = makeThread({
      loop,
      messages: [
        makeMessage({
          role: "user",
          turnId: "turn-1",
          purpose: {
            kind: "loop-iteration",
            activationId: "loop-activation",
            iteration: 1,
          },
        }),
        makeMessage({ role: "assistant", turnId: "turn-1" }),
      ],
      session: makeSession({ status: "ready", activeTurnId: null }),
      latestTurn: makeLatestTurn({
        turnId: "turn-1",
        state: "error",
        purpose: {
          kind: "loop-iteration",
          activationId: "loop-activation",
          iteration: 1,
        },
      }),
      hasPendingTurnStart: true,
    });
    const { runtime, eventQueue, dispatchLog } = makeRuntime(
      makeSnapshot(thread),
      Option.some(thread),
    );

    const reactor = await runtime.runPromise(Effect.service(LoopReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    await Effect.runPromise(
      Queue.offer(
        eventQueue,
        makeSessionSetEvent({
          commandId: "provider:evt:thread-session-set:thread-1",
          session: makeSession({ status: "ready", activeTurnId: null }),
        }),
      ),
    );
    await Effect.runPromise(Effect.sleep("50 millis"));

    const commands = await Effect.runPromise(Ref.get(dispatchLog));
    const continueCommand = commands.find((command) => command.type === "thread.loop.continue");
    expect(continueCommand).toBeDefined();
    expect(continueCommand).toMatchObject({
      threadId: thread.id,
      commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
      expectedUpdatedAt: loop.updatedAt,
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });
});
