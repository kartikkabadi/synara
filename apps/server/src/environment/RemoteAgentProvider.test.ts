// FILE: RemoteAgentProvider.test.ts
// Purpose: Exercises the RemoteAgentProvider transport against a local fake
//          remote agent script that speaks the NDJSON agent protocol over
//          stdio, journals events, and simulates a provider process (#99 PR
//          III). "ssh" is replaced by the node binary running the fake agent.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { ExecutionProfile } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { makeRemoteAgentProvider } from "./Layers/RemoteAgentProvider";
import type { RemoteAgentSpawnPlan } from "./Services/RemoteEnvironmentResolver";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-remote-agent-test-"));
const fakeAgentPath = path.join(tempDir, "fake-agent.cjs");

// Fake remote agent: speaks the agent NDJSON protocol on stdio, simulates the
// provider in-process (echoes stdin sends back as stdout events), and journals
// every event to SYNARA_AGENT_JOURNAL_DIR so a later connection can replay
// them through agent/attach.
writeFileSync(
  fakeAgentPath,
  `
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const journalDir = process.env.SYNARA_AGENT_JOURNAL_DIR;
mkdirSync(journalDir, { recursive: true });
const protocolVersion = process.env.FAKE_PROTOCOL_VERSION || "0.1.0";
const threads = new Map();

const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
const journalPath = (threadId) => join(journalDir, threadId + ".journal");
const readJournal = (threadId) => {
  const file = journalPath(threadId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line));
};
const emitEvent = (threadId, kind, data, exitCode) => {
  const state = threads.get(threadId);
  state.seq += 1;
  const entry = { seq: state.seq, kind, data: Buffer.from(data).toString("base64") };
  if (exitCode !== undefined) entry.exitCode = exitCode;
  appendFileSync(journalPath(threadId), JSON.stringify(entry) + "\\n");
  write({ jsonrpc: "2.0", method: "agent/event", params: { threadId, ...entry } });
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "agent/hello":
      respond(id, { agentVersion: "fake-agent", protocolVersion });
      return;
    case "agent/spawn": {
      if (threads.has(params.threadId)) {
        respondError(id, -32000, "Thread already exists: " + params.threadId);
        return;
      }
      const entries = readJournal(params.threadId);
      threads.set(params.threadId, {
        seq: entries.length ? entries[entries.length - 1].seq : 0,
        status: "running",
      });
      respond(id, { ok: true });
      emitEvent(params.threadId, "stdout", "provider-started\\n");
      emitEvent(params.threadId, "stderr", "provider-warn\\n");
      return;
    }
    case "agent/send": {
      const state = threads.get(params.threadId);
      if (!state || state.status !== "running") {
        respondError(id, -32001, "Thread not running: " + params.threadId);
        return;
      }
      const data = params.payload.startsWith("b64:")
        ? Buffer.from(params.payload.slice(4), "base64")
        : Buffer.from(params.payload, "utf8");
      respond(id, { ok: true });
      emitEvent(params.threadId, "stdout", "echo:" + data.toString("utf8"));
      return;
    }
    case "agent/kill": {
      const state = threads.get(params.threadId);
      if (!state) {
        respondError(id, -32001, "Thread not found: " + params.threadId);
        return;
      }
      state.status = "exited";
      emitEvent(params.threadId, "exit", "", 0);
      respond(id, { ok: true });
      return;
    }
    case "agent/attach": {
      const entries = readJournal(params.threadId);
      for (const entry of entries) {
        if (entry.seq > params.lastSeq) {
          write({
            jsonrpc: "2.0",
            method: "agent/event",
            params: { threadId: params.threadId, ...entry },
          });
        }
      }
      const lastSeq = entries.length ? entries[entries.length - 1].seq : 0;
      const status = entries.some((entry) => entry.kind === "exit") ? "exited" : "unknown";
      respond(id, { status, lastSeq });
      return;
    }
    default:
      respondError(id, -32601, "Method not found: " + method);
  }
}
`,
);

// Long-running fake agent daemon on a Unix domain socket, plus a stdio<->
// socket shim child. Killing the shim drops only the transport while the
// daemon (and its simulated provider threads) keeps running — the shape the
// disconnect-vs-exit regression test needs. NOTE: this daemon/attach model
// exists only for the test; the production `buildAgentSshArgv` command still
// needs the real remote daemon decision from issue #99.
const fakeAgentServerPath = path.join(tempDir, "fake-agent-server.cjs");
writeFileSync(
  fakeAgentServerPath,
  `
const net = require("node:net");

const socketPath = process.argv[2];
const threads = new Map();
const sockets = new Set();

const broadcast = (message) => {
  const line = JSON.stringify(message) + "\\n";
  for (const socket of sockets) socket.write(line);
};
const getThread = (threadId) => {
  let state = threads.get(threadId);
  if (!state) {
    state = { seq: 0, status: "missing", journal: [] };
    threads.set(threadId, state);
  }
  return state;
};
const emitEvent = (threadId, kind, data, exitCode) => {
  const state = getThread(threadId);
  state.seq += 1;
  const entry = { seq: state.seq, kind, data: Buffer.from(data).toString("base64") };
  if (exitCode !== undefined) entry.exitCode = exitCode;
  state.journal.push(entry);
  broadcast({ jsonrpc: "2.0", method: "agent/event", params: { threadId, ...entry } });
};

function handle(socket, message) {
  const { id, method, params } = message;
  const respond = (result) => socket.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  const respondError = (code, msg) =>
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: msg } }) + "\\n");
  switch (method) {
    case "agent/hello":
      respond({ agentVersion: "fake-agent-daemon", protocolVersion: "0.1.0" });
      return;
    case "agent/spawn": {
      if (threads.has(params.threadId)) {
        respondError(-32000, "Thread already exists: " + params.threadId);
        return;
      }
      getThread(params.threadId).status = "running";
      respond({ ok: true });
      emitEvent(params.threadId, "stdout", "provider-started\\n");
      return;
    }
    case "agent/send": {
      const state = threads.get(params.threadId);
      if (!state || state.status !== "running") {
        respondError(-32001, "Thread not running: " + params.threadId);
        return;
      }
      const data = params.payload.startsWith("b64:")
        ? Buffer.from(params.payload.slice(4), "base64")
        : Buffer.from(params.payload, "utf8");
      respond({ ok: true });
      emitEvent(params.threadId, "stdout", "echo:" + data.toString("utf8"));
      return;
    }
    case "agent/kill": {
      const state = threads.get(params.threadId);
      if (!state) {
        respondError(-32001, "Thread not found: " + params.threadId);
        return;
      }
      state.status = "exited";
      emitEvent(params.threadId, "exit", "", 0);
      respond({ ok: true });
      return;
    }
    case "agent/attach": {
      const state = threads.get(params.threadId);
      const journal = state ? state.journal : [];
      for (const entry of journal) {
        if (entry.seq > params.lastSeq) {
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "agent/event",
              params: { threadId: params.threadId, ...entry },
            }) + "\\n",
          );
        }
      }
      respond({
        status: state ? state.status : "missing",
        lastSeq: state ? state.seq : 0,
      });
      return;
    }
    default:
      respondError(-32601, "Method not found: " + method);
  }
}

const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(socket, JSON.parse(line));
      newline = buffer.indexOf("\\n");
    }
  });
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
});
server.listen(socketPath);
`,
);

const shimPath = path.join(tempDir, "shim.cjs");
writeFileSync(
  shimPath,
  `
const net = require("node:net");
const socket = net.connect(process.argv[2]);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
`,
);

const daemons: ChildProcess[] = [];

afterAll(() => {
  for (const daemon of daemons) daemon.kill("SIGKILL");
  rmSync(tempDir, { recursive: true, force: true });
});

const executionProfile = Schema.decodeUnknownSync(ExecutionProfile)({
  environmentId: "env-remote",
  providerKind: "codex",
  remoteWorkspaceRoot: "/srv/workspaces/repo",
});

const makePlan = (threadId: string): RemoteAgentSpawnPlan => ({
  kind: "remote-agent",
  // The "ssh binary" is node and the argv is just the fake agent script.
  sshArgs: [fakeAgentPath],
  remoteCommand: fakeAgentPath,
  threadId,
  executionProfile,
  providerArgv: ["codex", "app-server"],
});

const makeOptions = (journalDir: string, extraEnv: NodeJS.ProcessEnv = {}) => ({
  cwd: tempDir,
  env: { ...process.env, SYNARA_AGENT_JOURNAL_DIR: journalDir, ...extraEnv },
});

const provider = makeRemoteAgentProvider(process.execPath);

function collect(stream: Readable): { read: () => string } {
  let data = "";
  stream.on("data", (chunk: Buffer | string) => {
    data += chunk.toString();
  });
  return { read: () => data };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("RemoteAgentProvider", () => {
  it("connects, spawns, forwards stdout/stderr, echoes stdin sends, and exits on kill", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-spawn-"));
    const spawned = await Effect.runPromise(
      provider.spawnRemoteAgent(makePlan("thread-spawn"), makeOptions(journalDir)),
    );
    const stdout = collect(spawned.child.stdout);
    const stderr = collect(spawned.child.stderr);

    await waitFor(() => stdout.read().includes("provider-started"), "provider stdout");
    await waitFor(() => stderr.read().includes("provider-warn"), "provider stderr");

    spawned.child.stdin.write('{"method":"ping"}\n');
    await waitFor(() => stdout.read().includes('echo:{"method":"ping"}'), "stdin echo");

    const exit = new Promise<number | null>((resolve) => {
      spawned.child.once("exit", (code) => resolve(code));
    });
    spawned.kill();
    expect(await exit).toBe(0);
    expect(spawned.child.exitCode).toBe(0);
  });

  it("fails with RemoteAgentVersionMismatchError on a protocol version mismatch", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-version-"));
    const error = await Effect.runPromise(
      provider
        .spawnRemoteAgent(
          makePlan("thread-version"),
          makeOptions(journalDir, { FAKE_PROTOCOL_VERSION: "9.9.9" }),
        )
        .pipe(Effect.flip),
    );
    expect(error._tag).toBe("RemoteAgentVersionMismatchError");
  });

  it("replays journaled events through agent/attach after a reconnect", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-attach-"));
    const plan = makePlan("thread-attach");

    const first = await Effect.runPromise(provider.spawnRemoteAgent(plan, makeOptions(journalDir)));
    const firstStdout = collect(first.child.stdout);
    first.child.stdin.write("turn-one\n");
    await waitFor(() => firstStdout.read().includes("echo:turn-one"), "first connection echo");

    // Disconnect: kill the provider (journals an exit event) and the channel.
    const firstExit = new Promise<void>((resolve) => {
      first.child.once("exit", () => resolve());
    });
    first.kill();
    await firstExit;

    // Reconnect with a fresh agent process and replay the journal from seq 0.
    const { process: second, attach } = await Effect.runPromise(
      provider.attachRemoteAgent(plan, 0, makeOptions(journalDir)),
    );
    const secondStdout = collect(second.child.stdout);
    await waitFor(
      () =>
        secondStdout.read().includes("provider-started") &&
        secondStdout.read().includes("echo:turn-one"),
      "replayed stdout events",
    );
    expect(attach.status).toBe("exited");
    expect(attach.lastSeq).toBeGreaterThanOrEqual(4);
    second.kill();
  });

  it("does not emit exit when only the transport drops; a fresh attach continues the thread", async () => {
    const socketPath = path.join(tempDir, "agent.sock");
    const daemon = spawn(process.execPath, [fakeAgentServerPath, socketPath], {
      stdio: "ignore",
    });
    daemons.push(daemon);
    await waitFor(() => existsSync(socketPath), "daemon socket");

    const plan: RemoteAgentSpawnPlan = {
      ...makePlan("thread-transport-drop"),
      sshArgs: [shimPath, socketPath],
      remoteCommand: shimPath,
    };
    const journalDir = mkdtempSync(path.join(tempDir, "journal-transport-"));

    const first = await Effect.runPromise(provider.spawnRemoteAgent(plan, makeOptions(journalDir)));
    const firstStdout = collect(first.child.stdout);
    await waitFor(() => firstStdout.read().includes("provider-started"), "provider stdout");
    first.child.stdin.write("turn-one\n");
    await waitFor(() => firstStdout.read().includes("echo:turn-one"), "first echo");

    // Drop only the transport: SIGKILL the shim. The daemon and its provider
    // thread keep running; the adapter must report a disconnect, not an exit.
    let exited = false;
    let disconnected = false;
    first.child.once("exit", () => {
      exited = true;
    });
    first.child.once("disconnect", () => {
      disconnected = true;
    });
    process.kill(first.child.pid as number, "SIGKILL");
    await waitFor(() => disconnected, "transport disconnect");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exited).toBe(false);
    expect(first.child.exitCode).toBe(null);

    // Reconnect through a fresh shim and continue the same thread.
    const { process: second, attach } = await Effect.runPromise(
      provider.attachRemoteAgent(plan, 0, makeOptions(journalDir)),
    );
    const secondStdout = collect(second.child.stdout);
    await waitFor(
      () =>
        secondStdout.read().includes("provider-started") &&
        secondStdout.read().includes("echo:turn-one"),
      "replayed events after transport drop",
    );
    expect(attach.status).toBe("running");

    second.child.stdin.write("turn-two\n");
    await waitFor(() => secondStdout.read().includes("echo:turn-two"), "post-reattach echo");

    const exit = new Promise<number | null>((resolve) => {
      second.child.once("exit", (code) => resolve(code));
    });
    second.kill();
    expect(await exit).toBe(0);
  });
});
