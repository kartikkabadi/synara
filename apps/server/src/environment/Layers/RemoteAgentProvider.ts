// FILE: RemoteAgentProvider.ts
// Purpose: Layer implementing RemoteAgentProvider. Connects to the persistent
//          synara-remote-agent over ssh, speaks the NDJSON agent RPC on the
//          ssh child's stdio, and adapts one agent thread back into a
//          ChildProcess-shaped object with real stdout/stderr/stdin streams
//          so codexAppServerManager treats it like a local provider child.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess } from "@synara/shared/processRuntime";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import {
  RemoteAgentEventEnvelope,
  RemoteAgentAttachOutput,
  RemoteAgentHelloOutput,
  RemoteAgentRpcResponse,
  ThreadId,
  type RemoteAgentConnectionStatusChanged,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import {
  type RemoteAgentError,
  RemoteAgentAttachFailedError,
  RemoteAgentEventParseError,
  RemoteAgentHelloFailedError,
  RemoteAgentSendFailedError,
  RemoteAgentSpawnFailedError,
  RemoteAgentThreadExistsError,
  RemoteAgentVersionMismatchError,
} from "../RemoteEnvironmentErrors";
import { ProviderSpawnError } from "../Services/ProviderProcessSpawner";
import {
  RemoteAgentInstaller,
  type RemoteAgentInstallerShape,
} from "../Services/RemoteAgentInstaller";
import type { ProviderProcessSpawnOptions } from "../Services/ProviderProcessSpawner";
import {
  REMOTE_AGENT_PROTOCOL_VERSION,
  RemoteAgentProvider,
  type RemoteAgentProviderShape,
  type RemoteAgentSpawnedProcess,
} from "../Services/RemoteAgentProvider";
import type { RemoteAgentSpawnPlan } from "../Services/RemoteEnvironmentResolver";
import { SshBinaryPath } from "../Services/SshProcessProvider";
import { publishRemoteAgentStatus } from "../remoteAgentStatusBus";
import {
  RemoteAgentReconnector,
  type RemoteAgentReconnectorOptions,
  type RemoteAgentStatusChange,
} from "./RemoteAgentReconnector";

const HELLO_TIMEOUT_MS = 15_000;
const STDERR_TAIL_MAX_CHARS = 8_192;
const MAX_PENDING_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

const decodeEventEnvelope = Schema.decodeUnknownSync(RemoteAgentEventEnvelope);

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Minimal NDJSON JSON-RPC client over the ssh child's stdio. Requests get
 * incrementing ids; agent/event notifications flow to a single subscriber.
 */
class AgentRpcConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private notificationHandler: ((method: string, params: unknown) => void) | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
        this.rejectAll(new Error("Remote agent frame exceeded 16 MiB"));
        child.kill();
        return;
      }
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.handleLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
    child.once("close", () => this.rejectAll(new Error("agent connection closed")));
    child.once("error", (error) => this.rejectAll(error));
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("agent connection closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Remote agent ${method} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }

  private handleLine(line: string): void {
    let message: RemoteAgentRpcResponse;
    try {
      message = Schema.decodeUnknownSync(RemoteAgentRpcResponse)(JSON.parse(line));
    } catch {
      // Non-JSON noise on the agent channel (e.g. login banners) is ignored;
      // the hello handshake fails closed if the agent never responds.
      return;
    }
    if (message.method !== undefined) {
      this.notificationHandler?.(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    this.closed = true;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * ChildProcess-shaped stable proxy for one agent thread. Real Readable/
 * Writable streams back stdout/stderr/stdin and stay the same objects across
 * transport reconnects: `bind` swaps the underlying ssh connection while the
 * manager keeps reading/writing the proxy streams. Events are deduplicated by
 * journal seq so an agent/attach replay never re-emits already-seen data.
 * Exit settles only from an agent exit event or a completed kill() flow; a
 * transport (ssh) death is surfaced as a "disconnect" event (and the
 * `onDisconnect` callback) instead, because the remote provider outlives the
 * channel and the owning layer may reconnect via agent/attach.
 */
class RemoteAgentChildAdapter extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  private agent: AgentConnection | undefined;
  private highestSeq = 0;
  private failure: Error | undefined;
  private readonly transportStderrCallbacks: Array<(chunk: string) => void> = [];

  constructor(
    private readonly threadId: string,
    private readonly onDisconnect?: (code: number, signal: NodeJS.Signals | null) => void,
  ) {
    super();
    // Startup notifications can arrive before the process owner attaches listeners.
    this.on("error", (error: Error) => {
      this.failure ??= error;
    });
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        const connection = this.agent?.connection;
        if (connection === undefined) {
          callback(new RemoteAgentSendFailedError({ reason: "agent transport is disconnected" }));
          return;
        }
        const payload = `b64:${Buffer.from(chunk).toString("base64")}`;
        connection.request("agent/send", { threadId: this.threadId, payload }).then(
          () => callback(),
          (error: Error) => callback(new RemoteAgentSendFailedError({ reason: error.message })),
        );
      },
    });
  }

  get transportPid(): number | undefined {
    return this.agent?.sshChild.pid;
  }

  get lastReceivedSeq(): number {
    return this.highestSeq;
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  /**
   * Seeds the replay high-water mark with the caller's consumed seq so a
   * reattachment never replays events the caller already saw, even when the
   * first attach replays nothing.
   */
  seedHighWaterMark(lastSeq: number): void {
    this.highestSeq = Math.max(this.highestSeq, lastSeq);
  }

  /** Subscribes to raw transport stderr, stable across reconnects. */
  onTransportStderr(callback: (chunk: string) => void): void {
    this.transportStderrCallbacks.push(callback);
  }

  /** Points the proxy at a (new) transport connection and subscribes events. */
  bind(agent: AgentConnection): void {
    const previous = this.agent;
    this.agent = agent;
    // A local transport PID must never masquerade as the remote provider PID.
    this.pid = undefined;
    if (previous !== undefined && previous.sshChild.exitCode === null) {
      previous.sshChild.kill();
    }
    agent.connection.onNotification((method, params) => {
      if (method !== "agent/event") return;
      this.handleEvent(params, (error) => this.emit("error", error));
    });
    agent.onStderr((chunk) => {
      for (const callback of this.transportStderrCallbacks) callback(chunk);
    });
    agent.sshChild.once("close", (code, signal) => {
      // A stale transport we already replaced must not signal anything, and
      // a transport death never settles the provider: keep streams open,
      // surface a disconnect, and let the owning layer reconnect.
      if (this.agent !== agent || this.exitCode !== null || this.killed) return;
      this.agent = undefined;
      this.emit("disconnect", code, signal);
      this.onDisconnect?.(code ?? -1, signal ?? null);
    });
    agent.sshChild.once("error", (error) => {
      if (this.agent !== agent || this.exitCode !== null || this.killed) return;
      this.emit("disconnect", null, null, error);
    });
  }

  handleEvent(params: unknown, onParseError: (error: RemoteAgentEventParseError) => void): void {
    let envelope: RemoteAgentEventEnvelope;
    try {
      envelope = decodeEventEnvelope(params);
    } catch (cause) {
      onParseError(new RemoteAgentEventParseError({ reason: String(cause) }));
      return;
    }
    if (envelope.threadId !== this.threadId) return;
    // Replayed events (agent/attach) at or below the high-water mark were
    // already forwarded on a previous connection.
    if (envelope.seq <= this.highestSeq) return;
    if (envelope.kind !== "exit") {
      if (this.failure) return;
      const data = Buffer.from(envelope.data, "base64");
      const pending =
        this.stdout.readableLength +
        this.stdout.writableLength +
        this.stderr.readableLength +
        this.stderr.writableLength;
      if (pending + data.length > MAX_PENDING_PROVIDER_OUTPUT_BYTES) {
        onParseError(
          new RemoteAgentEventParseError({
            reason: "Remote provider output exceeded the unread buffer limit",
          }),
        );
        // Keep consuming control frames so the owner can still confirm agent/kill.
        return;
      }
      this.highestSeq = envelope.seq;
      (envelope.kind === "stdout" ? this.stdout : this.stderr).write(data);
      return;
    }
    this.highestSeq = envelope.seq;
    this.settleExit(envelope.exitCode, null);
  }

  async stop(): Promise<void> {
    this.killed = true;
    if (this.exitCode !== null) return;
    const agent = this.agent;
    if (!agent)
      throw new Error("Remote transport is disconnected; provider termination is unverified");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("exit", exited);
      };
      const exited = () => {
        cleanup();
        agent.sshChild.kill();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        agent.sshChild.kill();
        reject(new Error("Remote provider did not confirm exit after cancellation"));
      }, 10_000);
      this.once("exit", exited);
      void agent.connection
        .request("agent/kill", { threadId: this.threadId })
        .catch((cause: unknown) => {
          cleanup();
          agent.sshChild.kill();
          reject(new Error("Remote provider termination is unverified", { cause }));
        });
    });
  }

  kill(_signal?: NodeJS.Signals): boolean {
    void this.stop().catch((error: Error) => this.emit("error", error));
    return true;
  }

  settleExit(code: number, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

interface AgentConnection {
  readonly connection: AgentRpcConnection;
  readonly sshChild: ChildProcessWithoutNullStreams;
  readonly onStderr: (callback: (chunk: string) => void) => void;
}

function connectToAgent(
  sshBinaryPath: string,
  plan: RemoteAgentSpawnPlan,
  options: ProviderProcessSpawnOptions,
): Effect.Effect<AgentConnection, ProviderSpawnError> {
  return Effect.try({
    try: () => {
      const sshChild = spawnProcess(sshBinaryPath, [...plan.sshArgs], {
        // This is the local SSH client; the workspace path belongs to the remote host.
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;

      let stderrTail = "";
      const stderrCallbacks: Array<(chunk: string) => void> = [];
      sshChild.stderr.setEncoding("utf8");
      sshChild.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
        for (const callback of stderrCallbacks) callback(chunk);
      });

      return {
        connection: new AgentRpcConnection(sshChild),
        sshChild,
        onStderr: (callback: (chunk: string) => void) => {
          stderrCallbacks.push(callback);
        },
      };
    },
    catch: (cause) =>
      new ProviderSpawnError({
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

function performHello(
  connection: AgentRpcConnection,
): Effect.Effect<void, RemoteAgentHelloFailedError | RemoteAgentVersionMismatchError> {
  return Effect.gen(function* () {
    const maybeResult = yield* Effect.tryPromise({
      try: () =>
        connection.request("agent/hello", {
          agentVersion: "server",
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        }),
      catch: (cause) =>
        new RemoteAgentHelloFailedError({
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.timeoutOption(HELLO_TIMEOUT_MS));
    if (Option.isNone(maybeResult)) {
      return yield* Effect.fail(
        new RemoteAgentHelloFailedError({
          reason: `agent/hello timed out after ${HELLO_TIMEOUT_MS}ms`,
        }),
      );
    }
    const hello = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(RemoteAgentHelloOutput)(maybeResult.value),
      catch: () =>
        new RemoteAgentHelloFailedError({ reason: "agent/hello returned an invalid response" }),
    });
    const actual = hello.protocolVersion;
    if (actual !== REMOTE_AGENT_PROTOCOL_VERSION) {
      return yield* Effect.fail(
        new RemoteAgentVersionMismatchError({
          expected: REMOTE_AGENT_PROTOCOL_VERSION,
          actual,
        }),
      );
    }
  });
}

const THREAD_EXISTS_MESSAGE = "already exists";

function mapSpawnRejection(threadId: string, cause: unknown): RemoteAgentError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return reason.includes(THREAD_EXISTS_MESSAGE)
    ? new RemoteAgentThreadExistsError({ threadId })
    : new RemoteAgentSpawnFailedError({ reason });
}

export const makeRemoteAgentProvider = (
  sshBinaryPath: string,
  installer: RemoteAgentInstallerShape,
  reconnectOptions: RemoteAgentReconnectorOptions = {},
  onConnectionStatusChanged?: (event: RemoteAgentConnectionStatusChanged) => void,
): RemoteAgentProviderShape => {
  const reconnector = new RemoteAgentReconnector(reconnectOptions);

  /**
   * Opens a fresh transport, rebinds the proxy, and replays via agent/attach.
   * Only an authoritative attach status counts: "running" is a successful
   * reconnect, "exited" settles the adapter from the terminal state, and any
   * other status fails the attempt so the reconnector keeps retrying.
   */
  const reattach = async (
    plan: RemoteAgentSpawnPlan,
    options: ProviderProcessSpawnOptions,
    adapter: RemoteAgentChildAdapter,
  ): Promise<"running" | "exited"> => {
    const agent = await Effect.runPromise(connectToAgent(sshBinaryPath, plan, options));
    try {
      await Effect.runPromise(performHello(agent.connection));
      if (adapter.killed || adapter.exitCode !== null)
        throw new Error("Remote reconnect cancelled");
      // Bind before agent/attach so replayed events land on the proxy streams.
      adapter.bind(agent);
      const result = Schema.decodeUnknownSync(RemoteAgentAttachOutput)(
        await agent.connection.request("agent/attach", {
          threadId: plan.threadId,
          lastSeq: adapter.lastReceivedSeq,
        }),
      );
      if (adapter.killed) throw new Error("Remote reconnect cancelled");
      if (result.status === "exited") {
        // The replayed exit event normally settles the adapter with the real
        // code; settle from the attach result if it was already consumed.
        adapter.settleExit(-1, null);
        agent.sshChild.kill();
        return "exited";
      }
      if (result.status !== "running") {
        throw new Error(`agent/attach returned non-authoritative status "${result.status}"`);
      }
      return "running";
    } catch (cause) {
      agent.sshChild.kill();
      throw cause;
    }
  };

  /**
   * Creates the stable proxy adapter for a thread. On transport disconnect
   * the reconnector marks the thread degraded and reattaches with backoff;
   * the manager keeps the same stdin/stdout/stderr streams throughout.
   */
  const makeSpawnedProcess = (plan: RemoteAgentSpawnPlan, options: ProviderProcessSpawnOptions) => {
    const emitStatusChange = (adapter: RemoteAgentChildAdapter, change: RemoteAgentStatusChange) =>
      onConnectionStatusChanged?.({
        _tag: "RemoteAgentConnectionStatusChanged",
        threadId: ThreadId.makeUnsafe(plan.threadId),
        environmentId: plan.executionProfile.environmentId,
        status: change.status,
        retryCount: change.retryCount,
        lastSeq: adapter.lastReceivedSeq,
        ...(change.message !== undefined ? { message: change.message } : {}),
      });
    const adapter: RemoteAgentChildAdapter = new RemoteAgentChildAdapter(plan.threadId, (code) => {
      reconnector.scheduleReconnect({
        threadId: plan.threadId,
        disconnectCode: code,
        ensureInstalled: () =>
          Effect.runPromise(
            installer.ensureAgentInstalled({
              transport: plan.transport,
              runtime: plan.runtime,
              sshTrustArgs: plan.sshTrustArgs,
            }),
          ),
        reattach: () => reattach(plan, options, adapter),
        isSettled: () => adapter.exitCode !== null || adapter.killed,
        onExhausted: (error) => {
          adapter.emit("error", error);
          // Retry exhaustion says nothing about the remote provider lifetime.
        },
        onStatusChange: (change) => emitStatusChange(adapter, change),
      });
    });
    adapter.once("exit", () => reconnector.finalize(plan.threadId));
    const spawned: RemoteAgentSpawnedProcess = {
      child: adapter as unknown as ChildProcessWithoutNullStreams,
      get transportPid() {
        return adapter.transportPid;
      },
      onStderr: (callback: (chunk: string) => void) => adapter.onTransportStderr(callback),
      stop: async () => {
        reconnector.cancel(plan.threadId);
        await adapter.stop();
      },
      kill: (signal?: NodeJS.Signals) => {
        reconnector.cancel(plan.threadId);
        adapter.kill(signal);
      },
    };
    return { adapter, spawned };
  };

  return {
    spawnRemoteAgent: (plan: RemoteAgentSpawnPlan, options: ProviderProcessSpawnOptions) =>
      Effect.gen(function* () {
        yield* installer.ensureAgentInstalled({
          transport: plan.transport,
          runtime: plan.runtime,
          sshTrustArgs: plan.sshTrustArgs,
        });
        const agent = yield* connectToAgent(sshBinaryPath, plan, options);
        const closeOnFailure = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.tapError(effect, () => Effect.sync(() => agent.sshChild.kill()));
        yield* closeOnFailure(performHello(agent.connection));
        // Bind before agent/spawn resolves so no early event is dropped.
        const { adapter, spawned } = makeSpawnedProcess(plan, options);
        adapter.bind(agent);
        yield* closeOnFailure(
          Effect.tryPromise({
            try: () =>
              agent.connection.request("agent/spawn", {
                threadId: plan.threadId,
                executionProfile: plan.executionProfile,
                providerArgv: plan.providerArgv,
              }),
            catch: (cause) => mapSpawnRejection(plan.threadId, cause),
          }),
        );
        yield* closeOnFailure(
          Effect.tryPromise({
            try: async () => {
              try {
                adapter.assertHealthy();
              } catch (cause) {
                // A successful spawn belongs to this caller even if early output failed.
                await adapter.stop();
                throw cause;
              }
            },
            catch: (cause) => mapSpawnRejection(plan.threadId, cause),
          }),
        );
        return spawned;
      }),
    attachRemoteAgent: (
      plan: RemoteAgentSpawnPlan,
      lastSeq: number,
      options: ProviderProcessSpawnOptions,
    ) =>
      Effect.gen(function* () {
        const agent = yield* connectToAgent(sshBinaryPath, plan, options);
        const closeOnFailure = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.tapError(effect, () => Effect.sync(() => agent.sshChild.kill()));
        yield* closeOnFailure(performHello(agent.connection));
        // Bind before agent/attach so replayed events land on the streams.
        const { adapter, spawned } = makeSpawnedProcess(plan, options);
        adapter.seedHighWaterMark(lastSeq);
        adapter.bind(agent);
        const result = yield* closeOnFailure(
          Effect.tryPromise({
            try: () =>
              agent.connection.request("agent/attach", { threadId: plan.threadId, lastSeq }),
            catch: (cause) =>
              new RemoteAgentAttachFailedError({
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        );
        const attach = yield* closeOnFailure(
          Effect.try({
            try: () => Schema.decodeUnknownSync(RemoteAgentAttachOutput)(result),
            catch: () =>
              new RemoteAgentAttachFailedError({
                reason: "agent/attach returned an invalid response",
              }),
          }),
        );
        yield* closeOnFailure(
          Effect.try({
            try: () => adapter.assertHealthy(),
            catch: (cause) =>
              new RemoteAgentAttachFailedError({
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        );
        return { process: spawned, attach };
      }),
  };
};

export const RemoteAgentProviderLive = Layer.effect(
  RemoteAgentProvider,
  Effect.gen(function* () {
    const sshBinaryPath = yield* SshBinaryPath.asEffect();
    const installer = yield* RemoteAgentInstaller;
    return makeRemoteAgentProvider(sshBinaryPath, installer, {}, publishRemoteAgentStatus);
  }),
);
