import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = "/Users/user/.synara/worktrees/devin-combined-live-proof";
const evidenceRoot = "/tmp/devin-reliability-matrix/ws";
const [modelUid, effort, label, phrase, modeArg] = process.argv.slice(2);
if (!modelUid || !label || !phrase) {
  console.error("usage: node ws-session.mjs <modelUid> <effort|-> <label> <phrase> [quiet|periodic]");
  process.exit(2);
}
const mode = modeArg ?? "quiet";
const runId = randomUUID().slice(0, 8);
const out = join(evidenceRoot, `${label}-${runId}`);
const stateHome = join(evidenceRoot, `state-${label}-${runId}`);
const serverPort = 61850 + Math.floor(Math.random() * 100);
const offset = 4850 + Math.floor(Math.random() * 100);
const webPort = 5733 + offset;
mkdirSync(out, { recursive: true });
mkdirSync(stateHome, { recursive: true, mode: 0o700 });

const baseEnv = {
  ...process.env,
  SYNARA_PORT_OFFSET: String(offset),
  SYNARA_NO_BROWSER: "1",
  SYNARA_LOG_WS_EVENTS: "1",
  SYNARA_LOG_PROVIDER_EVENTS: "1",
  SYNARA_DEVIN_ACP_DEBUG: "1",
  SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS: "10000",
  SYNARA_DEVIN_TOOL_IDLE_TIMEOUT_MS: "40000",
};
delete baseEnv.SYNARA_AUTH_TOKEN;
writeFileSync(join(out, "env-proof.json"), JSON.stringify({
  turnIdleMs: 10000, toolIdleMs: 40000, port: serverPort, offset, webPort,
  authTokenUnset: baseEnv.SYNARA_AUTH_TOKEN === undefined, modelUid, effort, label, mode,
}, null, 2));

const runtime = spawn("bun", ["run", "dev", "--", "--home-dir", stateHome, "--port", String(serverPort)],
  { cwd: root, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
let runtimeLog = "";
runtime.stdout.on("data", (c) => (runtimeLog += c));
runtime.stderr.on("data", (c) => (runtimeLog += c));

const waitPort = async () => {
  for (let i = 0; i < 180; i++) {
    if (spawnSync("lsof", ["-nP", `-iTCP:${serverPort}`, "-sTCP:LISTEN"], { encoding: "utf8" }).status === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server port did not open");
};

const quietCmd = "sleep 24 && git status --short";
const periodicCmd = "for i in 1 2 3 4 5 6; do echo tick $i; sleep 4; done";
const cmd = mode === "periodic" ? periodicCmd : quietCmd;
const prompt = `Use exactly one shell exec tool call. ${mode === "periodic"
  ? `Run this exact bounded local command as one foreground command and wait for it to finish: ${cmd}.`
  : `Start this exact bounded local command in the background: ${cmd}. Then use get_output with timeout 25000 milliseconds to wait for it to finish.`} Do not use any other tool before or after it. Do not edit or create files. Do not access the network or any external service. Do not perform external writes. After the command finishes, reply with exactly: ${phrase}`;

async function main() {
  await waitPort();
  await new Promise((r) => setTimeout(r, 3000));

  const negotiateUrl = `http://127.0.0.1:${serverPort}/ws/negotiate?x-synara-client-build=0.8.0&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1` +
    "&x-synara-required-capability=orchestration.cursor-safe-streams&x-synara-required-capability=orchestration.thread-detail-snapshot&x-synara-required-capability=rpc.typed-errors&x-synara-required-capability=git.worktree-setup-progress";
  const negRes = await fetch(negotiateUrl, { cache: "no-store" });
  const neg = await negRes.json();
  writeFileSync(join(out, "negotiate.json"), JSON.stringify(neg, null, 2));

  const wsUrl = `ws://127.0.0.1:${serverPort}/ws?x-synara-client-build=0.8.0&x-synara-protocol-epoch=1&x-synara-protocol-revision=${neg.negotiatedRevision}&x-synara-server-instance=${neg.serverInstanceId}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error("ws error"));
    setTimeout(() => reject(new Error("ws connect timeout")), 15000);
  });

  let nextId = 1;
  const pending = new Map();
  const frames = [];
  ws.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    frames.push({ at: new Date().toISOString(), data });
    if (data._tag === "Exit" && pending.has(String(data.requestId))) {
      const { resolve, reject } = pending.get(String(data.requestId));
      pending.delete(String(data.requestId));
      if (data.exit?._tag === "Success") resolve(data.exit.value);
      else reject(new Error(JSON.stringify(data.exit).slice(0, 300)));
    }
  };
  const rpc = (tag, payload, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({
      _tag: "Request", id, tag, payload,
      traceId: randomUUID(), spanId: randomUUID().slice(0, 16), sampled: true, headers: [],
    }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${tag}`)); }
    }, timeoutMs);
  });

  const projectId = randomUUID();
  const threadId = randomUUID();
  const commandId = () => randomUUID();
  const modelSelection = { provider: "devin", model: modelUid };
  const turnModelSelection = effort && effort !== "-"
    ? { provider: "devin", model: modelUid, options: { reasoningEffort: effort } }
    : { provider: "devin", model: modelUid };

  const dispatch = async (cmd, name) => {
    try { return await rpc("orchestration.dispatchCommand", cmd) }
    catch (e) { throw new Error(`dispatch ${name} failed: ${e.message}`) }
  };
  await dispatch({
    type: "project.create", commandId: commandId(), projectId,
    title: `ws-${label}`, workspaceRoot: root, createdAt: new Date().toISOString(),
  }, "project.create");
  await dispatch({
    type: "thread.create", commandId: commandId(), threadId, projectId,
    title: `ws ${label} ${modelUid}`, modelSelection,
    runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
    createdAt: new Date().toISOString(),
  }, "thread.create");
  const startedAt = Date.now();
  await dispatch({
    type: "thread.turn.start", commandId: commandId(), threadId,
    message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
    modelSelection: turnModelSelection, runtimeMode: "full-access", interactionMode: "default",
    createdAt: new Date().toISOString(),
  }, "thread.turn.start");

  let detail = null;
  let phraseSeen = false;
  let turnState = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try { detail = await rpc("orchestration.getThreadDetailSnapshot", { threadId }, 15000); } catch { continue; }
    const msgs = detail?.thread?.messages ?? [];
    turnState = detail?.thread?.latestTurn?.state ?? null;
    phraseSeen = msgs.some((m) => m.role === "assistant" && (m.text ?? "").includes(phrase));
    if (phraseSeen && turnState && turnState !== "running" && turnState !== "pending") break;
  }
  const activeSeconds = Math.round((Date.now() - startedAt) / 1000);
  writeFileSync(join(out, "final-detail.json"), JSON.stringify(detail, null, 2));
  writeFileSync(join(out, "ws-frames.json"), JSON.stringify(frames).slice(0, 20000000));

  ws.close();
  runtime.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 3000));
  if (!runtime.killed) runtime.kill("SIGTERM");
  for (const pid of (spawnSync("lsof", ["-tiTCP:" + serverPort, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean)) {
    spawnSync("kill", ["-TERM", pid.trim()]);
  }
  writeFileSync(join(out, "runtime.log"), runtimeLog);

  const db = join(stateHome, "dev/state.sqlite");
  let ledger = [];
  if (existsSync(db)) {
    const dbCopy = join(out, "state-copy.sqlite");
    for (const ext of ["", "-wal", "-shm"]) {
      if (existsSync(db + ext)) spawnSync("cp", [db + ext, dbCopy + ext]);
    }
    const q = "select sequence,event_type,occurred_at,payload_json from orchestration_events order by sequence;";
    const res = spawnSync("sqlite3", [dbCopy, q], { encoding: "utf8", maxBuffer: 50_000_000 });
    if (res.stdout) {
      ledger = res.stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [sequence, event_type, occurred_at, payload_json] = line.split("|");
        let payload = null;
        try { payload = JSON.parse(payload_json); } catch {}
        return { sequence: Number(sequence), event_type, occurred_at, payload };
      });
    }
  }
  writeFileSync(join(out, "orchestration-events.json"), JSON.stringify(ledger, null, 2));
  if (existsSync(join(stateHome, "dev/logs/server.log"))) {
    const { cpSync } = await import("node:fs");
    cpSync(join(stateHome, "dev/logs/server.log"), join(out, "server.log"));
  }

  const created = ledger.find((e) => e.event_type === "thread.created");
  const requested = ledger.find((e) => e.event_type === "thread.turn-start-requested");
  const activities = ledger.filter((e) => e.event_type === "thread.activity-appended").map((e) => e.payload?.activity).filter(Boolean);
  const toolStart = activities.find((a) => a.kind === "tool.started");
  const toolDone = [...activities].reverse().find((a) => a.kind === "tool.completed");
  const timeouts = /turn idle timeout|turn_idle_timeout/i.test(runtimeLog + (existsSync(join(out, "server.log")) ? readFileSync(join(out, "server.log"), "utf8") : ""));
  const createdSel = created?.payload?.modelSelection;
  const requestedSel = requested?.payload?.modelSelection;
  const selMatches = JSON.stringify(createdSel) === JSON.stringify(modelSelection)
    && JSON.stringify(requestedSel) === JSON.stringify(turnModelSelection);
  const result = {
    runId, label, modelUid, effort, mode, phrase,
    turnState,
    result: created && requested && toolStart && toolDone && phraseSeen && selMatches && !timeouts && turnState !== "running" ? "PASS" : "FAIL",
    modelSelectionMatch: selMatches,
    createdSelection: createdSel, requestedSelection: requestedSel,
    toolStarted: Boolean(toolStart), toolCompleted: Boolean(toolDone),
    toolKinds: activities.filter((a) => a.kind?.startsWith("tool.")).map((a) => a.kind),
    phraseSeen, activeSeconds, serverTimeout: timeouts,
    threadId, projectId,
    checks: {
      threadCreated: Boolean(created), turnRequested: Boolean(requested),
    },
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (result.result !== "PASS") process.exitCode = 2;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  runtime.kill("SIGINT");
  setTimeout(() => { try { runtime.kill("SIGTERM"); } catch {} }, 2000);
  for (const pid of (spawnSync("lsof", ["-tiTCP:" + serverPort, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean)) {
    spawnSync("kill", ["-TERM", pid.trim()]);
  }
  process.exitCode = 2;
});
