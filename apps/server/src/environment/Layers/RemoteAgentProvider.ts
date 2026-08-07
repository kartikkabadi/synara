// FILE: RemoteAgentProvider.ts
// Purpose: Layer implementing RemoteAgentProvider. Connects to the persistent
//          synara-remote-agent over ssh, speaks the NDJSON agent RPC on the
//          ssh child's stdio, and adapts one agent thread back into a
//          ChildProcess-shaped object with real stdout/stderr/stdin streams
//          so codexAppServerManager treats it like a local provider child.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { RemoteAgentEventEnvelope } from "@synara/contracts";
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
  type RemoteAgentAttachResult,
  type RemoteAgentProviderShape,
  type RemoteAgentSpawnedProcess,
} from "../Services/RemoteAgentProvider";
import type { RemoteAgentSpawnPlan } from "../Services/RemoteEnvironmentResolver";
import { SshBinaryPath } from "../Services/SshProcessProvider";

const HELLO_TIMEOUT_MS = 15_000;
const STDERR_TAIL_MAX_CHARS = 8_192;

const decodeEventEnvelope = Schema.decodeUnknownSync(RemoteAgentEventEnvelope);

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
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
      this.buffer += chunk;
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
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
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
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * ChildProcess-shaped adapter for one agent thread. Real Readable/Writable
 * streams back stdout/stderr/stdin. Exit settles only from an agent exit
 * event or a completed kill() flow; a transport (ssh) close is surfaced as a
 * "disconnect" event instead, because the remote provider outlives the
 * channel and the owning layer may reconnect via agent/attach.
 */
class RemoteAgentChildAdapter extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(
    private readonly connection: AgentRpcConnection,
    private readonly sshChild: ChildProcessWithoutNullStreams,
    private readonly threadId: string,
  ) {
    super();
    this.pid = sshChild.pid;
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        const payload = `b64:${Buffer.from(chunk).toString("base64")}`;
        connection.request("agent/send", { threadId, payload }).then(
          () => callback(),
          (error: Error) => callback(new RemoteAgentSendFailedError({ reason: error.message })),
        );
      },
    });
    sshChild.once("close", (code, signal) => {
      // The transport died, not the provider: keep streams open and let the
      // owning layer decide whether to reconnect through agent/attach.
      this.emit("disconnect", code, signal);
    });
    sshChild.once("error", (error) => {
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
    switch (envelope.kind) {
      case "stdout":
        this.stdout.write(Buffer.from(envelope.data, "base64"));
        return;
      case "stderr":
        this.stderr.write(Buffer.from(envelope.data, "base64"));
        return;
      case "exit":
        this.settleExit(envelope.exitCode, null);
        return;
    }
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    const finalize = () => {
      if (this.sshChild.exitCode === null && !this.sshChild.killed) {
        this.sshChild.kill(signal);
      }
      // The kill flow completed: settle even if the exit event never arrived
      // (e.g. the transport dropped it) so teardown runs exactly once.
      this.settleExit(-1, signal ?? null);
    };
    this.connection.request("agent/kill", { threadId: this.threadId }).then(finalize, finalize);
    return true;
  }

  private settleExit(code: number, signal: NodeJS.Signals | null): void {
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
      const sshChild = spawn(sshBinaryPath, [...plan.sshArgs], {
        cwd: options.cwd,
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
    const hello = maybeResult.value as { protocolVersion?: string } | undefined;
    const actual = hello?.protocolVersion;
    if (typeof actual !== "string" || actual.length === 0) {
      return yield* Effect.fail(
        new RemoteAgentHelloFailedError({ reason: "agent/hello returned no protocolVersion" }),
      );
    }
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

function makeSpawnedProcess(agent: AgentConnection, plan: RemoteAgentSpawnPlan) {
  const adapter = new RemoteAgentChildAdapter(agent.connection, agent.sshChild, plan.threadId);
  agent.connection.onNotification((method, params) => {
    if (method !== "agent/event") return;
    adapter.handleEvent(params, (error) => adapter.emit("error", error));
  });
  const spawned: RemoteAgentSpawnedProcess = {
    child: adapter as unknown as ChildProcessWithoutNullStreams,
    onStderr: agent.onStderr,
    kill: (signal?: NodeJS.Signals) => adapter.kill(signal),
  };
  return spawned;
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
): RemoteAgentProviderShape => ({
  spawnRemoteAgent: (plan: RemoteAgentSpawnPlan, options: ProviderProcessSpawnOptions) =>
    Effect.gen(function* () {
      yield* installer.ensureAgentInstalled({ transport: plan.transport, runtime: plan.runtime });
      const agent = yield* connectToAgent(sshBinaryPath, plan, options);
      const closeOnFailure = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.tapError(effect, () => Effect.sync(() => agent.sshChild.kill()));
      yield* closeOnFailure(performHello(agent.connection));
      // Subscribe before agent/spawn resolves so no early event is dropped.
      const spawned = makeSpawnedProcess(agent, plan);
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
      // Subscribe before agent/attach so replayed events land on the streams.
      const spawned = makeSpawnedProcess(agent, plan);
      const result = yield* closeOnFailure(
        Effect.tryPromise({
          try: () => agent.connection.request("agent/attach", { threadId: plan.threadId, lastSeq }),
          catch: (cause) =>
            new RemoteAgentAttachFailedError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
      );
      const attach = result as RemoteAgentAttachResult;
      return { process: spawned, attach };
    }),
});

export const RemoteAgentProviderLive = Layer.effect(
  RemoteAgentProvider,
  Effect.gen(function* () {
    const sshBinaryPath = yield* SshBinaryPath.asEffect();
    const installer = yield* RemoteAgentInstaller;
    return makeRemoteAgentProvider(sshBinaryPath, installer);
  }),
);
