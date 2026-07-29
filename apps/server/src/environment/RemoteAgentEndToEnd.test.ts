// FILE: RemoteAgentEndToEnd.test.ts
// Purpose: End-to-end remote session survival test (#99 PR VII). The REAL
//          synara-remote-agent bundle (built from apps/remote-agent at test
//          setup) runs as a persistent process with a temporary journal dir
//          and supervises a mock `codex app-server`. The ssh transport is an
//          in-process fake: a unix-socket bridge in the test process plus a
//          tiny "ssh" shim child that pipes its stdio to the socket. Killing
//          the shim mid-turn is exactly an ssh disconnect — the agent and the
//          provider child survive, events are journaled, and the
//          RemoteAgentReconnector reattaches and replays from lastReceivedSeq.
//
// Transport choice: an in-process unix-socket fake instead of a localhost
// sshd. A real sshd (as in the PR #126 installer E2E) proves ssh plumbing but
// makes the disconnect timing racy and needs host keys, ports, and an sshd
// binary on CI. The shim preserves the property under test — the transport
// child dies while the remote agent process survives — deterministically.

import { execFileSync } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-remote-agent-e2e-"));
const journalDir = path.join(tempDir, "journal");
const markerDir = tempDir;
const socketPath = path.join(tempDir, "agent.sock");
const bundlePath = path.join(tempDir, "remote-agent.cjs");
const sshShimPath = path.join(tempDir, "fake-ssh.cjs");
const mockCodexPath = path.join(tempDir, "mock-codex.cjs");

// Build the real agent bundle exactly like `bun run --cwd apps/remote-agent build`.
const agentEntry = fileURLToPath(new URL("../../../remote-agent/src/index.ts", import.meta.url));
execFileSync("bun", [
  "build",
  "--target=node",
  "--format=cjs",
  `--outfile=${bundlePath}`,
  agentEntry,
]);

// "ssh" shim: bridges its stdio to the unix socket the test process serves.
// Dies with 255 (like a real ssh channel) when the socket drops.
writeFileSync(
  sshShimPath,
  `
const net = require("node:net");
const socket = net.connect(process.env.FAKE_SSH_SOCKET);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", () => process.exit(255));
socket.on("close", () => process.exit(255));
`,
);

// Mock \`codex app-server\`: NDJSON JSON-RPC on stdio. Answers initialize, and
// on create_turn streams an assistant message in three deltas gated by marker
// files so the test controls exactly what is emitted before the ssh drop
// ("Hello"), while disconnected (" missed", journal-only), and after resume
// (" world" + the final response).
writeFileSync(
  mockCodexPath,
  `
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const markerDir = process.env.MOCK_CODEX_MARKER_DIR;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const whenFile = (file, callback) => {
  const timer = setInterval(() => {
    if (existsSync(file)) {
      clearInterval(timer);
      callback();
    }
  }, 20);
};

process.on("SIGTERM", () => process.exit(0));

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

function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    return;
  }
  if (message.method === "create_turn") {
    const turnId = message.params.turnId;
    const delta = (text) =>
      write({ jsonrpc: "2.0", method: "item/agent_message_delta", params: { turnId, delta: text } });
    write({ jsonrpc: "2.0", method: "turn/started", params: { turnId } });
    delta("Hello");
    whenFile(join(markerDir, "mid-" + turnId), () => {
      delta(" missed");
      whenFile(join(markerDir, "resume-" + turnId), () => {
        delta(" world");
        write({ jsonrpc: "2.0", id: message.id, result: { message: "Hello missed world" } });
        write({ jsonrpc: "2.0", method: "turn/completed", params: { turnId } });
      });
    });
  }
}
`,
);

// The persistent "remote host": the real agent on its own stdio, plus a
// unix-socket server in the test process bridging one live "ssh connection"
// at a time onto that stdio. Events emitted while no connection is attached
// are dropped here (like on a dead ssh channel) but survive in the journal.
let agentChild: ChildProcessWithoutNullStreams;
let activeSocket: net.Socket | undefined;
const bridge = net.createServer((socket) => {
  activeSocket?.destroy();
  activeSocket = socket;
  socket.on("data", (chunk) => agentChild.stdin.write(chunk));
  socket.on("error", () => {});
  socket.on("close", () => {
    if (activeSocket === socket) activeSocket = undefined;
  });
});

function startRemoteHost(): Promise<void> {
  agentChild = spawn(process.execPath, [bundlePath], {
    cwd: tempDir,
    env: {
      ...process.env,
      SYNARA_AGENT_JOURNAL_DIR: journalDir,
      MOCK_CODEX_MARKER_DIR: markerDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  agentChild.stdout.on("data", (chunk: Buffer) => {
    activeSocket?.write(chunk);
  });
  return new Promise((resolve) => bridge.listen(socketPath, resolve));
}

afterAll(() => {
  activeSocket?.destroy();
  bridge.close();
  agentChild.kill("SIGKILL");
  rmSync(tempDir, { recursive: true, force: true });
});

const executionProfile = Schema.decodeUnknownSync(ExecutionProfile)({
  environmentId: "env-remote",
  providerKind: "codex",
  remoteWorkspaceRoot: tempDir,
});
const transport = Schema.decodeUnknownSync(ExecutionEnvironmentSshTransport)({
  host: "remote.example",
});
const runtime = Schema.decodeUnknownSync(ExecutionEnvironmentRuntime)({
  runtimeType: "ssh-process",
});

const makePlan = (threadId: string): RemoteAgentSpawnPlan => ({
  kind: "remote-agent",
  sshArgs: [sshShimPath],
  remoteCommand: sshShimPath,
  threadId,
  executionProfile,
  providerArgv: [process.execPath, mockCodexPath],
  transport,
  runtime,
});

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: { readonly delta?: string };
  readonly result?: { readonly message?: string };
}

// Stands in for codexAppServerManager: speaks the provider's JSON-RPC over
// the stable proxy streams, deduplicated exactly as the manager would see it.
function makeTurnHarness(child: ChildProcessWithoutNullStreams) {
  const messages: JsonRpcMessage[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as JsonRpcMessage);
      newline = buffer.indexOf("\n");
    }
  });
  return {
    send: (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`),
    deltas: () =>
      messages
        .filter((message) => message.method === "item/agent_message_delta")
        .map((message) => message.params?.delta ?? ""),
    response: (id: number) => messages.find((message) => message.id === id),
    notifications: (method: string) => messages.filter((message) => message.method === method),
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const journaledText = (threadId: string): string => {
  try {
    return readFileSync(path.join(journalDir, `${threadId}.journal`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as { data: string };
        return Buffer.from(entry.data, "base64").toString("utf8");
      })
      .join("");
  } catch {
    return "";
  }
};

describe("remote agent end-to-end survival", () => {
  it("completes a turn straight through with no disconnect", async () => {
    await startRemoteHost();
    const threadId = "thread-baseline";
    const turnId = "turn-baseline";
    // Pre-create both gates so the mock streams the whole turn immediately.
    writeFileSync(path.join(markerDir, `mid-${turnId}`), "");
    writeFileSync(path.join(markerDir, `resume-${turnId}`), "");
    const statusChanges: RemoteAgentConnectionStatusChanged[] = [];
    const provider = makeRemoteAgentProvider(
      process.execPath,
      { ensureAgentInstalled: () => Effect.void },
      { baseDelayMs: 25, maxDelayMs: 100 },
      (event) => statusChanges.push(event),
    );
    const spawned = await Effect.runPromise(
      provider.spawnRemoteAgent(makePlan(threadId), {
        cwd: tempDir,
        env: { ...process.env, FAKE_SSH_SOCKET: socketPath },
      }),
    );
    const harness = makeTurnHarness(spawned.child);

    harness.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await waitFor(() => harness.response(1) !== undefined, "initialize response");
    harness.send({ jsonrpc: "2.0", id: 2, method: "create_turn", params: { turnId } });
    await waitFor(() => harness.response(2) !== undefined, "turn response");

    expect(harness.response(2)?.result?.message).toBe("Hello missed world");
    expect(harness.deltas().join("")).toBe("Hello missed world");
    expect(harness.notifications("turn/completed")).toHaveLength(1);
    expect(statusChanges).toHaveLength(0);

    spawned.kill();
  }, 30_000);

  it("survives an ssh disconnect mid-turn: degrades, reconnects, replays, completes", async () => {
    const threadId = "thread-survival";
    const turnId = "turn-survival";
    const statusChanges: RemoteAgentConnectionStatusChanged[] = [];
    const provider = makeRemoteAgentProvider(
      process.execPath,
      { ensureAgentInstalled: () => Effect.void },
      { baseDelayMs: 25, maxDelayMs: 100 },
      (event) => statusChanges.push(event),
    );
    const spawned = await Effect.runPromise(
      provider.spawnRemoteAgent(makePlan(threadId), {
        cwd: tempDir,
        env: { ...process.env, FAKE_SSH_SOCKET: socketPath },
      }),
    );
    const harness = makeTurnHarness(spawned.child);

    // A completed round trip proves the initial transport is connected (the
    // provider emits status events only for post-spawn transitions).
    harness.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await waitFor(() => harness.response(1) !== undefined, "initialize response");
    harness.send({ jsonrpc: "2.0", id: 2, method: "create_turn", params: { turnId } });
    await waitFor(() => harness.deltas().join("").includes("Hello"), "pre-drop delta");

    // SSH disconnect mid-turn: SIGKILL the ssh shim. The agent, the mock
    // Codex, and the journal all survive on the "remote host".
    const sshPid = spawned.child.pid;
    expect(sshPid).toBeDefined();
    process.kill(sshPid as number, "SIGKILL");
    await waitFor(
      () => statusChanges.some((event) => event.status === "degraded"),
      "degraded status",
    );

    // While disconnected, the mock Codex keeps producing output: it reaches
    // the journal but not the (dead) transport.
    writeFileSync(path.join(markerDir, `mid-${turnId}`), "");
    await waitFor(() => journaledText(threadId).includes(" missed"), "journaled missed delta");
    expect(harness.deltas().join("")).toBe("Hello");

    // Let the turn finish; the reconnector reattaches with backoff and
    // agent/attach replays everything past lastReceivedSeq exactly once.
    writeFileSync(path.join(markerDir, `resume-${turnId}`), "");
    await waitFor(() => harness.response(2) !== undefined, "post-reconnect turn response");

    expect(harness.response(2)?.result?.message).toBe("Hello missed world");
    expect(harness.deltas().join("")).toBe("Hello missed world");
    expect(harness.notifications("turn/started")).toHaveLength(1);
    expect(harness.notifications("turn/completed")).toHaveLength(1);

    // connected (initial spawn) → degraded → reconnecting → connected.
    expect(statusChanges.map((event) => event.status)).toEqual([
      "degraded",
      "reconnecting",
      "connected",
    ]);
    expect(statusChanges[0]).toMatchObject({
      _tag: "RemoteAgentConnectionStatusChanged",
      threadId,
      environmentId: "env-remote",
    });
    const connected = statusChanges.at(-1);
    expect(connected?.retryCount).toBe(1);
    expect(connected?.lastSeq).toBeGreaterThan(0);

    // The thread still tears down over the reconnected transport. kill sends
    // agent/kill and then drops the transport; the settle code is 0 when the
    // provider's exit event wins the race and -1 when the transport close does.
    const exit = new Promise<number | null>((resolve) => {
      spawned.child.once("exit", (code) => resolve(code));
    });
    spawned.kill();
    expect([0, -1]).toContain(await exit);
    expect(spawned.child.exitCode).not.toBeNull();
  }, 30_000);
});
