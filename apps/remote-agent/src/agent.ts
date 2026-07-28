import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import type {
  RemoteAgentAttachInput,
  RemoteAgentKillInput,
  RemoteAgentSendInput,
  RemoteAgentSpawnInput,
  RemoteAgentThreadStatus,
} from "@synara/contracts/remoteAgent";

import type { JournalEntry, JsonRpcRequest, ThreadState } from "./types";
import { AGENT_VERSION, PROTOCOL_VERSION } from "./version";

const KILL_GRACE_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 7_000;

const defaultJournalDir = (): string =>
  process.env.SYNARA_AGENT_JOURNAL_DIR ?? join(homedir(), ".synara-agent");

export interface AgentOptions {
  journalDir?: string;
  killGraceMs?: number;
}

export class RemoteAgent {
  private readonly journalDir: string;
  private readonly killGraceMs: number;
  private readonly threads = new Map<string, ThreadState>();
  private readonly output: Writable;
  private buffer = "";

  constructor(output: Writable, options: AgentOptions = {}) {
    this.output = output;
    this.journalDir = options.journalDir ?? defaultJournalDir();
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    mkdirSync(this.journalDir, { recursive: true });
  }

  attachInput(input: Readable): void {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.handleLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stderr.write(`synara-remote-agent: invalid JSON line\n`);
      return;
    }
    try {
      this.dispatch(message);
    } catch (error) {
      this.respondError(message.id ?? null, -32603, String(error));
    }
  }

  private dispatch(message: JsonRpcRequest): void {
    const id = message.id ?? null;
    const params = message.params;
    switch (message.method) {
      case "agent/hello":
        this.respond(id, { agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION });
        return;
      case "agent/spawn":
        this.handleSpawn(id, params as RemoteAgentSpawnInput);
        return;
      case "agent/attach":
        this.handleAttach(id, params as RemoteAgentAttachInput);
        return;
      case "agent/send":
        this.handleSend(id, params as RemoteAgentSendInput);
        return;
      case "agent/kill":
        this.handleKill(id, params as RemoteAgentKillInput);
        return;
      case "agent/status":
        this.handleStatus(id);
        return;
      default:
        this.respondError(id, -32601, `Method not found: ${message.method}`);
    }
  }

  private handleSpawn(id: number | string | null, params: RemoteAgentSpawnInput): void {
    const { threadId, executionProfile, providerArgv } = params;
    if (this.threads.has(threadId)) {
      this.respondError(id, -32000, `Thread already exists: ${threadId}`);
      return;
    }
    const [command, ...args] = providerArgv;
    if (command === undefined) {
      this.respondError(id, -32602, "providerArgv must not be empty");
      return;
    }
    const cwd = executionProfile.remoteWorkspaceRoot || process.cwd();
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state: ThreadState = {
      threadId,
      child,
      seq: this.lastJournalSeq(threadId),
      status: "running",
    };
    this.threads.set(threadId, state);
    child.on("error", (error) => {
      this.emitEvent(state, "stderr", Buffer.from(`spawn error: ${error.message}`));
    });
    child.stdout?.on("data", (data: Buffer) => this.emitEvent(state, "stdout", data));
    child.stderr?.on("data", (data: Buffer) => this.emitEvent(state, "stderr", data));
    child.on("exit", (code) => {
      state.status = "exited";
      this.emitEvent(state, "exit", Buffer.alloc(0), code ?? -1);
    });
    this.respond(id, { ok: true });
  }

  private handleAttach(id: number | string | null, params: RemoteAgentAttachInput): void {
    const { threadId, lastSeq } = params;
    const entries = this.readJournal(threadId);
    const live = this.threads.get(threadId);
    if (live === undefined && entries.length === 0) {
      this.respond(id, { status: "unknown", lastSeq: 0 });
      return;
    }
    for (const entry of entries) {
      if (entry.seq > lastSeq) {
        this.notify("agent/event", {
          threadId,
          seq: entry.seq,
          kind: entry.kind,
          data: entry.data,
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
        });
      }
    }
    const latestSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : (live?.seq ?? 0);
    const status: RemoteAgentThreadStatus =
      live !== undefined
        ? live.status
        : entries.some((entry) => entry.kind === "exit")
          ? "exited"
          : "unknown";
    this.respond(id, { status, lastSeq: latestSeq });
  }

  private handleSend(id: number | string | null, params: RemoteAgentSendInput): void {
    const { threadId, payload } = params;
    const state = this.threads.get(threadId);
    if (state === undefined || state.status !== "running") {
      this.respondError(id, -32001, `Thread not running: ${threadId}`);
      return;
    }
    const data = payload.startsWith("b64:")
      ? Buffer.from(payload.slice(4), "base64")
      : Buffer.from(payload, "utf8");
    state.child.stdin?.write(data);
    this.respond(id, { ok: true });
  }

  private handleKill(id: number | string | null, params: RemoteAgentKillInput): void {
    const state = this.threads.get(params.threadId);
    if (state === undefined) {
      this.respondError(id, -32001, `Thread not found: ${params.threadId}`);
      return;
    }
    this.killGroup(state, this.killGraceMs);
    this.respond(id, { ok: true });
  }

  private handleStatus(id: number | string | null): void {
    const threads = new Map<
      string,
      { threadId: string; seq: number; status: RemoteAgentThreadStatus }
    >();
    for (const state of this.threads.values()) {
      threads.set(state.threadId, {
        threadId: state.threadId,
        seq: state.seq,
        status: state.status,
      });
    }
    for (const file of this.journalFiles()) {
      const threadId = file.slice(0, -".journal".length);
      if (threads.has(threadId)) continue;
      const entries = this.readJournal(threadId);
      const seq = entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
      const status: RemoteAgentThreadStatus = entries.some((entry) => entry.kind === "exit")
        ? "exited"
        : "unknown";
      threads.set(threadId, { threadId, seq, status });
    }
    this.respond(id, { threads: [...threads.values()] });
  }

  shutdown(): void {
    for (const state of this.threads.values()) {
      if (state.status === "running") this.killGroup(state, this.killGraceMs);
    }
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    if ([...this.threads.values()].every((state) => state.status !== "running")) {
      process.exit(0);
    }
  }

  private killGroup(state: ThreadState, graceMs: number): void {
    const pid = state.child.pid;
    if (pid === undefined) return;
    this.signalGroup(pid, "SIGTERM");
    const timer = setTimeout(() => {
      if (state.status === "running") this.signalGroup(pid, "SIGKILL");
    }, graceMs);
    timer.unref();
    state.child.once("exit", () => clearTimeout(timer));
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // process already gone
      }
    }
  }

  private emitEvent(
    state: ThreadState,
    kind: JournalEntry["kind"],
    payload: Buffer,
    exitCode?: number,
  ): void {
    state.seq += 1;
    const entry: JournalEntry = {
      seq: state.seq,
      kind,
      data: payload.toString("base64"),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    this.appendJournal(state.threadId, entry);
    this.notify("agent/event", { threadId: state.threadId, ...entry });
  }

  private journalPath(threadId: string): string {
    return join(this.journalDir, `${threadId}.journal`);
  }

  private journalFiles(): string[] {
    try {
      return readdirSync(this.journalDir).filter((file) => file.endsWith(".journal"));
    } catch {
      return [];
    }
  }

  private appendJournal(threadId: string, entry: JournalEntry): void {
    appendFileSync(this.journalPath(threadId), `${JSON.stringify(entry)}\n`);
  }

  private readJournal(threadId: string): JournalEntry[] {
    const path = this.journalPath(threadId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  private lastJournalSeq(threadId: string): number {
    const entries = this.readJournal(threadId);
    return entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
  }

  private respond(id: number | string | null, result: unknown): void {
    this.writeLine({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string | null, code: number, message: string): void {
    this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private notify(method: string, params: unknown): void {
    this.writeLine({ jsonrpc: "2.0", method, params });
  }

  private writeLine(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
