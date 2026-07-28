import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

const packageRoot = join(__dirname, "..");
const binaryPath = join(packageRoot, "dist", "remote-agent.cjs");

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class AgentHarness {
  readonly journalDir: string;
  private readonly child: ChildProcess;
  private readonly messages: RpcMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
  }> = [];
  private buffer = "";
  private nextId = 1;

  constructor() {
    this.journalDir = mkdtempSync(join(tmpdir(), "synara-agent-test-"));
    this.child = spawn(process.execPath, [binaryPath], {
      env: { ...process.env, SYNARA_AGENT_JOURNAL_DIR: this.journalDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.receive(JSON.parse(line) as RpcMessage);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  private receive(message: RpcMessage): void {
    this.messages.push(message);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i]!;
      if (waiter.predicate(message)) {
        this.waiters.splice(i, 1);
        waiter.resolve(message);
      }
    }
  }

  waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 5_000): Promise<RpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return this.waitFor((message) => message.id === id);
  }

  events(threadId: string): RpcMessage[] {
    return this.messages.filter(
      (message) => message.method === "agent/event" && message.params?.["threadId"] === threadId,
    );
  }

  close(): void {
    this.child.kill("SIGKILL");
    rmSync(this.journalDir, { recursive: true, force: true });
  }
}

const executionProfile = {
  environmentId: "env-1",
  providerKind: "codex",
  remoteWorkspaceRoot: process.cwd(),
};

let harness: AgentHarness;

beforeAll(() => {
  execFileSync("bun", ["run", "build"], { cwd: packageRoot, stdio: "inherit" });
});

afterEach(() => {
  harness?.close();
});

afterAll(() => {
  harness?.close();
});

test("agent/hello returns versions", async () => {
  harness = new AgentHarness();
  const response = await harness.request("agent/hello", {
    agentVersion: "0.0.0",
    protocolVersion: "0.1.0",
  });
  expect(response.result).toEqual({ agentVersion: "0.1.0", protocolVersion: "0.1.0" });
});

test("agent/spawn emits journaled stdout and exit events", async () => {
  harness = new AgentHarness();
  const threadId = "thread-spawn";
  const response = await harness.request("agent/spawn", {
    threadId,
    executionProfile,
    providerArgv: [process.execPath, "-e", "process.stdout.write('hello from provider')"],
  });
  expect(response.result).toEqual({ ok: true });

  const exitEvent = await harness.waitFor(
    (message) =>
      message.method === "agent/event" &&
      message.params?.["threadId"] === threadId &&
      message.params?.["kind"] === "exit",
  );
  expect(exitEvent.params?.["exitCode"]).toBe(0);

  const stdoutEvents = harness
    .events(threadId)
    .filter((message) => message.params?.["kind"] === "stdout");
  const combined = stdoutEvents
    .map((message) => Buffer.from(message.params?.["data"] as string, "base64").toString("utf8"))
    .join("");
  expect(combined).toBe("hello from provider");

  const journal = readFileSync(join(harness.journalDir, `${threadId}.journal`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { seq: number; kind: string });
  expect(journal.map((entry) => entry.kind)).toContain("stdout");
  expect(journal[journal.length - 1]?.kind).toBe("exit");
  expect(journal.map((entry) => entry.seq)).toEqual(journal.map((_, index) => index + 1));

  const duplicate = await harness.request("agent/spawn", {
    threadId,
    executionProfile,
    providerArgv: [process.execPath, "-e", ""],
  });
  expect(duplicate.error?.message).toContain("already exists");
});

test("agent/attach replays journal entries after lastSeq", async () => {
  harness = new AgentHarness();
  const threadId = "thread-attach";
  await harness.request("agent/spawn", {
    threadId,
    executionProfile,
    providerArgv: [process.execPath, "-e", "process.stdout.write('replay me')"],
  });
  const exitEvent = await harness.waitFor(
    (message) =>
      message.method === "agent/event" &&
      message.params?.["threadId"] === threadId &&
      message.params?.["kind"] === "exit",
  );
  const originalEvents = harness.events(threadId).map((message) => message.params);

  const attach = await harness.request("agent/attach", { threadId, lastSeq: 0 });
  expect(attach.result?.["status"]).toBe("exited");
  expect(attach.result?.["lastSeq"]).toBe(exitEvent.params?.["seq"]);

  const replayed = harness.events(threadId).slice(originalEvents.length);
  expect(replayed.map((message) => message.params)).toEqual(originalEvents);

  const unknown = await harness.request("agent/attach", { threadId: "missing", lastSeq: 0 });
  expect(unknown.result?.["status"]).toBe("unknown");
});

test("agent/send forwards raw and base64 payloads to provider stdin", async () => {
  harness = new AgentHarness();
  const threadId = "thread-send";
  await harness.request("agent/spawn", {
    threadId,
    executionProfile,
    providerArgv: [
      process.execPath,
      "-e",
      "process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0))",
    ],
  });
  await harness.request("agent/send", { threadId, payload: "plain " });
  await harness.request("agent/send", {
    threadId,
    payload: `b64:${Buffer.from("decoded").toString("base64")}`,
  });
  await harness.waitFor((message) => {
    if (message.method !== "agent/event" || message.params?.["threadId"] !== threadId) {
      return false;
    }
    const combined = harness
      .events(threadId)
      .filter((event) => event.params?.["kind"] === "stdout")
      .map((event) => Buffer.from(event.params?.["data"] as string, "base64").toString("utf8"))
      .join("");
    return combined === "plain decoded";
  });
  await harness.request("agent/kill", { threadId });
});

test("agent/kill terminates a running provider", async () => {
  harness = new AgentHarness();
  const threadId = "thread-kill";
  await harness.request("agent/spawn", {
    threadId,
    executionProfile,
    providerArgv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  });
  const response = await harness.request("agent/kill", { threadId });
  expect(response.result).toEqual({ ok: true });
  const exitEvent = await harness.waitFor(
    (message) =>
      message.method === "agent/event" &&
      message.params?.["threadId"] === threadId &&
      message.params?.["kind"] === "exit",
  );
  expect(exitEvent.params?.["exitCode"]).not.toBe(0);

  const status = await harness.request("agent/status");
  const threads = status.result?.["threads"] as Array<{ threadId: string; status: string }>;
  expect(threads.find((thread) => thread.threadId === threadId)?.status).toBe("exited");
});

test("agent/status lists running and journaled threads", async () => {
  harness = new AgentHarness();
  const runningId = "thread-running";
  const exitedId = "thread-exited";
  await harness.request("agent/spawn", {
    threadId: runningId,
    executionProfile,
    providerArgv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  });
  await harness.request("agent/spawn", {
    threadId: exitedId,
    executionProfile,
    providerArgv: [process.execPath, "-e", "process.stdout.write('done')"],
  });
  await harness.waitFor(
    (message) =>
      message.method === "agent/event" &&
      message.params?.["threadId"] === exitedId &&
      message.params?.["kind"] === "exit",
  );
  const status = await harness.request("agent/status");
  const threads = status.result?.["threads"] as Array<{
    threadId: string;
    seq: number;
    status: string;
  }>;
  expect(threads.find((thread) => thread.threadId === runningId)?.status).toBe("running");
  expect(threads.find((thread) => thread.threadId === exitedId)?.status).toBe("exited");
  await harness.request("agent/kill", { threadId: runningId });
});
