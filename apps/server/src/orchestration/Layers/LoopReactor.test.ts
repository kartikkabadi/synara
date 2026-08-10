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
import { LoopActivationId } from "@synara/contracts";
import { makeLoop as makeLoopFixture } from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
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
    activationId: LoopActivationId.makeUnsafe("loop-activation"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function loopIterationPurpose(iteration: number): ThreadTurnPurpose {
  return {
    kind: "loop-iteration",
    activationId: LoopActivationId.makeUnsafe("loop-activation"),
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

function makeLoopWaitNotedEvent(loop: ThreadLoop): OrchestrationEvent {
  return {
    ...makeBaseEventFields(),
    type: "thread.loop-wait-noted",
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

function makeFakes(
  snapshot: OrchestrationReadModel,
  thread: Option.Option<OrchestrationThread>,
  options: { dispatchFailures?: number } = {},
) {
  const eventQueue = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
  const dispatchLog = Effect.runSync(Ref.make<OrchestrationCommand[]>([]));
  let dispatchFailuresRemaining = options.dispatchFailures ?? 0;

  // Fakes implement only the members LoopReactor consumes.
  const fakeEngine: OrchestrationEngineShape = {
    dispatch: (command: OrchestrationCommand) => {
      if (dispatchFailuresRemaining > 0) {
        dispatchFailuresRemaining -= 1;
        return Effect.fail(new Error("dispatch unavailable"));
      }
      return Ref.update(dispatchLog, (commands) => [...commands, command]).pipe(
        Effect.as({ sequence: 1 }),
      );
    },
    streamDomainEvents: Stream.fromQueue(eventQueue),
  } as unknown as OrchestrationEngineShape;

  const fakeSnapshotQuery: ProjectionSnapshotQueryShape = {
    getSnapshot: () => Effect.succeed(snapshot),
    getShellSnapshot: () =>
      Effect.succeed({
        threads: snapshot.threads as unknown as ReadonlyArray<OrchestrationThreadShell>,
        snapshotSequence: { sequence: 0, updatedAt: now },
      } as unknown as never),
    getThreadShellById: () =>
      Effect.succeed(thread as unknown as Option.Option<OrchestrationThreadShell>),
  } as unknown as ProjectionSnapshotQueryShape;

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
    fakeProjectionThreadLoopRepository,
  };
}

interface ReactorScenario {
  offer: (event: OrchestrationEvent) => Promise<void>;
  restore: () => Promise<void>;
  advance: (millis: number) => Promise<void>;
  commands: () => Promise<OrchestrationCommand[]>;
  commandsOfType: <T extends OrchestrationCommand["type"]>(
    type: T,
  ) => Promise<Extract<OrchestrationCommand, { type: T }>[]>;
  expectLastDispatched: <T extends OrchestrationCommand["type"]>(
    type: T,
    match: Record<string, unknown>,
  ) => Promise<Extract<OrchestrationCommand, { type: T }>>;
}

async function withReactor(
  thread: OrchestrationThread,
  body: (scenario: ReactorScenario) => Promise<void>,
  options: { start?: boolean; dispatchFailures?: number } = {},
): Promise<void> {
  const {
    eventQueue,
    dispatchLog,
    fakeEngine,
    fakeSnapshotQuery,
    fakeProjectionThreadLoopRepository,
  } = makeFakes(makeSnapshot(thread), Option.some(thread), options);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.provide(
        LoopReactorLive,
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, fakeEngine),
          Layer.succeed(ProjectionSnapshotQuery, fakeSnapshotQuery),
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
    commandsOfType: async <T extends OrchestrationCommand["type"]>(type: T) => {
      const commands = await runtime.runPromise(Ref.get(dispatchLog));
      return commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: T }> => command.type === type,
      );
    },
    expectLastDispatched: async <T extends OrchestrationCommand["type"]>(
      type: T,
      match: Record<string, unknown>,
    ) => {
      const commands = await scenario.commandsOfType(type);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands[commands.length - 1]).toMatchObject(match);
      return commands[commands.length - 1]!;
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
    await withReactor(thread, async ({ offer, advance, expectLastDispatched }) => {
      await offer(makeLoopSetEvent(loop));
      await advance(50);
      const command = await expectLastDispatched("thread.loop.continue", {
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
        expectedActivationId: loop.activationId,
      });
      expect(command.commandId).toBe(
        `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}:${command.createdAt}`,
      );
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
    await withReactor(thread, async ({ offer, advance, expectLastDispatched }) => {
      await offer(
        makeSessionSetEvent({ session: makeSession({ status: "ready", activeTurnId: null }) }),
      );
      await advance(50);
      const command = await expectLastDispatched("thread.loop.continue", {
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
      });
      expect(command.commandId).toBe(
        `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}:${command.createdAt}`,
      );
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
    await withReactor(thread, async ({ offer, advance, expectLastDispatched }) => {
      await offer(
        makeSessionSetEvent({ session: makeSession({ status: "ready", activeTurnId: null }) }),
      );
      await advance(50);
      await expectLastDispatched("thread.loop.continue", {
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
      });
    });
  });

  it("dispatches continue on approval.resolved activity when loop is active", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    await withReactor(thread, async ({ offer, advance, expectLastDispatched }) => {
      await offer(makeActivityAppendedEvent("approval.resolved"));
      await advance(50);
      await expectLastDispatched("thread.loop.continue", {
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
      });
    });
  });

  it.each([
    ["thread_archived", makeArchivedEvent()],
    ["thread_deleted", makeDeletedEvent()],
  ] as const)("dispatches thread.loop.off with %s on lifecycle events", async (reason, event) => {
    const thread = makeThread({ loop: makeLoop() });
    await withReactor(thread, async ({ offer, advance, expectLastDispatched }) => {
      await offer(event);
      await advance(50);
      await expectLastDispatched("thread.loop.off", { threadId: thread.id, reason });
    });
  });

  it("keeps retrying a failed lifecycle off dispatch until cleanup is accepted", async () => {
    const thread = makeThread({ loop: makeLoop() });
    await withReactor(
      thread,
      async ({ offer, advance, commandsOfType }) => {
        await offer(makeArchivedEvent());

        // Drain the bounded inline retries. Persistent failures then move to
        // the supervised retry, which must recover without a second lifecycle
        // event or an unrelated thread trigger.
        for (let i = 0; i < 8; i += 1) {
          await advance(1_000);
        }
        expect(await commandsOfType("thread.loop.off")).toHaveLength(0);

        for (let i = 0; i < 10; i += 1) {
          await advance(30_000);
        }
        const commands = await commandsOfType("thread.loop.off");
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          threadId: thread.id,
          reason: "thread_archived",
        });
      },
      { dispatchFailures: 8 },
    );
  });

  it("dispatches startup restore for active loop via restoreActiveLoops", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    await withReactor(
      thread,
      async ({ restore, commandsOfType }) => {
        await restore();
        const loopContinues = await commandsOfType("thread.loop.continue");
        expect(loopContinues).toHaveLength(1);
        const command = loopContinues[0]!;
        expect(command).toMatchObject({
          expectedUpdatedAt: loop.updatedAt,
          expectedActivationId: loop.activationId,
        });
        expect(command.commandId).toBe(
          `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}:${command.createdAt}`,
        );
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

      // Arm-time dispatch goes through; the decider (not the reactor) settles
      // the approval-blocked wait. The reactor no longer pre-evaluates policy.
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(1);

      await advance(300);
      const loopContinues = await commandsOfType("thread.loop.continue");
      // The expiry timer issues a fresh dispatch at endsAt; the commandId now
      // includes the trigger timestamp. The decider turns the loop off because
      // the duration budget has been reached.
      expect(loopContinues).toHaveLength(2);
      const command = loopContinues[1]!;
      expect(command).toMatchObject({
        threadId: thread.id,
        expectedUpdatedAt: loop.updatedAt,
        expectedActivationId: loop.activationId,
      });
      expect(command.commandId).toBe(
        `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}:${command.createdAt}`,
      );
    });
  });

  it("cancels the expiry timer when the loop is turned off before endsAt", async () => {
    const loop = makeLoop({ endsAt: new Date(Date.parse(now) + 150).toISOString() });
    const thread = makeThread({ loop, hasPendingApprovals: true });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeLoopSetEvent(loop));
      await offer(makeLoopOffEvent(makeLoop({ ...loop, active: false })));
      await advance(300);
      // Only the arm-time dispatch happens; the cancelled timer must not add a
      // second one after endsAt.
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(1);
    });
  });

  it("arms the expiry timer for duration loops restored on startup", async () => {
    const loop = makeLoop({ endsAt: new Date(Date.parse(now) + 150).toISOString() });
    const thread = makeThread({ loop, hasPendingApprovals: true });
    await withReactor(thread, async ({ restore, advance, commandsOfType }) => {
      await restore();

      // Restore dispatches once immediately (the decider settles the wait), then
      // the timer fires a second dispatch at endsAt with a fresh commandId.
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(1);

      await advance(300);
      const loopContinues = await commandsOfType("thread.loop.continue");
      expect(loopContinues).toHaveLength(2);
      const command = loopContinues[1]!;
      expect(command).toMatchObject({
        threadId: thread.id,
        expectedActivationId: loop.activationId,
      });
      expect(command.commandId).toBe(
        `loop-continue:${thread.id}:${loop.updatedAt}:${loop.iteration}:${command.createdAt}`,
      );
    });
  });

  it("dispatches continue even while a queued turn start is pending (decider settles waits)", async () => {
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
      // The reactor no longer pre-evaluates the continuation policy; it forwards
      // the deterministic continue and the decider settles the pending-start wait
      // with a non-triggering thread.loop-wait-noted event.
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(1);
    });
  });

  it("ignores thread.loop-wait-noted (no continuation feedback)", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    await withReactor(thread, async ({ offer, advance, commandsOfType }) => {
      await offer(makeLoopWaitNotedEvent(loop));
      await advance(50);
      expect(await commandsOfType("thread.loop.continue")).toHaveLength(0);
    });
  });

  it("supervises a persistently failing restore dispatch until it resumes without unrelated events", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const { eventQueue, dispatchLog, fakeSnapshotQuery, fakeProjectionThreadLoopRepository } =
      makeFakes(makeSnapshot(thread), Option.some(thread));
    // Fails the initial attempt, all bounded inline retries, and several
    // supervised retries before recovering.
    const failuresRemaining = Effect.runSync(Ref.make(8));
    const failingEngine: OrchestrationEngineShape = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.getAndUpdate(failuresRemaining, (count) => Math.max(0, count - 1)).pipe(
          Effect.flatMap((count) =>
            count > 0
              ? Effect.fail(new Error("dispatch unavailable"))
              : Ref.update(dispatchLog, (commands) => [...commands, command]).pipe(
                  Effect.as({ sequence: 1 }),
                ),
          ),
        ),
      streamDomainEvents: Stream.fromQueue(eventQueue),
    } as unknown as OrchestrationEngineShape;

    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.provide(
          LoopReactorLive,
          Layer.mergeAll(
            Layer.succeed(OrchestrationEngineService, failingEngine),
            Layer.succeed(ProjectionSnapshotQuery, fakeSnapshotQuery),
            Layer.succeed(ProjectionThreadLoopRepository, fakeProjectionThreadLoopRepository),
          ),
        ),
        TestClock.layer(),
      ),
    );
    try {
      await runtime.runPromise(Effect.scoped(TestClock.setTime(Date.parse(now))));
      const reactor = await runtime.runPromise(Effect.service(LoopReactor));
      const restoreFiber = await runtime.runPromise(Effect.forkDetach(reactor.restoreActiveLoops));
      // Drain the bounded inline retries (250ms exponential, 3 takes).
      for (let i = 0; i < 8; i += 1) {
        await runtime.runPromise(Effect.scoped(TestClock.adjust("1 second")));
      }
      await runtime.runPromise(Fiber.await(restoreFiber));
      expect(await runtime.runPromise(Ref.get(dispatchLog))).toHaveLength(0);
      // Supervised background retries keep going with no thread events until
      // the engine recovers.
      for (let i = 0; i < 10; i += 1) {
        await runtime.runPromise(Effect.scoped(TestClock.adjust("30 seconds")));
      }
      const commands = await runtime.runPromise(Ref.get(dispatchLog));
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.loop.continue",
        threadId: thread.id,
        expectedActivationId: loop.activationId,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("stops supervised restore retries when the loop activation changes", async () => {
    const loop = makeLoop();
    const thread = makeThread({ loop });
    const reconfigured = {
      ...thread,
      loop: makeLoop({ activationId: LoopActivationId.makeUnsafe("loop-activation-next") }),
    } as OrchestrationThread;
    const { eventQueue, dispatchLog, fakeProjectionThreadLoopRepository } = makeFakes(
      makeSnapshot(thread),
      Option.some(thread),
    );
    const failuresRemaining = Effect.runSync(Ref.make(8));
    const failingEngine: OrchestrationEngineShape = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.getAndUpdate(failuresRemaining, (count) => Math.max(0, count - 1)).pipe(
          Effect.flatMap((count) =>
            count > 0
              ? Effect.fail(new Error("dispatch unavailable"))
              : Ref.update(dispatchLog, (commands) => [...commands, command]).pipe(
                  Effect.as({ sequence: 1 }),
                ),
          ),
        ),
      streamDomainEvents: Stream.fromQueue(eventQueue),
    } as unknown as OrchestrationEngineShape;
    // The startup snapshot still shows the old activation; supervised rechecks
    // observe the reconfigured thread and must stand down.
    const reconfiguredSnapshotQuery: ProjectionSnapshotQueryShape = {
      getSnapshot: () => Effect.succeed(makeSnapshot(thread)),
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [thread] as unknown as ReadonlyArray<OrchestrationThreadShell>,
          snapshotSequence: { sequence: 0, updatedAt: now },
        } as unknown as never),
      getThreadShellById: () =>
        Effect.succeed(
          Option.some(reconfigured) as unknown as Option.Option<OrchestrationThreadShell>,
        ),
    } as unknown as ProjectionSnapshotQueryShape;

    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.provide(
          LoopReactorLive,
          Layer.mergeAll(
            Layer.succeed(OrchestrationEngineService, failingEngine),
            Layer.succeed(ProjectionSnapshotQuery, reconfiguredSnapshotQuery),
            Layer.succeed(ProjectionThreadLoopRepository, fakeProjectionThreadLoopRepository),
          ),
        ),
        TestClock.layer(),
      ),
    );
    try {
      await runtime.runPromise(Effect.scoped(TestClock.setTime(Date.parse(now))));
      const reactor = await runtime.runPromise(Effect.service(LoopReactor));
      const restoreFiber = await runtime.runPromise(Effect.forkDetach(reactor.restoreActiveLoops));
      for (let i = 0; i < 8; i += 1) {
        await runtime.runPromise(Effect.scoped(TestClock.adjust("1 second")));
      }
      await runtime.runPromise(Fiber.await(restoreFiber));
      for (let i = 0; i < 10; i += 1) {
        await runtime.runPromise(Effect.scoped(TestClock.adjust("30 seconds")));
      }
      // The stale activation is never re-driven.
      expect(await runtime.runPromise(Ref.get(dispatchLog))).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});
