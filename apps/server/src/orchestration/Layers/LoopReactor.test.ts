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
import { makeLoop as makeLoopFixture } from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Option, Queue, Ref, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

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
  return makeLoopFixture({
    prompt: "fix the tests",
    iteration: 0,
    maxIterations: null,
    activationId: "loop-activation",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function loopIterationPurpose(iteration: number): ThreadTurnPurpose {
  return {
    kind: "loop-iteration",
    activationId: "loop-activation",
    iteration,
  } as ThreadTurnPurpose;
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
  hasPendingApprovals?: boolean;
}): OrchestrationThread {
  return {
    id: asThreadId("thread-1"),
    loop: options.loop ?? makeLoop(),
    messages: options.messages ?? [],
    hasPendingTurnStart: options.hasPendingTurnStart ?? false,
    hasPendingApprovals: options.hasPendingApprovals ?? false,
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

function makeLoopOffEvent(loop: ThreadLoop): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    type: "thread.loop-off",
    payload: {
      threadId: asThreadId("thread-1"),
      stopReason: "user_stop",
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

interface ReactorScenario {
  offer: (event: OrchestrationEvent) => Promise<void>;
  restore: () => Promise<void>;
  // Advances the TestClock so timer sleeps fire and the event pump settles.
  advance: (millis: number) => Promise<void>;
  commands: () => Promise<OrchestrationCommand[]>;
  commandsOfType: (type: OrchestrationCommand["type"]) => Promise<OrchestrationCommand[]>;
}

async function withReactor(
  thread: OrchestrationThread,
  body: (scenario: ReactorScenario) => Promise<void>,
  options: { start?: boolean } = {},
): Promise<void> {
  const {
    eventQueue,
    dispatchLog,
    fakeEngine,
    fakeSnapshotQuery,
    fakeProjectionTurnRepository,
    fakeQueuedTurnPromotionRepository,
    fakeProjectionThreadLoopRepository,
  } = makeFakes(makeSnapshot(thread), Option.some(thread));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
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
      TestClock.layer(),
    ),
  );
  await runtime.runPromise(Effect.scoped(TestClock.setTime(Date.parse(now))));
  const reactor = await runtime.runPromise(Effect.service(LoopReactor));
  const scope = await runtime.runPromise(Scope.make("sequential"));
  if (options.start !== false) {
    await runtime.runPromise(reactor.start.pipe(Scope.provide(scope)));
  }
  const scenario: ReactorScenario = {
    offer: (event) => runtime.runPromise(Queue.offer(eventQueue, event)).then(() => undefined),
    restore: () => runtime.runPromise(reactor.restoreActiveLoops).then(() => undefined),
    advance: (millis) => runtime.runPromise(Effect.scoped(TestClock.adjust(`${millis} millis`))),
    commands: () => runtime.runPromise(Ref.get(dispatchLog)).then((commands) => [...commands]),
    commandsOfType: async (type) => {
      const commands = await runtime.runPromise(Ref.get(dispatchLog));
      return commands.filter((command) => command.type === type);
    },
  };
  try {
    await body(scenario);
  } finally {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  }
}

describe("LoopReactor", () => {
  it("dispatches arm continue on thread.loop-set when loop is active", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeLoopSetEvent(loop));
      await advance(50);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues.length).toBeGreaterThan(0);
      expect(loopContinues[loopContinues.length - 1]).toMatchObject({
        threadId: thread.id,
        commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
        expectedUpdatedAt: loop.updatedAt,
        expectedActivationId: loop.activationId,
      });
    });
  });

  it("dispatches continue on session settlement when the latest loop-owned turn completed", async () => {
    const loop = makeLoop();
    const thread = makeThread({
      loop,
      messages: [
        makeMessage({ role: "user", turnId: "turn-1", purpose: loopIterationPurpose(1) }),
        makeMessage({ role: "assistant", turnId: "turn-1" }),
      ],
      session: makeSession({ status: "ready", activeTurnId: null }),
      latestTurn: makeLatestTurn({
        turnId: "turn-1",
        state: "completed",
        purpose: loopIterationPurpose(1),
      }),
    });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(
        makeSessionSetEvent({ session: makeSession({ status: "ready", activeTurnId: null }) }),
      );
      await advance(50);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues.length).toBeGreaterThan(0);
      expect(loopContinues[loopContinues.length - 1]).toMatchObject({
        threadId: thread.id,
        commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
        expectedUpdatedAt: loop.updatedAt,
      });
    });
  });

  it("dispatches continue on session settlement using latestTurn when assistant message is missing", async () => {
    const loop = makeLoop();
    const thread = makeThread({
      loop,
      messages: [makeMessage({ role: "user", purpose: loopIterationPurpose(1) })],
      session: makeSession({ status: "ready", activeTurnId: null }),
      latestTurn: {
        turnId: asTurnId("turn-1"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: asMessageId("missing-assistant"),
        purpose: loopIterationPurpose(1),
      },
    });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(
        makeSessionSetEvent({ session: makeSession({ status: "ready", activeTurnId: null }) }),
      );
      await advance(50);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues.length).toBeGreaterThan(0);
      expect(loopContinues[loopContinues.length - 1]).toMatchObject({
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
      });
    });
  });

  it("dispatches continue on approval.resolved activity when loop is active", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeActivityAppendedEvent("approval.resolved"));
      await advance(50);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues.length).toBeGreaterThan(0);
      expect(loopContinues[loopContinues.length - 1]).toMatchObject({
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
      });
    });
  });

  it("dispatches thread.loop.off with thread_archived on thread.archived", async () => {
    const thread = makeThread({ loop: makeLoop() });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeArchivedEvent());
      await advance(50);
      const offCommands = await commandsOfType("thread.loop.off");
      expect(offCommands.length).toBeGreaterThan(0);
      expect(offCommands[offCommands.length - 1]).toMatchObject({
        threadId: thread.id,
        reason: "thread_archived",
      });
    });
  });

  it("dispatches thread.loop.off with thread_deleted on thread.deleted", async () => {
    const thread = makeThread({ loop: makeLoop() });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeDeletedEvent());
      await advance(50);
      const offCommands = await commandsOfType("thread.loop.off");
      expect(offCommands.length).toBeGreaterThan(0);
      expect(offCommands[offCommands.length - 1]).toMatchObject({
        threadId: thread.id,
        reason: "thread_deleted",
      });
    });
  });

  it("dispatches startup restore for active loop via restoreActiveLoops", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    await withReactor(
      thread,
      async ({ restore, commandsOfType }) => {
        await restore();
        const loopContinues = await commandsOfType("thread.loop.continue");
        expect(loopContinues[0]).toBeDefined();
        expect(loopContinues[0]).toMatchObject({
          commandId: `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}`,
          expectedUpdatedAt: loop.updatedAt,
          expectedActivationId: loop.activationId,
        });
      },
      { start: false },
    );
  });

  it("ignores thread.session-set from restart reconciliation and leaves startup restore to restoreActiveLoops", async () => {
    const thread = makeThread({
      loop: makeLoop(),
      session: makeSession({ status: "interrupted", activeTurnId: null }),
      latestTurn: makeLatestTurn({ turnId: "turn-1", state: "interrupted" }),
    });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(
        makeSessionSetEvent({
          commandId: `restart-reconcile:${thread.id}:now`,
          session: makeSession({ status: "interrupted", activeTurnId: null }),
        }),
      );
      await advance(50);
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(0);
    });
  });

  it("dispatches continue for thread.session-set when a loop-owned turn is aborted", async () => {
    const loop = makeLoop();
    const thread = makeThread({
      loop,
      messages: [
        makeMessage({ role: "user", turnId: "turn-1", purpose: loopIterationPurpose(1) }),
        makeMessage({ role: "assistant", turnId: "turn-1" }),
      ],
      session: makeSession({ status: "interrupted", activeTurnId: null }),
      latestTurn: makeLatestTurn({
        turnId: "turn-1",
        state: "interrupted",
        purpose: loopIterationPurpose(1),
      }),
    });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(
        makeSessionSetEvent({
          commandId: "provider:evt:thread-session-set:thread-1",
          session: makeSession({ status: "interrupted", activeTurnId: null }),
        }),
      );
      await advance(50);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues[0]).toBeDefined();
      expect(loopContinues[0]).toMatchObject({
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
      });
    });
  });

  it("dispatches continue at endsAt for a duration loop blocked on approval", async () => {
    const loop = makeLoop({ endsAt: new Date(Date.parse(now) + 150).toISOString() });
    const thread = makeThread({ loop, hasPendingApprovals: true });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeLoopSetEvent(loop));
      await advance(50);

      // Blocked on approval: the arm-time pre-check waits, so nothing dispatches
      // before expiry.
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(0);

      await advance(300);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues).toHaveLength(1);
      expect(loopContinues[0]).toMatchObject({
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
        expectedActivationId: loop.activationId,
      });
    });
  });

  it("cancels the expiry timer when the loop is turned off before endsAt", async () => {
    const loop = makeLoop({ endsAt: new Date(Date.parse(now) + 150).toISOString() });
    const thread = makeThread({ loop, hasPendingApprovals: true });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeLoopSetEvent(loop));
      await offer(makeLoopOffEvent(makeLoop({ ...loop, active: false })));
      await advance(300);
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(0);
    });
  });

  it("arms the expiry timer for duration loops restored on startup", async () => {
    const loop = makeLoop({ endsAt: new Date(Date.parse(now) + 150).toISOString() });
    const thread = makeThread({ loop, hasPendingApprovals: true });
    await withReactor(thread, async ({ restore, advance, commandsOfType }) => {
      await restore();

      // Restore pre-check waits (approval pending, endsAt not reached), so the
      // only dispatch must come from the timer firing at endsAt.
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(0);

      await advance(300);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues).toHaveLength(1);
      expect(loopContinues[0]).toMatchObject({
        threadId: thread.id,
        expectedActivationId: loop.activationId,
      });
    });
  });

  it("does not dispatch continue while a queued turn start is pending", async () => {
    const thread = makeThread({
      loop: makeLoop({ iteration: 2, consecutiveErrors: 1 }),
      messages: [
        makeMessage({ role: "user", turnId: "turn-1", purpose: loopIterationPurpose(1) }),
        makeMessage({ role: "assistant", turnId: "turn-1" }),
      ],
      session: makeSession({ status: "ready", activeTurnId: null }),
      latestTurn: makeLatestTurn({
        turnId: "turn-1",
        state: "error",
        purpose: loopIterationPurpose(1),
      }),
      hasPendingTurnStart: true,
    });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(
        makeSessionSetEvent({
          commandId: "provider:evt:thread-session-set:thread-1",
          session: makeSession({ status: "ready", activeTurnId: null }),
        }),
      );
      await advance(50);
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(0);
    });
  });
});
