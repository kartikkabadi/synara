import type {
  OrchestrationCommand,
  OrchestrationThread,
  ProviderCompactionRequest,
  ProviderCompactionResult,
  ProviderRuntimeEvent,
} from "@synara/contracts";
import { EventId, ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderServiceError,
} from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ThreadCompactionOperationRepository } from "../../persistence/Services/ThreadCompactionOperations.ts";
import { ThreadCompactionOperationRepositoryLive } from "../../persistence/Layers/ThreadCompactionOperations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { CompactionReactor } from "../Services/CompactionReactor.ts";
import { CompactionReactorLive } from "./CompactionReactor.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

type PartialThread = {
  readonly session: {
    readonly threadId: ThreadId;
    readonly status: string;
    readonly providerName: string | null;
    readonly runtimeMode: string;
    readonly activeTurnId: string | null;
    readonly lastError: string | null;
    readonly updatedAt: string;
  } | null;
};

const NATIVE_AUTO_COMPACTION = {
  manual: { mode: "same-session", mechanism: "native-rpc", supportsInstructions: true },
  automatic: {
    mode: "native",
    statusVisibility: "partial",
    triggerVisibility: "derived",
  },
  telemetry: { lifecycle: "native", contextUsage: "exact" },
} as const;

const MANUAL_ONLY_COMPACTION = {
  manual: { mode: "same-session", mechanism: "control-command", supportsInstructions: false },
  automatic: { mode: "none", statusVisibility: "none", triggerVisibility: "opaque" },
  telemetry: { lifecycle: "inferred", contextUsage: "exact" },
} as const;

function makeHarness(options?: {
  readonly compactThread?: (
    input: ProviderCompactionRequest,
  ) => Effect.Effect<ProviderCompactionResult, ProviderServiceError>;
  readonly compaction?: typeof NATIVE_AUTO_COMPACTION | typeof MANUAL_ONLY_COMPACTION;
}) {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const compactThread = vi.fn(
    options?.compactThread ??
      ((_input: ProviderCompactionRequest) =>
        Effect.succeed({ kind: "same-session" } as ProviderCompactionResult)),
  );
  const dispatched: Array<OrchestrationCommand> = [];

  const now = new Date().toISOString();
  const threadState: { current: PartialThread } = {
    current: {
      session: {
        threadId: THREAD_ID,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    },
  };

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;

  const providerService = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    forkThread: () => Effect.succeed(null),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    compactThread,
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  } as unknown as ProviderServiceShape;

  const providerDiscoveryService = {
    getComposerCapabilities: () =>
      Effect.succeed({
        provider: "codex",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        compaction: options?.compaction ?? NATIVE_AUTO_COMPACTION,
      }),
  } as unknown as ProviderDiscoveryServiceShape;

  const orchestrationEngine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as OrchestrationEngineShape;

  const projectionSnapshotQuery = {
    getThreadDetailById: () =>
      Effect.succeed(Option.some(threadState.current as unknown as OrchestrationThread)),
  } as unknown as ProjectionSnapshotQueryShape;

  const layer = CompactionReactorLive.pipe(
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(Layer.succeed(ProviderDiscoveryService, providerDiscoveryService)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
    Layer.provideMerge(ThreadCompactionOperationRepositoryLive),
    Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

  const emit = (event: Record<string, unknown>): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return { layer, compactThread, dispatched, threadState, emit };
}

async function waitFor<A>(
  read: () => Promise<A>,
  predicate: (value: A) => boolean,
  timeoutMs = 10_000,
): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const runtimeEvent = (type: string, payload?: unknown): Record<string, unknown> => ({
  type,
  eventId: EventId.makeUnsafe(crypto.randomUUID()),
  provider: "codex",
  createdAt: new Date().toISOString(),
  threadId: THREAD_ID,
  ...(payload !== undefined ? { payload } : {}),
});

describe("CompactionReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    CompactionReactor | ThreadCompactionOperationRepository | ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function startReactor(harness: ReturnType<typeof makeHarness>) {
    runtime = ManagedRuntime.make(harness.layer);
    const reactor = await runtime.runPromise(Effect.service(CompactionReactor));
    const operations = await runtime.runPromise(
      Effect.service(ThreadCompactionOperationRepository),
    );
    const sessionRuntimes = await runtime.runPromise(
      Effect.service(ProviderSessionRuntimeRepository),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(reactor.start.pipe(Scope.provide(scope)));
    // Give the forked stream subscription a beat to attach to the pubsub.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { reactor, operations, sessionRuntimes };
  }

  it("completes a manual request while idle through running", async () => {
    const harness = makeHarness();
    const { reactor, operations } = await startReactor(harness);

    const result = await runtime!.runPromise(
      reactor.request({ requestId: "req-1", threadId: THREAD_ID, trigger: "manual" }),
    );

    expect(result).toEqual({ kind: "same-session" });
    expect(harness.compactThread).toHaveBeenCalledTimes(1);
    const state = await runtime!.runPromise(reactor.getControlState(THREAD_ID));
    expect(state).toEqual({ status: "idle" });
    const row = Option.getOrThrow(await runtime!.runPromise(operations.getByThreadId(THREAD_ID)));
    expect(row.status).toBe("completed");
    expect(row.owner).toBe("synara");
    expect(row.trigger).toBe("manual");
    // Running was persisted before completion, and the status projection saw both.
    const payloads = harness.dispatched.map(
      (command) =>
        (command as unknown as { activity: { payload: Record<string, unknown> } }).activity.payload,
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ owner: "provider", providerAutoEnabled: true });
    expect(payloads[0]?.lastCompaction).toBeUndefined();
    expect(payloads[1]).toMatchObject({
      owner: "provider",
      trigger: { kind: "opaque" },
      manualAvailability: { available: true },
      lastCompaction: {
        requestId: "req-1",
        owner: "synara",
        trigger: "manual",
        result: "completed",
        sessionEffect: "same-session",
      },
    });
  });

  it("returns the existing operation for a duplicate request id", async () => {
    const harness = makeHarness();
    const { reactor } = await startReactor(harness);

    const input = { requestId: "req-1", threadId: THREAD_ID, trigger: "manual" } as const;
    const first = await runtime!.runPromise(reactor.request(input));
    const second = await runtime!.runPromise(reactor.request(input));

    expect(second).toEqual(first);
    expect(harness.compactThread).toHaveBeenCalledTimes(1);
  });

  it("defers a request behind an active turn and completes after it settles", async () => {
    const harness = makeHarness();
    const { reactor } = await startReactor(harness);
    harness.threadState.current = {
      session: { ...harness.threadState.current.session!, activeTurnId: "turn-1" },
    };

    const pendingResult = runtime!.runPromise(
      reactor.request({ requestId: "req-1", threadId: THREAD_ID, trigger: "manual" }),
    );
    await waitFor(
      () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
      (state) => state.status === "pending",
    );
    expect(harness.compactThread).not.toHaveBeenCalled();

    harness.threadState.current = {
      session: { ...harness.threadState.current.session!, activeTurnId: null },
    };
    harness.emit(runtimeEvent("turn.completed", {}));

    expect(await pendingResult).toEqual({ kind: "same-session" });
    expect(harness.compactThread).toHaveBeenCalledTimes(1);
    const state = await runtime!.runPromise(reactor.getControlState(THREAD_ID));
    expect(state).toEqual({ status: "idle" });
  });

  it("records provider-native automatic compaction as provider-owned completed", async () => {
    const harness = makeHarness();
    const { reactor, operations } = await startReactor(harness);

    harness.emit(runtimeEvent("item.started", { itemType: "context_compaction" }));
    await waitFor(
      () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
      (state) => state.status === "running",
    );
    const running = await runtime!.runPromise(reactor.getControlState(THREAD_ID));
    expect(running).toMatchObject({
      status: "running",
      owner: "provider",
      trigger: "provider-auto",
    });

    harness.emit(runtimeEvent("item.completed", { itemType: "context_compaction" }));
    await waitFor(
      () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
      (state) => state.status === "idle",
    );
    const row = Option.getOrThrow(await runtime!.runPromise(operations.getByThreadId(THREAD_ID)));
    expect(row.status).toBe("completed");
    expect(row.owner).toBe("provider");
    expect(row.trigger).toBe("provider-auto");
    expect(harness.compactThread).not.toHaveBeenCalled();
    const lastPayload = (
      harness.dispatched.at(-1) as unknown as {
        activity: { payload: Record<string, unknown> };
      }
    ).activity.payload;
    expect(lastPayload).toMatchObject({
      owner: "provider",
      lastCompaction: { owner: "provider", trigger: "provider-auto", result: "completed" },
    });
  });

  it("rejects a request carrying a stale lifecycle generation", async () => {
    const harness = makeHarness();
    const { reactor, sessionRuntimes } = await startReactor(harness);
    await runtime!.runPromise(
      sessionRuntimes.upsert({
        threadId: THREAD_ID,
        providerName: "codex",
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lifecycleGeneration: "gen-2",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      }),
    );

    const exit = await runtime!.runPromiseExit(
      reactor.request({
        requestId: "req-1",
        threadId: THREAD_ID,
        trigger: "manual",
        expectedLifecycleGeneration: "gen-1",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.compactThread).not.toHaveBeenCalled();
  });

  it("does not retry an uncertain operation automatically", async () => {
    const harness = makeHarness({
      compactThread: () =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: "codex",
            threadId: THREAD_ID,
            detail: "process exited mid-compaction",
          }),
        ),
    });
    const { reactor, operations } = await startReactor(harness);

    const exit = await runtime!.runPromiseExit(
      reactor.request({ requestId: "req-1", threadId: THREAD_ID, trigger: "manual" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const state = await runtime!.runPromise(reactor.getControlState(THREAD_ID));
    expect(state).toMatchObject({ status: "uncertain", requestId: "req-1" });
    const row = Option.getOrThrow(await runtime!.runPromise(operations.getByThreadId(THREAD_ID)));
    expect(row.status).toBe("uncertain");
    expect(row.outcomeKnown).toBe(false);

    // A settled turn must not resurrect the uncertain operation.
    harness.emit(runtimeEvent("turn.completed", {}));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.compactThread).toHaveBeenCalledTimes(1);
  });

  it("reconciles a persisted running operation as uncertain at startup", async () => {
    const harness = makeHarness();
    runtime = ManagedRuntime.make(harness.layer);
    const reactor = await runtime.runPromise(Effect.service(CompactionReactor));
    const operations = await runtime.runPromise(
      Effect.service(ThreadCompactionOperationRepository),
    );
    const now = new Date().toISOString();
    await runtime.runPromise(
      operations.upsert({
        threadId: THREAD_ID,
        requestId: "req-crashed",
        status: "running",
        owner: "synara",
        trigger: "manual",
        sessionEffect: null,
        failureKind: null,
        detail: null,
        retryable: null,
        outcomeKnown: null,
        beforeUsage: null,
        afterUsage: null,
        requestedAt: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      }),
    );

    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(reactor.start.pipe(Scope.provide(scope)));

    const row = Option.getOrThrow(await runtime.runPromise(operations.getByThreadId(THREAD_ID)));
    expect(row.status).toBe("uncertain");
    expect(row.outcomeKnown).toBe(false);
    expect(row.failureKind).toBe("startup-reconciliation");
    const state = await runtime.runPromise(reactor.getControlState(THREAD_ID));
    expect(state).toMatchObject({ status: "uncertain", requestId: "req-crashed" });
    expect(harness.compactThread).not.toHaveBeenCalled();
    // The reconciled outcome is surfaced as the thread's last compaction.
    const lastPayload = (
      harness.dispatched.at(-1) as unknown as {
        activity: { payload: Record<string, unknown> };
      }
    ).activity.payload;
    expect(lastPayload).toMatchObject({
      lastCompaction: { requestId: "req-crashed", result: "failed" },
    });
  });

  describe("synara-auto", () => {
    const AUTO_SETTINGS = {
      autoEnabled: true,
      trigger: { kind: "percent", percent: 90 },
    } as const;

    const highUsage = { usage: { usedTokens: 95_000, maxTokens: 100_000 } };

    it("auto-triggers a compaction from a usage event", async () => {
      const harness = makeHarness({ compaction: MANUAL_ONLY_COMPACTION });
      const { reactor, operations } = await startReactor(harness);
      await runtime!.runPromise(
        reactor.setThreadSettings({ threadId: THREAD_ID, settings: AUTO_SETTINGS }),
      );

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await waitFor(
        () => Promise.resolve(harness.compactThread.mock.calls.length),
        (calls) => calls === 1,
      );
      expect(harness.compactThread.mock.calls[0]?.[0]).toMatchObject({ trigger: "synara-auto" });
      await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (state) => state.status === "idle",
      );
      const row = Option.getOrThrow(await runtime!.runPromise(operations.getByThreadId(THREAD_ID)));
      expect(row.status).toBe("completed");
      expect(row.owner).toBe("synara");
      expect(row.trigger).toBe("synara-auto");
    });

    it("does not auto-trigger below the threshold or when native auto is active", async () => {
      const nativeHarness = makeHarness();
      const { reactor } = await startReactor(nativeHarness);
      await runtime!.runPromise(
        reactor.setThreadSettings({ threadId: THREAD_ID, settings: AUTO_SETTINGS }),
      );
      nativeHarness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(nativeHarness.compactThread).not.toHaveBeenCalled();
    });

    it("defers behind an active turn as pending, then compacts after the turn", async () => {
      const harness = makeHarness({ compaction: MANUAL_ONLY_COMPACTION });
      const { reactor } = await startReactor(harness);
      await runtime!.runPromise(
        reactor.setThreadSettings({ threadId: THREAD_ID, settings: AUTO_SETTINGS }),
      );
      harness.threadState.current = {
        session: { ...harness.threadState.current.session!, activeTurnId: "turn-1" },
      };

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (state) => state.status === "pending",
      );
      expect(harness.compactThread).not.toHaveBeenCalled();

      harness.threadState.current = {
        session: { ...harness.threadState.current.session!, activeTurnId: null },
      };
      harness.emit(runtimeEvent("turn.completed", {}));
      await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (state) => state.status === "idle",
      );
      expect(harness.compactThread).toHaveBeenCalledTimes(1);
    });

    it("suspends as compaction-thrashing when usage stays above the trigger inside the cooldown", async () => {
      const harness = makeHarness({ compaction: MANUAL_ONLY_COMPACTION });
      const { reactor } = await startReactor(harness);
      await runtime!.runPromise(
        reactor.setThreadSettings({
          threadId: THREAD_ID,
          settings: { ...AUTO_SETTINGS, cooldownSeconds: 3_600 },
        }),
      );

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await waitFor(
        () => Promise.resolve(harness.compactThread.mock.calls.length),
        (calls) => calls === 1,
      );
      await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (state) => state.status === "idle",
      );

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      const state = await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (current) => current.status === "suspended",
      );
      expect(state).toMatchObject({ status: "suspended", reason: "compaction-thrashing" });
      expect(harness.compactThread).toHaveBeenCalledTimes(1);
    });

    it("suspends as repeated-failure after two consecutive failures and resumes via settings", async () => {
      const harness = makeHarness({
        compaction: MANUAL_ONLY_COMPACTION,
        compactThread: () =>
          Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: "codex", threadId: THREAD_ID }),
          ),
      });
      const { reactor } = await startReactor(harness);
      await runtime!.runPromise(
        reactor.setThreadSettings({ threadId: THREAD_ID, settings: AUTO_SETTINGS }),
      );

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await waitFor(
        () => Promise.resolve(harness.compactThread.mock.calls.length),
        (calls) => calls === 1,
      );
      await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (state) => state.status === "idle",
      );

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      const suspendedState = await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (state) => state.status === "suspended",
      );
      expect(suspendedState).toMatchObject({ status: "suspended", reason: "repeated-failure" });
      expect(harness.compactThread).toHaveBeenCalledTimes(2);

      // No automatic retry while suspended.
      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harness.compactThread).toHaveBeenCalledTimes(2);

      // Re-applying settings is the manual resume action.
      await runtime!.runPromise(
        reactor.setThreadSettings({ threadId: THREAD_ID, settings: AUTO_SETTINGS }),
      );
      const resumed = await runtime!.runPromise(reactor.getControlState(THREAD_ID));
      expect(resumed).toEqual({ status: "idle" });
      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      await waitFor(
        () => Promise.resolve(harness.compactThread.mock.calls.length),
        (calls) => calls === 3,
      );
    });

    it("suspends as provider-state-uncertain on an adapter validation rejection", async () => {
      const harness = makeHarness({
        compaction: MANUAL_ONLY_COMPACTION,
        compactThread: () =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: "codex",
              operation: "compactThread",
              issue: "compaction is not supported by this adapter",
            }),
          ),
      });
      const { reactor } = await startReactor(harness);
      await runtime!.runPromise(
        reactor.setThreadSettings({ threadId: THREAD_ID, settings: AUTO_SETTINGS }),
      );

      harness.emit(runtimeEvent("thread.token-usage.updated", highUsage));
      const state = await waitFor(
        () => runtime!.runPromise(reactor.getControlState(THREAD_ID)),
        (current) => current.status === "suspended",
      );
      expect(state).toMatchObject({ status: "suspended", reason: "provider-state-uncertain" });
      expect(harness.compactThread).toHaveBeenCalledTimes(1);
    });
  });
});
