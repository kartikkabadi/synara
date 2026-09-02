import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "/Users/user/.synara/worktrees/devin-combined-live-proof";
const evidenceRoot = "/tmp/devin-reliability-matrix";
const out = join(evidenceRoot, "discovery");
const stateHome = join(evidenceRoot, "state-discovery");
const serverPort = 61801;
const offset = 4801;
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
  SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS: baseEnv.SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS,
  SYNARA_DEVIN_TOOL_IDLE_TIMEOUT_MS: baseEnv.SYNARA_DEVIN_TOOL_IDLE_TIMEOUT_MS,
  SYNARA_PORT_OFFSET: baseEnv.SYNARA_PORT_OFFSET,
  authTokenUnset: baseEnv.SYNARA_AUTH_TOKEN === undefined,
}, null, 2));
const runtime = spawn("bun", ["run", "dev", "--", "--home-dir", stateHome, "--port", String(serverPort)],
  { cwd: root, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
let runtimeLog = "";
runtime.stdout.on("data", (c) => (runtimeLog += c));
runtime.stderr.on("data", (c) => (runtimeLog += c));
const waitPort = async () => {
  for (let i = 0; i < 120; i++) {
    if (spawnSync("lsof", ["-nP", `-iTCP:${webPort}`, "-sTCP:LISTEN"], { encoding: "utf8" }).status === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("web port did not open");
};
try {
  await waitPort();
  const egoScript = `
cliLog('SCRIPT_START')
const task = await useOrCreateTaskSpace(11)
cliLog('TASK_OK ' + task.id)
try { const ts = await listTabs(); for (const t of ts) { try { await closeTab(t.id) } catch {} }; cliLog('CLOSED_TABS ' + ts.length) } catch (e) { cliLog('CLOSE_ERR ' + String(e).slice(0,60)) }
try { await Promise.race([openOrReuseTab('http://localhost:${webPort}', { wait: false, timeout: 20 }), new Promise(r => setTimeout(r, 20000))]) } catch (e) { cliLog('TAB_OPEN_ERR ' + String(e).slice(0,80)) }
cliLog('TAB_OPENED')
await wait(3)
try { await gotoAndWait('http://localhost:${webPort}', { timeout: 60, settle: 2 }) } catch (e) { cliLog('GOTO_ERR ' + String(e).slice(0,80)) }
cliLog('GOTO_DONE')
await wait(15)
let readyOk = false
for(let i=0;i<180;i++){ try { const ready=await js("(() => ({root:!!document.querySelector('#root'),body:document.body.innerText}))()"); if(ready.root && ready.body.includes('Projects') && !ready.body.includes('Loading Synara')) { readyOk = true; break } } catch (e) { if (i===0) cliLog('EARLY_EVAL_ERR ' + String(e).slice(0,80)) } ; if(i===60){ try { await js("setTimeout(() => location.reload(), 0); 'ok'") } catch {} } await wait(1); if(i===179) throw new Error('readiness gate failed') }
cliLog('READY ' + readyOk)
const mod = await js("(async () => { const u='/src/routes/_chat.\\$threadId.tsx?tsr-split=component'; const res = await fetch(u); return {status: res.status, ct: res.headers.get('content-type')} })()")
cliLog('MODULE_CHECK ' + JSON.stringify(mod))
let warm = null
for (let attempt=0; attempt<4; attempt++) {
  await js("sessionStorage.removeItem('routeWarm'); sessionStorage.setItem('routeWarmFired','1'); import('/src/routes/_chat.\\$threadId.tsx?tsr-split=component').then(() => { sessionStorage.setItem('routeWarm','ok') }).catch(e => { sessionStorage.setItem('routeWarm','err:' + String(e).slice(0,100)) }); 'fired'")
  for (let w=0; w<60; w++) {
    await wait(1)
    warm = await js("sessionStorage.getItem('routeWarm')")
    if (warm === 'ok' || String(warm).startsWith('err:')) break
  }
  if (warm === 'ok') break
  cliLog('WARM_RETRY ' + attempt + ' ' + warm)
  try { await js("setTimeout(() => location.reload(), 0); 'ok'") } catch {}
  for (let w=0; w<60; w++) { await wait(1); try { const r = await js("!!document.querySelector('#root')"); if (r) break } catch {} }
}
cliLog('ROUTE_WARM ' + JSON.stringify(warm))
if (warm !== 'ok') throw new Error('route module failed to warm: ' + warm)
await wait(2)
await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Network.enable')
const refInline = (s,label) => { for (const l of s.split('\\n')) { const m=l.match(/\\[ref=(\\d+)/); if (m && l.includes(label)) return m[1] } return null }
const refStruct = (s,label) => { const ls=s.split('\\n'); for (let i=0;i<ls.length;i++){ if (ls[i].includes('text "'+label+'"')) { for (let j=i-1;j>=Math.max(0,i-8);j--){ const m=ls[j].match(/^\\s*(?:button|menuitem|menuitemradio|radio)\\s+\\[ref=(\\d+)/); if (m) return m[1] } } } return null }
const pick = (s,label) => refInline(s,label) ?? refStruct(s,label)
let snap = await snapshotText()
const dismissDialogs = async () => {
  for (let d=0; d<5; d++) {
    const s = await snapshotText()
    const toast = refInline(s,'Dismiss toast')
    if (toast) { try { await click('@'+toast) } catch {}; await wait(1); continue }
    if (/dialog "/.test(s)) { await pressKey('Escape'); await wait(1); continue }
    break
  }
}
await dismissDialogs()
for (let p=0; p<20 && !snap.includes('devin-combined-live-proof'); p++) { await wait(1); snap = await snapshotText() }
if (!snap.includes('devin-combined-live-proof')) {
  await click('button[aria-label="Add project"]',{label:'add project'})
  await wait(1)
  await fillInput('input[placeholder="/path/to/project"]','/Users/user/.synara/worktrees/devin-combined-live-proof')
  await click('loc=role:button[name="Create project"]',{label:'create project'})
  await wait(2)
} else {
  for (let t=0; t<4; t++) {
    const s3 = await snapshotText()
    const url = await js("location.href")
    if (/Ask for follow-up changes|Ask anything|What should we do/.test(s3)) break
    if (/localhost:\\d+\\/[0-9a-f-]{36}/.test(String(url)) && !/Ask anything|What should we do/.test(s3)) {
      cliLog('BLANK_DRAFT_RELOAD ' + String(url))
      await gotoAndWait(String(url), { timeout: 30, settle: 2 })
      await wait(2)
      continue
    }
    try { await click('loc=role:button[name="Create new thread in devin-combined-live-proof"]',{label:'open draft thread'}) } catch (e) { cliLog('THREAD_CLICK_ERR ' + String(e).slice(0,120)) }
    await wait(2)
  }
}
await dismissDialogs()
for(let i=0;i<150;i++){ await wait(1); snap=await snapshotText(); if(/Ask for follow-up changes|Ask anything|What should we do/.test(snap)) break; if(i===40||i===90){ const u=String(await js("location.href")); if(/localhost:\\d+\\/[0-9a-f-]{36}/.test(u)){ cliLog('BLANK_COMPOSER_RELOAD '+i+' '+u); await js("setTimeout(() => location.reload(), 0); 'ok'"); for(let w=0;w<30;w++){ await wait(1); const r=await js("(() => ({root:!!document.querySelector('#root'),body:document.body.innerText}))()"); if(r.root && r.body.includes('Projects') && !r.body.includes('Loading Synara')) break } } } if(i===149){ cliLog('FAIL_SNAP '+snap); cliLog('FAIL_URL '+JSON.stringify(await js("location.href"))); cliLog('FAIL_DRAFTS '+JSON.stringify(await js("(() => { const raw=localStorage.getItem('synara:composer-drafts:v1'); const st=raw?JSON.parse(raw).state||JSON.parse(raw):{}; return {projectDrafts: st.projectDraftThreadIds ?? st.projectDraftThreadId ?? null, keys: Object.keys(st.draftsByThreadId||{})} })()"))); cliLog('CONSOLE_EVENTS '+JSON.stringify(await drainEvents())); await captureScreenshot('${join(out, "fail.png")}'); throw new Error('draft composer missing') } if(i%30===29){ cliLog('COMPOSER_WAIT '+i) } }
const readDraft = "(() => { const raw = localStorage.getItem('synara:composer-drafts:v1'); if(!raw) return {none:true}; const parsed = JSON.parse(raw); const st = parsed.state || parsed; const drafts = st.draftsByThreadId || {}; const out = []; for (const [k,d] of Object.entries(drafts)) { if (d && d.activeProvider === 'devin') out.push({key:k.slice(0,40), selection:d.modelSelectionByProvider && d.modelSelectionByProvider.devin}) } return {devinDrafts:out} })()"
const devinItems = (s) => /menu "Devin"/.test(s) && /(GLM-|GPT-5\\.4|SWE 1|Adaptive)/.test(s)
const devinMenuItemRef = (s) => {
  const ls = s.split('\\n')
  for (let i=0;i<ls.length;i++) {
    if (ls[i].trim() === 'text "Devin"') {
      for (let j=i-1;j>=Math.max(0,i-8);j--) {
        const m = ls[j].match(/^\\s*(?:button|menuitem|menuitemradio|radio)\\s+\\[ref=(\\d+)/)
        if (m) return m[1]
      }
    }
  }
  return null
}
const openDevinSubmenu = async () => {
  let s = await snapshotText()
  for (let t=0; t<50 && !devinItems(s); t++) {
    if (!/menu "Devin"/.test(s)) {
      const d = devinMenuItemRef(s)
      if (d) { try { await click('@'+d) } catch {} }
    }
    await wait(1)
    s = await snapshotText()
  }
  return s
}
const searchModel = async (label) => {
  let s = await snapshotText()
  if (!/Search models or providers/.test(s)) { cliLog('NO_SEARCHBOX'); return s }
  await fillInput('input[placeholder="Search models or providers"]', label)
  await wait(1)
  s = await snapshotText()
  for (let t=0; t<12 && !s.includes('text "'+label+'"'); t++) { await wait(1); s = await snapshotText() }
  return s
}
const openModelMenu = async () => {
  for (let t=0; t<3; t++) {
    const s = await snapshotText()
    const cur = modelBtnLabel(s)
    const btn = pick(s, cur)
    if (!btn) { cliLog('MODEL_BTN_MISSING t'+t); await wait(2); continue }
    await click('@'+btn); await wait(1)
    let sub = await openDevinSubmenu()
    if (devinItems(sub)) return sub
    await pressKey('Escape'); await wait(2)
  }
  return await snapshotText()
}
const selectModel = async (label) => {
  let s = await openModelMenu()
  s = await searchModel(label)
  const ref = pick(s, label)
  if (!ref) { cliLog('SELECT_FAIL '+label); throw new Error('model missing: '+label) }
  await click('@'+ref); await wait(1)
  await pressKey('Escape'); await wait(1)
  return JSON.parse(JSON.stringify(await js(readDraft)))
}
const setEffort = async (label) => {
  const s = await snapshotText()
  const effBtn = pick(s,'Change effort')
  if (!effBtn) { cliLog('NO_EFFORT_BTN '+label); return null }
  await click('@'+effBtn); await wait(1)
  const em = await snapshotText()
  const ref = pick(em, label)
  if (!ref) { cliLog('NO_EFFORT_OPT '+label); await pressKey('Escape'); await wait(1); return null }
  await click('@'+ref); await wait(1)
  await pressKey('Escape'); await wait(1)
  return JSON.parse(JSON.stringify(await js(readDraft)))
}
const gptEfforts = {}
const gptSel = await selectModel('GPT-5.4 Mini')
cliLog('DRAFT_GPT ' + JSON.stringify(gptSel))
for (const label of ['Low','Medium','High','XHigh']) {
  gptEfforts[label] = await setEffort(label)
}
cliLog('DRAFT_GPT_EFFORTS ' + JSON.stringify(gptEfforts))
const glmSel = await selectModel('GLM-5.3 Flash')
cliLog('DRAFT_GLM ' + JSON.stringify(glmSel))
const glmMax = await setEffort('Max')
cliLog('DRAFT_GLM_MAX ' + JSON.stringify(glmMax))
cliLog('DISCOVERY_DONE')
cliLog('DISCOVERY_DONE')
`;
  writeFileSync(join(out, "ego-script-evaluated.js"), egoScript);
  const ego = spawnSync("ego-browser", ["nodejs"], {
    cwd: out, input: egoScript, encoding: "utf8", timeout: 900000, maxBuffer: 20_000_000,
  });
  writeFileSync(join(out, "ego.log"), ego.stdout + ego.stderr);
  console.log("ego status:", ego.status);
  const lines = (ego.stdout + ego.stderr).split("\n").filter((l) => /^(DRAFT_|DISCOVERY_DONE|MODULE_CHECK)/.test(l.trim()));
  console.log(lines.join("\n").slice(0, 7000));
} finally {
  runtime.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 3000));
  if (!runtime.killed) runtime.kill("SIGTERM");
  const stale = spawnSync("lsof", ["-tiTCP:" + serverPort, "-sTCP:LISTEN"], { encoding: "utf8" });
  for (const pid of (stale.stdout || "").split("\n").filter(Boolean)) {
    spawnSync("kill", ["-TERM", pid.trim()]);
  }
  writeFileSync(join(out, "runtime.log"), runtimeLog);
}
