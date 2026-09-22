// FILE: DevinCloudAdapter.test.ts
// Purpose: REST-transport lifecycle, turn correlation, resume, and event
// projection contract tests for the Devin Cloud provider adapter.
// Layer: Provider adapter tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Layer, PubSub, Result, Stream } from "effect";

import {
  ApprovalRequestId,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@synara/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";

import {
  DevinRestError,
  type DevinCloudMessage,
  type DevinCloudMessagePage,
  type DevinCloudSession,
  type DevinCloudSessionCreateInput,
  type DevinRestClient,
} from "../devinCloud/DevinRestClient.ts";
import { ServiceMap } from "effect";
import { makeDevinCloudAdapter, type DevinCloudAdapterLiveOptions } from "./DevinCloudAdapter.ts";

class DevinCloudAdapter extends ServiceMap.Service<
  DevinCloudAdapter,
  ProviderAdapterShape<ProviderAdapterError>
>()("test/DevinCloudAdapter") {}

const threadId = ThreadId.makeUnsafe("devincloud-test-thread");
const devinSessionId = "abc123abc123abc123abc123abc12345";

const remoteSession = (overrides: Partial<DevinCloudSession> = {}): DevinCloudSession => ({
  session_id: devinSessionId,
  url: `https://app.devin.ai/sessions/${devinSessionId}`,
  status: "running",
  status_detail: "working",
  title: "Devin Cloud session",
  devin_mode: null,
  acus_consumed: 0,
  pull_requests: [],
  created_at: 1,
  updated_at: 1,
  is_archived: false,
  ...overrides,
});

const remoteMessage = (input: {
  readonly event_id: string;
  readonly source: string;
  readonly message: string;
}): DevinCloudMessage => ({ created_at: 1, ...input });

const messagePage = (items: ReadonlyArray<DevinCloudMessage>): DevinCloudMessagePage => ({
  items: [...items],
  end_cursor: null,
  has_next_page: false,
});

interface ScriptedClient {
  client: DevinRestClient;
  readonly calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }>;
  sessionResponses: Array<DevinCloudSession | DevinRestError>;
  messagePages: Array<DevinCloudMessagePage | DevinRestError>;
  readonly sentMessages: Array<{
    readonly message: string;
    readonly attachmentUrls?: ReadonlyArray<string> | undefined;
  }>;
  readonly createInputs: Array<DevinCloudSessionCreateInput>;
  readonly terminated: Array<string>;
}

function makeScriptedClient(initial: {
  readonly createResponse?: DevinCloudSession;
  readonly selfOrg?: string;
}): ScriptedClient {
  const scripted: ScriptedClient = {
    calls: [],
    sessionResponses: [],
    messagePages: [],
    sentMessages: [],
    createInputs: [],
    terminated: [],
    client: undefined as unknown as DevinRestClient,
  };
  const nextSession = (): Effect.Effect<DevinCloudSession, DevinRestError> =>
    Effect.suspend(() => {
      const next = scripted.sessionResponses.shift() ?? remoteSession();
      return next instanceof DevinRestError ? Effect.fail(next) : Effect.succeed(next);
    });
  const nextPage = (): Effect.Effect<DevinCloudMessagePage, DevinRestError> =>
    Effect.suspend(() => {
      const next = scripted.messagePages.shift() ?? messagePage([]);
      return next instanceof DevinRestError ? Effect.fail(next) : Effect.succeed(next);
    });
  scripted.client = {
    getSelf: () =>
      Effect.sync(() => {
        scripted.calls.push({ method: "getSelf", args: [] });
        return {
          principal_type: "windsurf_session",
          user_id: "user-1",
          user_name: null,
          org_id: initial.selfOrg ?? "org-test",
        };
      }),
    createSession: (orgId, input) =>
      Effect.suspend(() => {
        scripted.calls.push({ method: "createSession", args: [orgId, input] });
        scripted.createInputs.push(input);
        return Effect.succeed(initial.createResponse ?? remoteSession());
      }),
    getSession: (orgId, sessionId) =>
      Effect.suspend(() => {
        scripted.calls.push({ method: "getSession", args: [orgId, sessionId] });
        return nextSession();
      }),
    sendMessage: (orgId, sessionId, input) =>
      Effect.suspend(() => {
        scripted.calls.push({ method: "sendMessage", args: [orgId, sessionId, input] });
        scripted.sentMessages.push(input);
        return nextSession();
      }),
    listMessages: (orgId, sessionId, cursor) =>
      Effect.suspend(() => {
        scripted.calls.push({ method: "listMessages", args: [orgId, sessionId, cursor] });
        return nextPage();
      }),
    uploadAttachment: (_orgId, input) =>
      Effect.succeed({
        attachment_id: "att-1",
        name: input.name,
        url: "https://api.devin.ai/attachments/att-1",
      }),
    terminateSession: (orgId, sessionId) =>
      Effect.suspend(() => {
        scripted.terminated.push(sessionId);
        return Effect.succeed(remoteSession({ status: "exit", status_detail: null }));
      }),
  };
  return scripted;
}

interface RuntimeEventRecord {
  readonly type: string;
  readonly eventId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

const collectEvents = (
  events: Array<RuntimeEventRecord>,
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
) =>
  Effect.gen(function* () {
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() =>
          events.push({
            type: event.type,
            eventId: String(event.eventId),
            ...(event.turnId !== undefined ? { turnId: String(event.turnId) } : {}),
            ...(event.itemId !== undefined ? { itemId: String(event.itemId) } : {}),
            payload: event.payload as Record<string, unknown> | undefined,
          }),
        ),
      ),
      Effect.forkScoped,
    );
    // PubSub drops publishes with no subscribers — let the fork attach before
    // the caller emits the events under test.
    yield* Effect.sleep("20 millis");
  });

const waitFor = (
  predicate: () => boolean,
  description: string,
  attempts = 300,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.fail(new Error(`Timed out waiting for: ${description}`));
  });

interface ScriptedAcpAdapter {
  adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }>;
  readonly pubsub: PubSub.PubSub<ProviderRuntimeEvent>;
  readonly startInputs: Array<ProviderSessionStartInput>;
  startResult: ProviderSession | ProviderAdapterRequestError;
}

function makeScriptedAcpAdapter(): ScriptedAcpAdapter {
  const pubsub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const scripted: ScriptedAcpAdapter = {
    calls: [],
    pubsub,
    startInputs: [],
    startResult: {
      provider: "devin",
      status: "running",
      runtimeMode: "full-access",
      threadId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      resumeCursor: { schemaVersion: 1, sessionId: devinSessionId, cloud: true },
    },
    adapter: undefined as unknown as ProviderAdapterShape<ProviderAdapterError>,
  };
  const record = (method: string, args: ReadonlyArray<unknown>) =>
    Effect.sync(() => {
      scripted.calls.push({ method, args });
    });
  const activeThreadIds = new Set<ThreadId>();
  scripted.adapter = {
    provider: "devin",
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: (input: ProviderSessionStartInput) =>
      Effect.suspend(() => {
        scripted.startInputs.push(input);
        const result = scripted.startResult;
        if (result instanceof ProviderAdapterRequestError) {
          return Effect.fail(result);
        }
        activeThreadIds.add(input.threadId);
        return Effect.succeed({ ...result, threadId: input.threadId });
      }),
    sendTurn: (input: ProviderSendTurnInput) =>
      Effect.suspend(() => {
        scripted.calls.push({ method: "sendTurn", args: [input] });
        return Effect.succeed({
          threadId: input.threadId,
          turnId: TurnId.makeUnsafe(`acp-turn-${scripted.calls.length}`),
        });
      }),
    interruptTurn: (tid: ThreadId) => record("interruptTurn", [tid]),
    respondToRequest: (tid: ThreadId) => record("respondToRequest", [tid]),
    respondToUserInput: (tid: ThreadId) => record("respondToUserInput", [tid]),
    stopSession: (tid: ThreadId) =>
      Effect.sync(() => {
        scripted.calls.push({ method: "stopSession", args: [tid] });
        activeThreadIds.delete(tid);
      }),
    listSessions: () =>
      Effect.sync(() =>
        Array.from(activeThreadIds).map((tid) => ({
          provider: "devin" as const,
          status: "running" as const,
          runtimeMode: "full-access" as const,
          threadId: tid,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      ),
    hasSession: (tid: ThreadId) => Effect.sync(() => activeThreadIds.has(tid)),
    readThread: (tid: ThreadId) => Effect.succeed({ threadId: tid, turns: [], cwd: null }),
    rollbackThread: (tid: ThreadId) => Effect.succeed({ threadId: tid, turns: [], cwd: null }),
    stopAll: () =>
      Effect.sync(() => {
        scripted.calls.push({ method: "stopAll", args: [] });
        activeThreadIds.clear();
      }),
    streamEvents: Stream.fromPubSub(pubsub),
  };
  return scripted;
}

function makeAdapterLayer(
  scripted: ScriptedClient,
  options: {
    readonly resolveAuth?: DevinCloudAdapterLiveOptions["resolveAuth"];
    readonly acpCloudSupported?: DevinCloudAdapterLiveOptions["acpCloudSupported"];
    readonly acpAdapter?: ScriptedAcpAdapter;
    readonly serverPassword?: string;
    readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  } = {},
) {
  return Layer.effect(
    DevinCloudAdapter,
    makeDevinCloudAdapter({
      makeClient: () => scripted.client,
      resolveServerPassword: () => Effect.succeed(options.serverPassword ?? "test-key"),
      resolveAuth:
        options.resolveAuth ??
        (() => Effect.succeed({ apiKey: "test-key", baseUrl: "https://api.devin.ai" })),
      ...(options.acpCloudSupported !== undefined
        ? { acpCloudSupported: options.acpCloudSupported }
        : {}),
      ...(options.acpAdapter !== undefined
        ? {
            makeAcpAdapter: () =>
              Effect.succeed((options.acpAdapter as ScriptedAcpAdapter).adapter),
          }
        : {}),
      pollIntervals: { activeMs: 5, idleMs: 5, minTurnPollMs: 0 },
    }),
  ).pipe(
    Layer.provideMerge(
      ServerSettingsService.layerTest(
        options.settings ?? { providers: { devin: { cloudMode: "rest", orgId: "org-test" } } },
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "devincloud-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("DevinCloudAdapter", () => {
  it("starts a REST session and emits the canonical lifecycle", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        const session = yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        expect(session.provider).toBe("devin");
        expect(session.status).toBe("running");
        expect(session.threadId).toBe(threadId);
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          sessionId: devinSessionId,
          cloud: true,
        });
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );

    const types = runtimeEvents.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "session.started",
        "session.state.changed",
        "thread.started",
        "thread.metadata.updated",
        "session.exited",
      ]),
    );
    const started = runtimeEvents.find((event) => event.type === "session.started");
    expect(started?.payload?.resume).toEqual({
      resumed: false,
      sessionUrl: `https://app.devin.ai/sessions/${devinSessionId}`,
    });
    const threadStarted = runtimeEvents.find((event) => event.type === "thread.started");
    expect(threadStarted?.payload?.providerThreadId).toBe(devinSessionId);
    const urlDelta = runtimeEvents.find(
      (event) =>
        event.type === "content.delta" &&
        event.itemId === `devincloud:session-url:${devinSessionId}`,
    );
    expect(urlDelta?.payload).toEqual({
      streamKind: "assistant_text",
      delta: `Devin Cloud session: https://app.devin.ai/sessions/${devinSessionId}`,
    });
    expect(scripted.createInputs[0]?.bypassApproval).toBe(true);
    expect(scripted.createInputs[0]?.tags).toEqual(["synara"]);
    expect(scripted.createInputs[0]?.devinMode).toBeUndefined();
    expect(scripted.terminated).toEqual([]);
  });

  it("derives repos from the thread cwd's origin remote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synara-devincloud-"));
    const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, ...args]);
    git("init");
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    const scripted = makeScriptedClient({});
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: dir,
        });
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );
    expect(scripted.createInputs[0]?.repos).toEqual(["acme/widgets"]);
  });

  it("omits repos for a cwd without a GitHub origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synara-devincloud-"));
    const scripted = makeScriptedClient({});
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: dir,
        });
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );
    expect(scripted.createInputs[0]?.repos).toBeUndefined();
  });

  it("fails with ProviderAdapterValidationError when no credentials resolve", async () => {
    const scripted = makeScriptedClient({});
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        return yield* adapter
          .startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
          })
          .pipe(Effect.result);
      }).pipe(
        Effect.scoped,
        Effect.provide(makeAdapterLayer(scripted, { resolveAuth: () => Effect.succeed(null) })),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
  });

  it("rejects mode 'acp' when the flag probe reports unsupported", async () => {
    const scripted = makeScriptedClient({});
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        return yield* adapter
          .startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
          })
          .pipe(Effect.result);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeAdapterLayer(scripted, {
            acpCloudSupported: () => Effect.succeed(false),
            settings: { providers: { devin: { cloudMode: "acp", orgId: "org-test" } } },
          }),
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("devin acp --cloud");
    expect(scripted.createInputs).toEqual([]);
  });

  it("sendTurn posts the message and the poll completes the turn on waiting_for_user", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        scripted.sessionResponses.push(remoteSession({ status_detail: "working" }));
        scripted.messagePages.push(
          messagePage([remoteMessage({ event_id: "m1", source: "devin", message: "On it." })]),
        );
        const result = yield* adapter.sendTurn({ threadId, input: "Fix the flake" });
        expect(result.turnId).toBeTruthy();
        scripted.sessionResponses.push(remoteSession({ status_detail: "waiting_for_user" }));
        yield* waitFor(
          () => runtimeEvents.some((event) => event.type === "turn.completed"),
          "turn.completed after waiting_for_user",
        );
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );

    expect(scripted.sentMessages[0]?.message).toBe("Fix the flake");
    const turnId = runtimeEvents.find((event) => event.type === "turn.started")?.turnId;
    expect(turnId).toBeTruthy();
    const delta = runtimeEvents.find(
      (event) => event.type === "content.delta" && event.itemId === "devincloud:m1",
    );
    expect(delta?.payload).toEqual({ streamKind: "assistant_text", delta: "On it." });
    const completed = runtimeEvents.find((event) => event.type === "turn.completed");
    expect(completed?.turnId).toBe(turnId);
    expect(completed?.payload?.state).toBe("completed");
    // Parked status_details (waiting_for_user/finished/inactivity) map to
    // "ready" — "waiting" would project the thread as still running.
    const parked = runtimeEvents
      .filter((event) => event.type === "session.state.changed")
      .map((event) => event.payload?.state);
    expect(parked).toContain("ready");
    expect(parked).not.toContain("waiting");
    expect(
      runtimeEvents.filter(
        (event) => event.itemId === "devincloud:m1" && event.type === "item.completed",
      ).length,
    ).toBe(1);
    expect(
      runtimeEvents.some(
        (event) => event.payload?.itemType === "user_message" && event.type === "item.started",
      ),
    ).toBe(false);
    // Every event in an item's started → delta → completed burst needs its own
    // eventId — the journal quarantines reused ids as content collisions.
    const burstIds = runtimeEvents
      .filter((event) => event.itemId === "devincloud:m1")
      .map((event) => event.eventId);
    expect(new Set(burstIds).size).toBe(burstIds.length);
  });

  it("sendTurn rejects while a turn is open; steerTurn forwards the message", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        scripted.sessionResponses.push(remoteSession({ status_detail: "working" }));
        yield* adapter.sendTurn({ threadId, input: "First" });
        const duplicate = yield* adapter
          .sendTurn({ threadId, input: "Second" })
          .pipe(Effect.result);
        expect(Result.isFailure(duplicate)).toBe(true);
        const steerTurn = adapter.steerTurn;
        expect(steerTurn).toBeDefined();
        if (steerTurn) {
          yield* steerTurn({ threadId, input: "Steer it" });
        }
        yield* waitFor(
          () => runtimeEvents.some((event) => event.type === "turn.steered"),
          "turn.steered",
        );
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );

    expect(scripted.sentMessages.map((entry) => entry.message)).toEqual(["First", "Steer it"]);
    const steered = runtimeEvents.find((event) => event.type === "turn.steered");
    expect(steered?.payload?.message).toBe("Steer it");
    expect(steered?.payload?.target).toBe("turn");
  });

  it("interruptTurn detaches the open turn without terminating the remote session", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        scripted.sessionResponses.push(remoteSession({ status_detail: "working" }));
        const { turnId } = yield* adapter.sendTurn({ threadId, input: "Work" });
        yield* adapter.interruptTurn(threadId, turnId);
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );

    const completed = runtimeEvents.find((event) => event.type === "turn.completed");
    expect(completed?.payload?.state).toBe("interrupted");
    expect(scripted.terminated).toEqual([]);
  });

  it("fails the open turn on billing status_details and recovers when they clear", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        scripted.sessionResponses.push(remoteSession({ status_detail: "working" }));
        yield* adapter.sendTurn({ threadId, input: "Work" });
        scripted.sessionResponses.push(remoteSession({ status_detail: "out_of_credits" }));
        yield* waitFor(
          () => runtimeEvents.some((event) => event.type === "turn.completed"),
          "turn.completed after out_of_credits",
        );
        scripted.sessionResponses.push(remoteSession({ status_detail: "waiting_for_user" }));
        yield* waitFor(
          () =>
            runtimeEvents.some(
              (event) => event.type === "session.state.changed" && event.payload?.state === "ready",
            ),
          "session recovers to ready",
        );
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );

    const failed = runtimeEvents.find((event) => event.type === "turn.completed");
    expect(failed?.payload?.state).toBe("failed");
    expect(failed?.payload?.errorMessage).toContain("out_of_credits");
    const states = runtimeEvents
      .filter((event) => event.type === "session.state.changed")
      .map((event) => event.payload?.state);
    expect(states).toContain("error");
    expect(states).toContain("ready");
  });

  it("resume replays history (user + devin) and skips createSession", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        scripted.messagePages.push(
          messagePage([
            remoteMessage({ event_id: "old-u", source: "user", message: "Earlier ask" }),
            remoteMessage({ event_id: "old-d", source: "devin", message: "Earlier answer" }),
          ]),
        );
        const session = yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: devinSessionId, cloud: true },
        });
        expect(session.status).toBe("running");
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );

    const oldUser = runtimeEvents.find(
      (event) => event.itemId === "devincloud:old-u" && event.type === "item.completed",
    );
    expect(oldUser?.payload?.detail).toBe("Earlier ask");
    const oldDevin = runtimeEvents.find(
      (event) => event.itemId === "devincloud:old-d" && event.type === "content.delta",
    );
    expect(oldDevin?.payload).toEqual({ streamKind: "assistant_text", delta: "Earlier answer" });
    expect(scripted.createInputs).toEqual([]);
  });

  it("readExternalThread snapshots any Devin session by id and rejects bad ids", async () => {
    const scripted = makeScriptedClient({});
    scripted.messagePages.push(
      messagePage([remoteMessage({ event_id: "x1", source: "user", message: "import me" })]),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        const readExternalThread = adapter.readExternalThread;
        expect(readExternalThread).toBeDefined();
        if (!readExternalThread) return;
        const snapshot = yield* readExternalThread({
          externalThreadId: `devin-${devinSessionId}`,
        });
        expect(snapshot.turns.length).toBe(1);
        expect(snapshot.turns[0]?.items.length).toBe(1);
        const bad = yield* readExternalThread({ externalThreadId: "nope" }).pipe(Effect.result);
        expect(Result.isFailure(bad)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );
  });

  it("respondToRequest, rollbackThread, and post-stop sends surface errors", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        const approval = yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.makeUnsafe("req-1"), "accept")
          .pipe(Effect.result);
        expect(Result.isFailure(approval)).toBe(true);
        const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
        expect(Result.isFailure(rollback)).toBe(true);
        const listModels = adapter.listModels;
        expect(listModels).toBeDefined();
        if (!listModels) return;
        const models = yield* listModels({ provider: "devin" });
        expect(models.models.map((model) => model.slug)).toEqual([
          "cloud/auto",
          "cloud/normal",
          "cloud/fast",
          "cloud/lite",
          "cloud/ultra",
          "cloud/fusion",
          "cloud/swe-2-medium",
          "cloud/swe-2-high",
          "cloud/swe-2-max",
        ]);
        const getComposerCapabilities = adapter.getComposerCapabilities;
        expect(getComposerCapabilities).toBeDefined();
        if (getComposerCapabilities) {
          const composer = yield* getComposerCapabilities();
          expect(composer.provider).toBe("devin");
        }
        yield* adapter.stopAll();
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        const gone = yield* adapter.sendTurn({ threadId, input: "again" }).pipe(Effect.result);
        expect(Result.isFailure(gone)).toBe(true);
        expect(
          runtimeEvents.some((event) => event.type === "session.exited"),
          "session.exited emitted on detach",
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );
  });

  it("responds to a remote session exit by closing the local session", async () => {
    const scripted = makeScriptedClient({});
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        scripted.sessionResponses.push(remoteSession({ status: "exit", status_detail: null }));
        yield* waitFor(
          () => runtimeEvents.some((event) => event.type === "session.exited"),
          "session.exited on remote exit",
        );
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(makeAdapterLayer(scripted))),
    );
  });

  it("auto mode delegates to the ACP transport when the flag probe succeeds", async () => {
    const scripted = makeScriptedClient({});
    const acp = makeScriptedAcpAdapter();
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        const session = yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          providerOptions: { devin: { binaryPath: "/opt/devin/bin/devin" } },
        });
        expect(session.provider).toBe("devin");
        // The wrapped adapter receives the provider-stamped input with the
        // resolved binary forwarded under providerOptions.devin.
        expect(acp.startInputs[0]?.provider).toBe("devin");
        expect(acp.startInputs[0]?.providerOptions).toEqual({
          devin: { binaryPath: "/opt/devin/bin/devin" },
        });
        // Thread-scoped calls route to the ACP adapter, not REST.
        yield* adapter.sendTurn({ threadId, input: "via acp" });
        yield* adapter.stopSession(threadId);
        expect(acp.calls.map((call) => call.method)).toEqual(["sendTurn", "stopSession"]);
        yield* adapter.stopAll();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeAdapterLayer(scripted, {
            acpAdapter: acp,
            acpCloudSupported: () => Effect.succeed(true),
            settings: { providers: { devin: { cloudMode: "auto", orgId: "org-test" } } },
          }),
        ),
      ),
    );
    // REST was never touched and ACP events reach the merged stream.
    expect(scripted.createInputs).toEqual([]);
    expect(scripted.sentMessages).toEqual([]);
  });

  it("auto mode falls back to REST when ACP start hits a usage-class error", async () => {
    const scripted = makeScriptedClient({});
    const acp = makeScriptedAcpAdapter();
    acp.startResult = new ProviderAdapterRequestError({
      provider: "devin",
      method: "session/new",
      detail: "devin: unexpected argument '--cloud' found",
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        const session = yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          sessionId: devinSessionId,
          cloud: true,
        });
        yield* adapter.stopAll();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeAdapterLayer(scripted, {
            acpAdapter: acp,
            acpCloudSupported: () => Effect.succeed(true),
            settings: { providers: { devin: { cloudMode: "auto", orgId: "org-test" } } },
          }),
        ),
      ),
    );
    expect(acp.startInputs).toHaveLength(1);
    expect(scripted.createInputs).toHaveLength(1);
  });

  it("auto mode falls back to REST when the ACP relay cannot authenticate", async () => {
    const scripted = makeScriptedClient({});
    const acp = makeScriptedAcpAdapter();
    acp.startResult = new ProviderAdapterRequestError({
      provider: "devin",
      method: "session/new",
      detail: "Devin ACP advertised no supported headless authentication method (advertised: none)",
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        const session = yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          sessionId: devinSessionId,
          cloud: true,
        });
        yield* adapter.stopAll();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeAdapterLayer(scripted, {
            acpAdapter: acp,
            acpCloudSupported: () => Effect.succeed(true),
            settings: { providers: { devin: { cloudMode: "auto", orgId: "org-test" } } },
          }),
        ),
      ),
    );
    expect(acp.startInputs).toHaveLength(1);
    expect(scripted.createInputs).toHaveLength(1);
  });

  it("acp mode rethrows ACP start failures without REST fallback", async () => {
    const scripted = makeScriptedClient({});
    const acp = makeScriptedAcpAdapter();
    acp.startResult = new ProviderAdapterRequestError({
      provider: "devin",
      method: "session/new",
      detail: "devin acp exited: authentication required",
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        return yield* adapter
          .startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
          })
          .pipe(Effect.result);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeAdapterLayer(scripted, {
            acpAdapter: acp,
            acpCloudSupported: () => Effect.succeed(true),
            settings: { providers: { devin: { cloudMode: "acp", orgId: "org-test" } } },
          }),
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(scripted.createInputs).toEqual([]);
  });

  it("acp events flow through the merged stream after an ACP session starts", async () => {
    const scripted = makeScriptedClient({});
    const acp = makeScriptedAcpAdapter();
    const runtimeEvents: Array<RuntimeEventRecord> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinCloudAdapter;
        yield* collectEvents(runtimeEvents, adapter);
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        yield* PubSub.publish(acp.pubsub, {
          eventId: EventId.makeUnsafe("acp-e1"),
          provider: "devin",
          threadId,
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "session.state.changed",
          payload: { state: "running" },
        } satisfies ProviderRuntimeEvent);
        yield* waitFor(
          () => runtimeEvents.some((event) => event.type === "session.state.changed"),
          "acp event on merged stream",
        );
        yield* adapter.stopAll();
        expect(acp.calls.some((call) => call.method === "stopAll")).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeAdapterLayer(scripted, {
            acpAdapter: acp,
            acpCloudSupported: () => Effect.succeed(true),
            settings: { providers: { devin: { cloudMode: "auto", orgId: "org-test" } } },
          }),
        ),
      ),
    );
  });
});
