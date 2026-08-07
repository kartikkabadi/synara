// FILE: RemoteAgentProvider.reconnect.test.ts
// Purpose: Exercises the reconnect loop of the RemoteAgentProvider proxy (#99
//          PR V) against a fake remote agent that drops the transport after
//          spawning, journals events emitted while disconnected, and replays
//          them through agent/attach on the next connection. "ssh" is
//          replaced by the node binary running the fake agent.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  ExecutionEnvironmentRuntime,
  ExecutionEnvironmentSshTransport,
  ExecutionProfile,
  type RemoteAgentConnectionStatusChanged,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { makeRemoteAgentProvider } from "./Layers/RemoteAgentProvider";
import type { RemoteAgentSpawnPlan } from "./Services/RemoteEnvironmentResolver";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-remote-agent-reconnect-test-"));
const fakeAgentPath = path.join(tempDir, "fake-agent.cjs");

// Fake remote agent speaking the NDJSON agent protocol on stdio. Beyond the
// base protocol it simulates a transport drop: when FAKE_DROP_FILE exists the
// agent consumes it after agent/spawn, journals two "missed" events without
// emitting them (events produced while the client was disconnected), and
// exits 255 like a dying ssh channel. If FAKE_POISON_FILE is also configured
// it is created on drop, making every later hello answer with a bad protocol
// version so reconnect attempts fail.
writeFileSync(
  fakeAgentPath,
  `
const { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const journalDir = process.env.SYNARA_AGENT_JOURNAL_DIR;
mkdirSync(journalDir, { recursive: true });
const dropFile = process.env.FAKE_DROP_FILE;
const poisonFile = process.env.FAKE_POISON_FILE;
const attachUnknownFile = process.env.FAKE_ATTACH_UNKNOWN_FILE;
const dropAfterAttachFile = process.env.FAKE_DROP_AFTER_ATTACH_FILE;
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
const journalEntry = (threadId, kind, data, exitCode) => {
  const state = threads.get(threadId);
  state.seq += 1;
  const entry =
    kind === "exit"
      ? { seq: state.seq, kind, exitCode }
      : { seq: state.seq, kind, data: Buffer.from(data).toString("base64") };
  appendFileSync(journalPath(threadId), JSON.stringify(entry) + "\\n");
  return entry;
};
const emitEvent = (threadId, kind, data, exitCode) => {
  const entry = journalEntry(threadId, kind, data, exitCode);
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
    case "agent/hello": {
      const poisoned = poisonFile && existsSync(poisonFile);
      respond(id, { agentVersion: "fake-agent", protocolVersion: poisoned ? "0.0.0" : "0.1.0" });
      return;
    }
    case "agent/spawn": {
      threads.set(params.threadId, { seq: 0, status: "running" });
      respond(id, { ok: true });
      emitEvent(params.threadId, "stdout", "provider-started\\n");
      emitEvent(params.threadId, "stderr", "provider-warn\\n");
      if (dropFile && existsSync(dropFile)) {
        unlinkSync(dropFile);
        if (poisonFile) writeFileSync(poisonFile, "poison");
        journalEntry(params.threadId, "stdout", "missed-1\\n");
        journalEntry(params.threadId, "stdout", "missed-2\\n");
        setTimeout(() => process.exit(255), 50);
      }
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
      emitEvent(params.threadId, "stderr", "err:" + data.toString("utf8"));
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
      appendFileSync(join(journalDir, params.threadId + ".attach.log"), params.lastSeq + "\\n");
      if (attachUnknownFile && existsSync(attachUnknownFile)) {
        unlinkSync(attachUnknownFile);
        respond(id, { status: "unknown", lastSeq: 0 });
        return;
      }
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
      const exited = entries.some((entry) => entry.kind === "exit");
      if (!exited) {
        threads.set(params.threadId, { seq: lastSeq, status: "running" });
      }
      respond(id, { status: exited ? "exited" : "running", lastSeq });
      if (dropAfterAttachFile && existsSync(dropAfterAttachFile)) {
        unlinkSync(dropAfterAttachFile);
        journalEntry(params.threadId, "stdout", "missed-after-attach\\n");
        setTimeout(() => process.exit(255), 50);
        return;
      }
      if (!exited) emitEvent(params.threadId, "stdout", "agent-reattached\\n");
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

function collect(stream: Readable): { read: () => string } {
  let data = "";
  stream.on("data", (chunk: Buffer | string) => {
    data += chunk.toString();
  });
  return { read: () => data };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("RemoteAgentProvider reconnect", () => {
  it("survives a transport drop: replays missed events once and keeps forwarding", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-drop-"));
    const dropFile = path.join(journalDir, "drop-once");
    writeFileSync(dropFile, "drop");
    const statusChanges: RemoteAgentConnectionStatusChanged[] = [];
    const provider = makeRemoteAgentProvider(
      process.execPath,
      { ensureAgentInstalled: () => Effect.void },
      { baseDelayMs: 10, maxDelayMs: 40 },
      (event) => statusChanges.push(event),
    );

    const spawned = await Effect.runPromise(
      provider.spawnRemoteAgent(
        makePlan("thread-drop"),
        makeOptions(journalDir, { FAKE_DROP_FILE: dropFile }),
      ),
    );
    const stdout = collect(spawned.child.stdout);
    const stderr = collect(spawned.child.stderr);

    // Events before the drop arrive on the first connection.
    await waitFor(() => stdout.read().includes("provider-started"), "pre-drop stdout");
    await waitFor(() => stderr.read().includes("provider-warn"), "pre-drop stderr");

    // The transport dies (exit 255); the proxy reconnects and agent/attach
    // replays only the events journaled while disconnected.
    await waitFor(() => stdout.read().includes("missed-2"), "replayed missed events");
    await waitFor(() => stdout.read().includes("agent-reattached"), "post-attach event");
    expect(count(stdout.read(), "provider-started")).toBe(1);
    expect(count(stderr.read(), "provider-warn")).toBe(1);
    expect(count(stdout.read(), "missed-1")).toBe(1);
    expect(count(stdout.read(), "missed-2")).toBe(1);

    // stdin and stderr keep flowing over the new connection.
    spawned.child.stdin.write("after-reconnect\n");
    await waitFor(() => stdout.read().includes("echo:after-reconnect"), "post-reconnect echo");
    await waitFor(() => stderr.read().includes("err:after-reconnect"), "post-reconnect stderr");

    // Exit forwarding still settles the same proxy after the reconnect.
    const exit = new Promise<number | null>((resolve) => {
      spawned.child.once("exit", (code) => resolve(code));
    });
    spawned.kill();
    expect(await exit).toBe(0);
    expect(spawned.child.exitCode).toBe(0);

    // The drop/reconnect cycle emits degraded → reconnecting → connected
    // domain events tagged with the thread and environment.
    expect(statusChanges.map((event) => event.status)).toEqual([
      "degraded",
      "reconnecting",
      "connected",
    ]);
    expect(statusChanges[0]).toMatchObject({
      _tag: "RemoteAgentConnectionStatusChanged",
      threadId: "thread-drop",
      environmentId: "env-remote",
    });
    const connected = statusChanges.at(-1);
    expect(connected?.retryCount).toBe(1);
    expect(connected?.lastSeq).toBeGreaterThan(0);
  });

  it("settles the exit with RemoteAgentReconnectFailedError when retries are exhausted", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-exhaust-"));
    const dropFile = path.join(journalDir, "drop-once");
    const poisonFile = path.join(journalDir, "poison");
    writeFileSync(dropFile, "drop");
    const statusChanges: RemoteAgentConnectionStatusChanged[] = [];
    const provider = makeRemoteAgentProvider(
      process.execPath,
      { ensureAgentInstalled: () => Effect.void },
      { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
      (event) => statusChanges.push(event),
    );

    const spawned = await Effect.runPromise(
      provider.spawnRemoteAgent(
        makePlan("thread-exhaust"),
        makeOptions(journalDir, { FAKE_DROP_FILE: dropFile, FAKE_POISON_FILE: poisonFile }),
      ),
    );
    const errors: Array<{ _tag?: string }> = [];
    spawned.child.on("error", (error) => errors.push(error as { _tag?: string }));
    const exit = new Promise<number | null>((resolve) => {
      spawned.child.once("exit", (code) => resolve(code));
    });

    expect(await exit).toBe(255);
    expect(errors.some((error) => error._tag === "RemoteAgentReconnectFailedError")).toBe(true);

    // Exhausted retries end in a terminal disconnected status.
    expect(statusChanges.map((event) => event.status)).toEqual([
      "degraded",
      "reconnecting",
      "degraded",
      "reconnecting",
      "degraded",
      "disconnected",
    ]);
    const disconnected = statusChanges.at(-1);
    expect(disconnected?.retryCount).toBe(2);
    expect(disconnected?.message).toBeDefined();
  });

  it("retries when agent/attach returns a non-authoritative unknown status", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-unknown-"));
    const dropFile = path.join(journalDir, "drop-once");
    const unknownFile = path.join(journalDir, "attach-unknown-once");
    writeFileSync(dropFile, "drop");
    writeFileSync(unknownFile, "unknown");
    const provider = makeRemoteAgentProvider(
      process.execPath,
      { ensureAgentInstalled: () => Effect.void },
      { baseDelayMs: 10, maxDelayMs: 40 },
    );

    const spawned = await Effect.runPromise(
      provider.spawnRemoteAgent(
        makePlan("thread-unknown"),
        makeOptions(journalDir, {
          FAKE_DROP_FILE: dropFile,
          FAKE_ATTACH_UNKNOWN_FILE: unknownFile,
        }),
      ),
    );
    const stdout = collect(spawned.child.stdout);
    let exited = false;
    spawned.child.once("exit", () => {
      exited = true;
    });

    // First reattach answers "unknown" and must not count as connected; the
    // loop retries and the second attach succeeds and replays missed events.
    await waitFor(() => stdout.read().includes("agent-reattached"), "reattach after unknown");
    const attachLog = readFileSync(path.join(journalDir, "thread-unknown.attach.log"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(attachLog.length).toBeGreaterThanOrEqual(2);
    expect(exited).toBe(false);
    expect(count(stdout.read(), "missed-1")).toBe(1);
    expect(count(stdout.read(), "missed-2")).toBe(1);
    spawned.kill();
  });

  it("reattaches with the seeded non-zero lastSeq when the first attach replayed nothing", async () => {
    const journalDir = mkdtempSync(path.join(tempDir, "journal-seeded-"));
    const dropAfterAttachFile = path.join(journalDir, "drop-after-attach-once");
    writeFileSync(dropAfterAttachFile, "drop");
    const threadId = "thread-seeded";
    // Pre-populate the journal with three already-consumed events.
    writeFileSync(
      path.join(journalDir, `${threadId}.journal`),
      [1, 2, 3]
        .map((seq) =>
          JSON.stringify({
            seq,
            kind: "stdout",
            data: Buffer.from(`pre-${seq}\n`).toString("base64"),
          }),
        )
        .join("\n") + "\n",
    );
    const provider = makeRemoteAgentProvider(
      process.execPath,
      { ensureAgentInstalled: () => Effect.void },
      { baseDelayMs: 10, maxDelayMs: 40 },
    );

    // First attach starts at lastSeq 3: nothing is replayed, then the fake
    // agent journals one missed event and drops the transport.
    const { process: spawned, attach } = await Effect.runPromise(
      provider.attachRemoteAgent(
        makePlan(threadId),
        3,
        makeOptions(journalDir, { FAKE_DROP_AFTER_ATTACH_FILE: dropAfterAttachFile }),
      ),
    );
    expect(attach.status).toBe("running");
    const stdout = collect(spawned.child.stdout);

    // The reattach must send the seeded lastSeq (3), not 0, so only the
    // missed event is replayed and the consumed pre-* events never re-emit.
    await waitFor(() => stdout.read().includes("missed-after-attach"), "replayed missed event");
    await waitFor(() => stdout.read().includes("agent-reattached"), "post-reattach event");
    const attachLog = readFileSync(path.join(journalDir, `${threadId}.attach.log`), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(attachLog).toEqual(["3", "3"]);
    expect(stdout.read()).not.toContain("pre-");
    spawned.kill();
  });
});
