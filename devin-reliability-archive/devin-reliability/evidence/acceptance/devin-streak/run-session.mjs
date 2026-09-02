import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const session = Number(process.argv[2]);
const commands = [
  "sleep 24 && git status --short",
  "sleep 24 && git branch --show-current",
  "sleep 24 && git rev-parse --show-toplevel",
  "sleep 24 && git diff --check",
  "sleep 24 && git log -1 --oneline",
];
if (!Number.isInteger(session) || session < 1 || session > 5)
  throw new Error("session must be 1..5");
const root = process.cwd();
const out = join("/tmp/devin-get-output-calibration", `session-${session}`);
const stateHome = `/tmp/devin-get-output-calibration-state-${session}`;
const serverPort = 61500 + session;
const offset = 4500 + session;
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
const dry = spawnSync(
  "bun",
  ["run", "dev", "--", "--home-dir", stateHome, "--port", String(serverPort), "--dry-run"],
  { cwd: root, env: baseEnv, encoding: "utf8" },
);
writeFileSync(join(out, "dry-run.log"), dry.stdout + dry.stderr);
if (dry.status !== 0) throw new Error("dry run failed");
const runtime = spawn(
  "bun",
  ["run", "dev", "--", "--home-dir", stateHome, "--port", String(serverPort)],
  { cwd: root, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] },
);
let runtimeLog = "";
runtime.stdout.on("data", (chunk) => (runtimeLog += chunk));
runtime.stderr.on("data", (chunk) => (runtimeLog += chunk));
const waitPort = async () => {
  for (let i = 0; i < 120; i++) {
    const check = spawnSync("lsof", ["-nP", `-iTCP:${webPort}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    if (check.status === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("web port did not open");
};
const prompt = `Session ${session} acceptance. Use exactly one shell exec tool call. Start this exact bounded local command in the background: ${commands[session - 1]}. Then use get_output with timeout 25000 milliseconds to wait for it to finish. Do not use any other tool before or after it. Do not edit or create files. Do not access the network or any external service. Do not perform external writes. After the command finishes, reply with exactly: SESSION ${session} COMPLETE`;
try {
  await waitPort();
  const egoScript = `
const task = await useOrCreateTaskSpace('devin get output calibration')
const tabs=await listTabs(); await openOrReuseTab('http://localhost:${webPort}', { wait: true, timeout: 20 })
await wait(30)
await cdp('Runtime.enable')
await cdp('Log.enable')
let snap=await snapshotText()
const toastDismiss=(snap.match(/\[ref=(\\d+)[^\\n]*Dismiss toast/)||[])[1]; if(toastDismiss){ await click('@'+toastDismiss); await wait(1); snap=await snapshotText() }
if(snap.includes('No projects yet')){ await click('button[aria-label=\"Add project\"]'); await wait(1); await fillInput('input[placeholder=\"/path/to/project\"]',${JSON.stringify("/Users/user/.synara/worktrees/devin-tool-idle-budget-clean")}); await click('loc=role:button[name=\"Create project\"]'); await wait(5); snap=await snapshotText() }
if(!snap.includes('SWE 1.7')){ const createThread=(snap.match(/\[ref=(\\d+)[^\\n]*Create new thread in devin-tool-idle-budget-clean/)||[])[1]; if(createThread){ await click('@'+createThread); await wait(4); snap=await snapshotText() } }
const providerButton=snap.includes('SWE 1.7') ? null : (snap.match(/\[ref=(\\d+)[^\\n]*Change model/)||[])[1]
if(providerButton){ await click('@'+providerButton); await wait(1); snap=await snapshotText(); const devin=(snap.match(/\[ref=(\\d+)[^\\n]*Devin/)||[])[1]; if(devin) await click('@'+devin); await wait(1); snap=await snapshotText(); const swe=(snap.match(/\[ref=(\\d+)[^\\n]*SWE 1\\.7/)||[])[1]; if(swe) await click('@'+swe); }
await wait(1)
snap=await snapshotText()
const effort=(snap.match(/\[ref=(\\d+)[^\\n]*Change effort/)||[])[1]
if(effort) await click('@'+effort)
await wait(1)
snap=await snapshotText()
const max=(snap.match(/\[ref=(\\d+)[^\\n]*Max/)||[])[1]
if(max) await click('@'+max)
await pressKey('Escape')
await wait(1)
snap=await snapshotText()
const composer=(snap.match(/\[ref=(\\d+)[^\\n]*(Ask for follow-up changes|Message)/)||[])[1]
if(composer) await click('@'+composer)
else { cliLog(snap); throw new Error('composer not found') }
await captureScreenshot(${JSON.stringify(join(out, "01-before-send.png"))})
await typeText(${JSON.stringify(prompt)})
await click('button[aria-label="Send message"]', { label: 'start corrected session' })
const frames=[]; const samples=[]; const started=Date.now(); let activeCaptured=false
while(Date.now()-started < 120000){
 await wait(1)
 frames.push(...(await drainEvents()).map(event=>({capturedAt:new Date().toISOString(),event})))
 const state=await js(String.raw\`(() => ({url:location.href,text:document.body.innerText,thinking:document.body.innerHTML.includes('Thinking')}))()\`)
 samples.push({capturedAt:new Date().toISOString(),...state})
 if(!activeCaptured && Date.now()-started >= 15000 && /Working for|elapsed/.test(state.text)){ await captureScreenshot(${JSON.stringify(join(out, "02-active-past-normal-timeout.png"))}); activeCaptured=true }
 if(state.text.includes('SESSION ${session} COMPLETE') && !/Working for|elapsed/.test(state.text.slice(-2000))) break
}
const fs=await import('node:fs')
fs.writeFileSync(${JSON.stringify(join(out, "browser-events.json"))},JSON.stringify(frames,null,2))
fs.writeFileSync(${JSON.stringify(join(out, "ui-samples.json"))},JSON.stringify(samples,null,2))
fs.writeFileSync(${JSON.stringify(join(out, "final-snapshot.txt"))},await snapshotText())
await captureScreenshot(${JSON.stringify(join(out, "03-completed.png"))})
cliLog(JSON.stringify({taskId:task.id,last:samples.at(-1)}))
`;
  const ego = spawnSync("ego-browser", ["nodejs"], {
    cwd: root,
    input: egoScript,
    encoding: "utf8",
    timeout: 150000,
    maxBuffer: 20_000_000,
  });
  writeFileSync(join(out, "ego.log"), ego.stdout + ego.stderr);
  if (ego.status !== 0) {
    writeFileSync(
      join(out, "harness-error.json"),
      JSON.stringify({ infrastructure: true, kind: "ego-browser", status: ego.status }, null, 2),
    );
    throw new Error(`ego browser failed ${ego.status}`);
  }
  const db = join(stateHome, "dev/state.sqlite");
  const query =
    "select sequence,event_type,occurred_at,payload_json from orchestration_events order by sequence;";
  const ledger = spawnSync("sqlite3", ["-readonly", "-json", `file:${db}?immutable=1`, query], {
    encoding: "utf8",
    maxBuffer: 20_000_000,
  });
  writeFileSync(join(out, "orchestration-events.json"), ledger.stdout);
  if (existsSync(join(stateHome, "dev/logs/server.log")))
    cpSync(join(stateHome, "dev/logs/server.log"), join(out, "server.log"));
  const events = JSON.parse(ledger.stdout || "[]").map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json),
  }));
  const created = events.find((row) => row.event_type === "thread.created");
  const sent = events.find((row) => row.event_type === "thread.message-sent");
  const requested = events.find((row) => row.event_type === "thread.turn-start-requested");
  const activities = events
    .filter((row) => row.event_type === "thread.activity-appended")
    .map((row) => row.payload.activity)
    .filter(Boolean);
  const tool = activities.find((a) => a.kind === "tool.started");
  const terminal = [...activities]
    .reverse()
    .find(
      (a) =>
        a.payload?.data?.toolCallId === tool?.payload?.data?.toolCallId &&
        ["completed", "failed"].includes(a.payload?.status),
    );
  const messages = events.filter((row) => row.event_type === "thread.message-sent");
  const samples = JSON.parse(readFileSync(join(out, "ui-samples.json"), "utf8"));
  const last = samples.at(-1) ?? {};
  const elapsed = samples
    .map((s) => [...s.text.matchAll(/(\\d+)s elapsed/g)].map((m) => Number(m[1])))
    .flat();
  const browserEvents = readFileSync(join(out, "browser-events.json"), "utf8");
  const serverLog = existsSync(join(out, "server.log"))
    ? readFileSync(join(out, "server.log"), "utf8")
    : "";
  const createdAt = created?.payload?.createdAt ?? created?.occurred_at;
  const sentAt = sent?.payload?.createdAt ?? sent?.occurred_at;
  const orderingMs =
    createdAt && sentAt ? Math.abs(Date.parse(sentAt) - Date.parse(createdAt)) : null;
  const result = {
    session,
    result:
      created &&
      sent &&
      requested &&
      tool &&
      terminal &&
      terminal.payload?.status === "completed" &&
      !activities.some((a) => a.kind === "tool.failed" || a.payload?.status === "failed") &&
      Math.max(0, ...elapsed) > 10 &&
      last.text?.includes(`SESSION ${session} COMPLETE`) &&
      messages.length === 1 &&
      orderingMs !== null &&
      orderingMs < 5000 &&
      !/Thread detail snapshot not found|WebSocket RPC stream failed/.test(browserEvents) &&
      !/turn idle timeout|turn_idle_timeout/i.test(serverLog)
        ? "PASS"
        : "FAIL",
    threadId: created?.payload?.threadId,
    turnId: tool?.turnId,
    toolId: tool?.payload?.data?.toolCallId,
    activeSecondsObserved: Math.max(0, ...elapsed),
    toolTerminalState: terminal?.payload?.status,
    failedToolRows: activities.filter(
      (a) => a.kind === "tool.failed" || a.payload?.status === "failed",
    ).length,
    finalPhrase: `SESSION ${session} COMPLETE`,
    route: last.url,
    modelSelection: requested?.payload?.modelSelection,
    messageCount: messages.length,
    orderingMs,
    browserFlowErrors: /Thread detail snapshot not found|WebSocket RPC stream failed/.test(
      browserEvents,
    ),
    serverTimeoutErrors: /turn idle timeout|turn_idle_timeout/i.test(serverLog),
    evidence: [
      "dry-run.log",
      "browser-events.json",
      "ui-samples.json",
      "final-snapshot.txt",
      "01-before-send.png",
      "02-active-past-normal-timeout.png",
      "03-completed.png",
      "orchestration-events.json",
      "server.log",
      "ego.log",
    ],
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (result.result !== "PASS") process.exitCode = 2;
} finally {
  runtime.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 3000));
  if (!runtime.killed) runtime.kill("SIGTERM");
  writeFileSync(join(out, "runtime.log"), runtimeLog);
  const cleanup = spawnSync(
    "sh",
    ["-c", `lsof -nP -iTCP:${serverPort} -sTCP:LISTEN; lsof -nP -iTCP:${webPort} -sTCP:LISTEN`],
    { encoding: "utf8" },
  );
  writeFileSync(join(out, "cleanup.txt"), cleanup.stdout + cleanup.stderr);
}
