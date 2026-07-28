// FILE: RemoteAgentProvider.test.ts
// Purpose: Exercises the RemoteAgentProvider transport against a local fake
//          remote agent script that speaks the NDJSON agent protocol over
//          stdio, journals events, and simulates a provider process (#99 PR
//          III). "ssh" is replaced by the node binary running the fake agent.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  ExecutionEnvironmentRuntime,
  ExecutionEnvironmentSshTransport,
  ExecutionProfile,
} from "@synara/contracts";
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

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const executionProfile = Schema.decodeUnknownSync(ExecutionProfile)({
  environmentId: "env-remote",
  providerKind: "codex",
  remoteWorkspaceRoot: "/srv/workspaces/repo",
});

const transport = Schema.decodeUnknownSync(ExecutionEnvironmentSshTransport)({
  host: "remote.example",
});
const runtime = Schema.decodeUnknownSync(ExecutionEnvironmentRuntime)({
  runtimeType: "ssh-process",
});

const makePlan = (threadId: string): RemoteAgentSpawnPlan => ({
  kind: "remote-agent",
  // The "ssh binary" is node and the argv is just the fake agent script.
  sshArgs: [fakeAgentPath],
  remoteCommand: fakeAgentPath,
  threadId,
  executionProfile,
  providerArgv: ["codex", "app-server"],
  transport,
  runtime,
});

const makeOptions = (journalDir: string, extraEnv: NodeJS.ProcessEnv = {}) => ({
  cwd: tempDir,
  env: { ...process.env, SYNARA_AGENT_JOURNAL_DIR: journalDir, ...extraEnv },
});

// The transport tests exercise the wire protocol only; installation is a no-op.
const provider = makeRemoteAgentProvider(process.execPath, {
  ensureAgentInstalled: () => Effect.void,
});

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
});
