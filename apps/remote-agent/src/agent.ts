import type { Readable, Writable } from "node:stream";
import { Schema } from "effect";

import {
  RemoteAgentAttachInput,
  RemoteAgentHelloInput,
  RemoteAgentKillInput,
  RemoteAgentSendInput,
  RemoteAgentSpawnInput,
  RemoteAgentStatusInput,
  type RemoteAgentThreadStatus,
} from "@synara/contracts/remoteAgent";
import { spawnProcess } from "@synara/shared/processRuntime";

import { terminateOwnedPosixProcessGroup as terminateOwnedGroup } from "@synara/shared/ownedPosixProcessGroup";
import { AgentJournal, defaultJournalDir, MAX_FRAME_BYTES } from "./storage";
import type { JournalEntry, JsonRpcRequest, ThreadState } from "./types";
import { AGENT_VERSION, PROTOCOL_VERSION } from "./version";

const Request = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union([Schema.Int, Schema.String, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const KILL_GRACE_MS = 5_000;
const MAX_PENDING_OUTPUT_BYTES = 4 * MAX_FRAME_BYTES;

export interface AgentOptions {
  journalDir?: string;
  killGraceMs?: number;
  onFatal?: (error: unknown) => void;
}

export class RemoteAgent {
  private readonly journal: AgentJournal;
  private readonly killGraceMs: number;
  private readonly threads = new Map<string, ThreadState>();
  private output: Writable | null;
  private detachInput: (() => void) | undefined;
  private closing = false;

  constructor(
    output: Writable | null,
    private readonly options: AgentOptions = {},
  ) {
    this.output = output;
    this.journal = new AgentJournal(options.journalDir ?? defaultJournalDir());
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  }

  attachInput(input: Readable, output: Writable | null = this.output): () => void {
    this.detachInput?.();
    this.output = output;
    let buffer = Buffer.alloc(0);
    let active = true;
    let draining = false;
    const detach = () => {
      active = false;
      buffer = Buffer.alloc(0);
      input.removeListener("data", onData);
      input.removeListener("end", detach);
      input.removeListener("close", detach);
      if (this.output === output) this.output = null;
    };
    const drain = async () => {
      if (draining) return;
      draining = true;
      input.pause();
      try {
        while (active) {
          const newline = buffer.indexOf(10);
          if (newline === -1) break;
          if (newline > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds size limit");
          const line = buffer.subarray(0, newline).toString("utf8").trim();
          buffer = buffer.subarray(newline + 1);
          if (line) await this.handleLine(line, output);
        }
        if (buffer.length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds size limit");
      } catch (error) {
        this.respondError(output, null, -32600, String(error));
        detach();
        input.destroy();
        output?.destroy();
      } finally {
        draining = false;
        if (active) input.resume();
      }
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length + bytes.length > 2 * MAX_FRAME_BYTES) {
        detach();
        input.destroy();
        output?.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, bytes]);
      void drain();
    };
    input.on("data", onData);
    input.once("end", detach);
    input.once("close", detach);
    // Broken transports must not take down their provider owner.
    input.on("error", detach);
    if (output !== input) output?.on("error", detach);
    this.detachInput = detach;
    return detach;
  }

  private async handleLine(line: string, output: Writable | null): Promise<void> {
    let message: JsonRpcRequest;
    try {
      message = Schema.decodeUnknownSync(Request)(JSON.parse(line));
    } catch {
      this.respondError(output, null, -32600, "Invalid JSON-RPC request");
      return;
    }
    try {
      const result = await this.dispatch(message);
      this.writeLine(output, { jsonrpc: "2.0", id: message.id ?? null, result });
    } catch (error) {
      this.respondError(output, message.id ?? null, -32000, String(error));
    }
  }

  private async dispatch(message: JsonRpcRequest): Promise<unknown> {
    const params = message.params;
    switch (message.method) {
      case "agent/hello":
        Schema.decodeUnknownSync(RemoteAgentHelloInput)(params);
        return { agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION };
      case "agent/spawn": {
        const decoded = Schema.decodeUnknownSync(RemoteAgentSpawnInput)(params);
        // Published schemas trim strings; argv and stdin bytes must stay exact.
        const raw = Schema.decodeUnknownSync(
          Schema.Struct({ providerArgv: Schema.Array(Schema.String) }),
        )(params);
        return this.handleSpawn({ ...decoded, providerArgv: raw.providerArgv });
      }
      case "agent/attach":
        return this.handleAttach(Schema.decodeUnknownSync(RemoteAgentAttachInput)(params));
      case "agent/send": {
        const decoded = Schema.decodeUnknownSync(RemoteAgentSendInput)(params);
        const raw = Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.String }))(params);
        return this.handleSend({ ...decoded, payload: raw.payload });
      }
      case "agent/kill": {
        const { threadId } = Schema.decodeUnknownSync(RemoteAgentKillInput)(params);
        const state = this.threads.get(threadId);
        if (!state) throw new Error(`Thread not found: ${threadId}`);
        await this.stop(state);
        await state.completed;
        if (state.failure) throw state.failure;
        return { ok: true };
      }
      case "agent/status":
        Schema.decodeUnknownSync(RemoteAgentStatusInput)(params ?? {});
        return this.handleStatus();
      default:
        throw new Error(`Method not found: ${message.method}`);
    }
  }

  private async handleSpawn(params: RemoteAgentSpawnInput): Promise<{ ok: true }> {
    if (this.closing) throw new Error("Remote agent is shutting down");
    if (process.platform === "win32") throw new Error("Remote agents require a POSIX host");
    const { threadId, executionProfile, providerArgv } = params;
    if (this.threads.has(threadId)) throw new Error(`Thread already exists: ${threadId}`);
    const [command, ...args] = providerArgv;
    if (!command || command.includes("\0") || args.some((arg) => arg.includes("\0"))) {
      throw new Error("providerArgv must contain a valid executable and arguments");
    }
    let seq = 0;
    for (const entry of this.journal.read(threadId)) seq = entry.seq;
    const child = spawnProcess(command, args, {
      cwd: executionProfile.remoteWorkspaceRoot,
      env: process.env,
      ownProcessGroup: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const state: ThreadState = { threadId, child, seq, status: "running", completed };
    this.threads.set(threadId, state);
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    let finishing = false;
    const finish = async (exitCode: number) => {
      if (finishing) return;
      finishing = true;
      try {
        await this.stop(state);
        await closed;
        if (state.failure) throw state.failure;
        this.journalAndNotify(state, { seq: state.seq + 1, kind: "exit", exitCode });
        state.status = "exited";
      } catch (error) {
        state.status = "unknown";
        state.failure = error instanceof Error ? error : new Error(String(error));
        this.fail(error);
      } finally {
        complete();
      }
    };
    child.stdout.on("data", (data: Buffer) => this.emitOutput(state, "stdout", data));
    child.stderr.on("data", (data: Buffer) => this.emitOutput(state, "stderr", data));
    child.stdin.on("error", (error) => {
      this.emitOutput(state, "stderr", Buffer.from(`provider stdin error: ${error.message}`));
    });
    child.once("exit", (code) => {
      void finish(code ?? -1);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        this.emitOutput(state, "stderr", Buffer.from(`spawn error: ${error.message}`));
        void finish(-1);
        reject(error);
      });
    });
    return { ok: true };
  }

  private handleAttach(params: RemoteAgentAttachInput): unknown {
    const { threadId, lastSeq } = params;
    if (lastSeq < 0) throw new Error("lastSeq must be non-negative");
    let latestSeq = 0;
    let status: RemoteAgentThreadStatus = "unknown";
    for (const entry of this.journal.read(threadId)) {
      latestSeq = entry.seq;
      status = entry.kind === "exit" ? "exited" : "unknown";
      if (entry.seq > lastSeq) this.notify("agent/event", { threadId, ...entry });
    }
    const live = this.threads.get(threadId);
    return { status: live?.status ?? status, lastSeq: live?.seq ?? latestSeq };
  }

  private async handleSend(params: RemoteAgentSendInput): Promise<{ ok: true }> {
    const state = this.threads.get(params.threadId);
    if (!state || state.status !== "running" || state.stopping) {
      throw new Error(`Thread not running: ${params.threadId}`);
    }
    const { payload } = params;
    if (
      payload.startsWith("b64:") &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.slice(4))
    ) {
      throw new Error("Invalid base64 stdin payload");
    }
    const data = payload.startsWith("b64:")
      ? Buffer.from(payload.slice(4), "base64")
      : Buffer.from(payload);
    const stdin = state.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Provider stdin is closed");
    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return { ok: true };
  }

  private handleStatus(): unknown {
    const threads = new Map<
      string,
      { threadId: string; seq: number; status: RemoteAgentThreadStatus }
    >();
    for (const threadId of this.journal.threadIds()) {
      let seq = 0;
      let status: RemoteAgentThreadStatus = "unknown";
      for (const entry of this.journal.read(threadId)) {
        seq = entry.seq;
        status = entry.kind === "exit" ? "exited" : "unknown";
      }
      threads.set(threadId, { threadId, seq, status });
    }
    for (const { threadId, seq, status } of this.threads.values())
      threads.set(threadId, { threadId, seq, status });
    return { threads: [...threads.values()] };
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(
      [...this.threads.values()].map(async (state) => {
        await this.stop(state);
        await state.completed;
        if (state.failure) throw state.failure;
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private stop(state: ThreadState): Promise<void> {
    state.stopping ??= terminateOwnedGroup(state.child, this.killGraceMs);
    return state.stopping;
  }

  private emitOutput(state: ThreadState, kind: "stdout" | "stderr", payload: Buffer): void {
    if (state.failure) return;
    try {
      this.journalAndNotify(state, { seq: state.seq + 1, kind, data: payload.toString("base64") });
    } catch (error) {
      state.failure = error instanceof Error ? error : new Error(String(error));
      this.fail(error);
    }
  }

  private journalAndNotify(state: ThreadState, entry: JournalEntry): void {
    this.journal.append(state.threadId, entry);
    state.seq = entry.seq;
    this.notify("agent/event", { threadId: state.threadId, ...entry });
  }

  private fail(error: unknown): void {
    this.output?.destroy();
    this.options.onFatal?.(error);
  }

  private respondError(
    output: Writable | null,
    id: number | string | null,
    code: number,
    message: string,
  ): void {
    this.writeLine(output, { jsonrpc: "2.0", id, error: { code, message } });
  }

  private notify(method: string, params: unknown): void {
    this.writeLine(this.output, { jsonrpc: "2.0", method, params });
  }

  private writeLine(output: Writable | null, message: unknown): void {
    if (!output || output !== this.output || output.destroyed) return;
    if (output.writableLength > MAX_PENDING_OUTPUT_BYTES) {
      output.destroy();
      return;
    }
    output.write(`${JSON.stringify(message)}\n`);
  }
}
