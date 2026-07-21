# Agent 2 — Provider compaction behavior: verification vs. implementation

Verification of what the compaction PR stack (#55–#66, integration branch
`devin/compaction-final-integration`, commit `7a808a7f`) claims per provider, against real
CLI/source behavior observable on this machine (2026-07-21).

## Environment actually used

The task brief referenced pre-installed CLIs at `/home/ubuntu/.grok/bin/grok` and
`/home/ubuntu/clis/node_modules/.bin/{codex,opencode}`. **Those paths were empty on this box**
(fresh VM); the same binaries were installed fresh into `/home/ubuntu/clis` and the open-source
repos were cloned, so all citations below refer to:

| Artifact | Path | Version |
| --- | --- | --- |
| Grok CLI (official, `@xai-official/grok`) | `/home/ubuntu/clis/node_modules/.bin/grok` | `grok 0.2.106 (bde89716f6)` |
| Codex CLI (`@openai/codex`) | `/home/ubuntu/clis/node_modules/.bin/codex` | `codex-cli 0.144.6` |
| OpenCode CLI (`opencode-ai`) | `/home/ubuntu/clis/node_modules/.bin/opencode` | `1.18.4` |
| Codex source | `/home/ubuntu/repos/codex-src` (github.com/openai/codex, shallow @ HEAD) | — |
| OpenCode source | `/home/ubuntu/repos/opencode-src` (github.com/sst/opencode) | — |
| Pi source | `/home/ubuntu/repos/pi-mono` (github.com/badlogic/pi-mono) | — |
| Synara implementation | `/home/ubuntu/repos/synara-impl` (worktree @ `devin/compaction-final-integration`) | `7a808a7f` |

No provider API keys are available in this session, so no live prompt/compaction turn was
executed for any provider. Everything below is from protocol handshakes (which work unauthenticated),
`--help` output, and source code.

Implementation claims are the `ProviderCompactionCapabilities` literals each adapter publishes:

| Provider | manual.mode / mechanism / instructions | automatic.mode (default) | status / trigger visibility | telemetry lifecycle / contextUsage | Declared at |
| --- | --- | --- | --- | --- | --- |
| Codex | same-session / native-rpc / no | native (on) | exact / exact | native / exact | `apps/server/src/codexAppServerManager.ts:1956` |
| Claude | unsupported / unsupported / no | native (on) | partial / derived | native / exact | `apps/server/src/provider/Layers/ClaudeAdapter.ts:5231` |
| Grok | same-session / control-command / yes | native (on) | partial / derived | native / provider-estimated | `GrokAdapter.ts:1935` |
| OpenCode | same-session / native-sdk / no | native (on) | exact / exact | native / provider-estimated | `OpenCodeAdapter.ts:4041` |
| Kilo | same as OpenCode (shared adapter) | native (on) | exact / exact | native / provider-estimated | `OpenCodeAdapter.ts:4041` |
| Pi | same-session / native-sdk / no | native (on) | partial / derived | native / exact | `PiAdapter.ts:2729` |
| Cursor | unsupported / unsupported / no | native | none / opaque | none / provider-estimated | `CursorAdapter.ts:129` |
| Droid | session-rollover if `/compact`-like command advertised, else unsupported | native | none / opaque | none / provider-estimated | `DroidAdapter.ts:134` |
| Antigravity | unsupported / unsupported / no | unknown | none / opaque | none / none | `AntigravityAdapter.ts:42` |

Verdict legend: **Match** = source/CLI evidence supports the claim; **Plausible** = consistent but
needs a live keyed session; **Over-claim** = asserted stronger than what is observable.

---

## 1. Codex

**Verified real behavior.**
- `codex app-server` responds to `initialize` unauthenticated:
  `{"id":1,"result":{"userAgent":"probe/0.144.6 (Ubuntu 22.4.0; x86_64) …","codexHome":"/home/ubuntu/.codex","platformFamily":"unix","platformOs":"linux"}}`.
- Manual compaction RPC exists exactly as the adapter uses it:
  `codex-rs/app-server-protocol/src/protocol/common.rs:583` — `ThreadCompactStart => "thread/compact/start"` with
  `ThreadCompactStartParams` / `ThreadCompactStartResponse` (`protocol/v2/thread.rs:965-972`). No
  instructions field on the params — matches `supportsInstructions: false`.
- Lifecycle telemetry: `ThreadItem::ContextCompaction` (`protocol/v2/item.rs:388`), plus deprecated
  `"thread/compacted"` notification (`common.rs:1702`, `ContextCompactedNotification` at
  `thread.rs:1599-1603`). The adapter consumes both (`codexAppServerManager.ts:1600`, `:3044`).
- Auto-compaction: `run_inline_auto_compact_task` (`codex-rs/core/src/compact.rs:92`), remote
  variants in `compact_remote.rs` / `compact_remote_v2.rs`. Default trigger: bundled
  `models-manager/models.json` sets `auto_compact_token_limit: null` for all 8 models, but
  `protocol/src/openai_models.rs:459-469` falls back to **90% of the resolved context window** —
  so auto-compaction is effectively on by default. Config overrides: `model_auto_compact_token_limit`
  (+ scope) and `compact_prompt` (`app-server-protocol/protocol/v2/config.rs:249-266`).

**Implementation claims.** Manual same-session via native RPC; native auto, on by default, exact
status/trigger; native lifecycle; exact context usage.

**Verdict: Match.** Every claim is backed by open-source protocol/source evidence. The strongest
claims in the matrix (exact/exact) are justified — Codex is the only provider with a first-class
compaction RPC plus item-level lifecycle notifications.

**Cannot verify without keys.** An actual `thread/compact/start` round-trip and observation of
`contextCompaction` items requires a logged-in ChatGPT/API session.

**Live smoke test.** 1) `codex app-server`, `initialize`, `thread/start`; 2) run a few turns; 3) send
`thread/compact/start`; assert a `contextCompaction` thread item and post-compaction token-usage drop;
4) set `model_auto_compact_token_limit` low and confirm native auto fires mid-turn.

## 2. Claude (claudeAgent)

**Verified real behavior.** Claude Code CLI is not installed here and is closed-source; no direct
verification. The adapter's own consumption points: `compact_boundary` stream message →
`state: "compacted"` (`ClaudeAdapter.ts:3372-3377`), `status === "compacting"` → waiting
(`:3366`), and the `autoCompactWindow` model option plumbed into the SDK session (`:4358-4386`,
1M-budget warning at `:4660`).

**Implementation claims.** Manual: unsupported ("No manual compaction through the current Claude
SDK path", `ClaudeAdapter.ts:5229-5230`). Auto: native, on by default, partial/derived. Telemetry:
native lifecycle, exact context usage.

**Verdict: Plausible, with one deliberate under-claim.** The interactive Claude Code TUI does have a
`/compact` command; the SDK/stream-json path Synara uses does not expose it, so `manual.mode:
"unsupported"` is truthful for the integration but under-sells the CLI. The `compact_boundary`
handling implies lifecycle events exist in the stream — consistent with `lifecycle: "native"` — but
none of this is verifiable on this box without the CLI + an Anthropic login.

**Cannot verify without keys.** Everything: whether `compact_boundary` actually arrives, whether
auto-compact honors `autoCompactWindow`, context-usage exactness.

**Live smoke test.** 1) Long session until near the configured `autoCompactWindow`; 2) confirm a
`compact_boundary` system message and the meter's `compacted` state; 3) flip auto-compact budget
between 200k/1M and verify the warning copy and behavior change.

## 3. Grok

**Verified real behavior** (strongest CLI evidence in this report).
- Official CLI installed from npm `@xai-official/grok` (install command advertised by grok.com
  server config: `"grok_code_install_command": "npm install -g @xai-official/grok"`); version
  `grok 0.2.106 (bde89716f6)`.
- `grok agent stdio` is a real ACP endpoint; unauthenticated `initialize` (protocolVersion 1)
  returns (abridged):
  - `agentCapabilities.loadSession: true`, `promptCapabilities.embeddedContext: true`
  - `_meta.modelState.currentModelId: "grok-4.5"` with `totalContextTokens: 500000`
  - `availableCommands` includes **`{"name":"compact","description":"Compress conversation history
    to save context window","input":{"hint":"optional context about what to preserve"}}`** plus
    `context` ("Show context window usage and session stats") and `session-info`.
- So: manual compaction is a session **control command** (`/compact`) that accepts free-text
  instructions, exactly matching `manual: { mode: "same-session", mechanism: "control-command",
  supportsInstructions: true }`. The adapter sends `GROK_COMPACT_PROMPT = "/compact"`
  (`GrokAdapter.ts:139`) with elaborate timeout/cancel handling (`:149-298`).
- `grok agent stdio --help` confirms the spawn shape the adapter builds
  (`provider/acp/GrokAcpSupport.ts:64-82`: `grok [--always-approve] agent stdio …`).

**Implementation claims vs. reality.**
- Manual: **Match** (verified from the live `initialize` handshake above).
- Automatic `mode: "native", enabledByDefault: true`: **Plausible but unverified** — nothing in the
  handshake or `--help` advertises intra-session auto-compaction or its threshold. No
  intra-compaction threshold is exposed anywhere observable without a session.
- Telemetry `lifecycle: "native"`: **Plausible**; the `context` command and `_meta.totalContextTokens`
  show context accounting exists, but compaction lifecycle updates were not observable. `contextUsage:
  "provider-estimated"` is appropriately modest.

**Cannot verify without keys.** Any prompt turn (auth error without `XAI_API_KEY`/grok.com login):
auto-compaction existence/threshold, what session/update events a `/compact` turn emits, post-compact
usage drop.

**Live smoke test.** 1) `grok agent stdio` + `session/new`; run turns; 2) send `/compact keep the
test plan` via `session/prompt`; assert lifecycle updates and shrunk `context` output; 3) drive
usage toward the 500k window to see whether any native auto-compaction event fires.

## 4. OpenCode

**Verified real behavior.**
- `opencode acp` unauthenticated `initialize` returns `agentInfo {"name":"OpenCode","version":"1.18.4"}`,
  `sessionCapabilities: {close, fork, list, resume}` — note **no compaction advertised at the ACP
  layer**; Synara correctly integrates via the SDK/server instead.
- Manual: HTTP/SDK endpoint `POST /session/{sessionID}/summarize` = `session.summarize`
  (`opencode-src/packages/sdk/openapi.json:6999-7002`); adapter calls exactly this
  (`OpenCodeAdapter.ts:3673-3674`). The endpoint takes no instruction text → `supportsInstructions:
  false` matches.
- Lifecycle events: `session.compacted` event (`packages/schema/src/event-manifest.ts:24,77`;
  `EventSessionCompacted` in `sdk/openapi.json:36442`), and compaction messages carry
  `part.type === "compaction"` (`packages/opencode/src/session/compaction.ts:67,301,532`;
  `message-v2.ts:228`). Adapter consumes `session.compacted` at `OpenCodeAdapter.ts:932` and `:2691`.
- Auto-compaction: `isOverflow` in `packages/opencode/src/session/overflow.ts` — triggers when
  `tokens.total >= usable`, where `usable = limit.input − reserved` and
  `reserved = cfg.compaction.reserved ?? min(20_000 /* COMPACTION_BUFFER */, maxOutputTokens)`;
  disabled only if `cfg.compaction.auto === false` → **on by default**. Overflow-triggered
  compaction and auto-continue metadata (`compaction_continue`) in `session/compaction.ts:310-494`.

**Implementation claims vs. reality.**
- Manual same-session / native-sdk / no instructions: **Match**.
- Automatic native, on by default: **Match** (source-verified trigger: context ≥ input-limit − 20k buffer).
- `statusVisibility/triggerVisibility: "exact"`: **Slight over-claim.** The `session.compacted`
  event makes completion exact, but the *trigger* is computed server-side from token counts the
  provider reports per assistant message; OpenCode does not publish a "compaction imminent"
  threshold event. "exact/derived" would be more truthful than "exact/exact".
- `contextUsage: "provider-estimated"`: Match (OpenCode sums message token fields).

**Cannot verify without keys.** A real `session.summarize` round-trip and observation of
`session.compacted` over the event stream require a configured provider credential.

**Live smoke test.** 1) `opencode serve`; create session; 2) `client.session.summarize(...)`; assert
`session.compacted` on the SSE event bus and a `compaction` part in messages; 3) set
`compaction.reserved` high to force auto overflow on a cheap model and verify the auto path +
`compaction_continue` metadata.

## 5. Kilo

**Verified real behavior.** No Kilo CLI on the box and no separate Kilo source clone. Kilo is an
OpenCode fork and Synara reuses `OpenCodeAdapter` for it (same capability literal at
`OpenCodeAdapter.ts:4041`, with `supportsNativeSlashCommandDiscovery: provider === "opencode"`
at `:4066` as the only differentiation).

**Implementation claims vs. reality.** Identical to OpenCode. **Assumption, not verification** —
the fork's divergence (event names, `session.summarize` availability, compaction buffer) was not
checked against Kilo's actual release. Everything inherits OpenCode's verdicts plus fork risk.

**Cannot verify without keys/CLI.** All of it; the Kilo binary was not present or installed.

**Live smoke test.** Same as OpenCode but against the Kilo binary; specifically confirm
`session.compacted` and `part.type === "compaction"` survived the fork, and diff its
`overflow.ts` constants.

## 6. Pi

**Verified real behavior** (source: `pi-mono` clone; the pi CLI itself was not installed).
- Manual: RPC command `{ type: "compact", customInstructions?: string }` with response carrying
  `CompactionResult` (`packages/coding-agent/src/modes/rpc/rpc-types.ts:46,171`); client helper
  `session.compact()` used by the adapter (`PiAdapter.ts:2537`, method label `thread/compact` at
  `:2541`).
- **Mismatch — instructions:** Pi's RPC accepts `customInstructions`, but the adapter declares
  `supportsInstructions: false` and actively rejects instruction-bearing requests
  (`PiAdapter.ts:2532`: "Pi context compaction does not support custom instructions."). Under-claim
  of a real capability rather than an over-claim, but the stated reason is wrong — the protocol
  supports it.
- Auto: `shouldCompact(contextTokens, contextWindow, settings)` returns
  `contextTokens > contextWindow − reserveTokens` with `DEFAULT_COMPACTION_SETTINGS = { enabled:
  true, reserveTokens: 16384 }` (`core/compaction/compaction.ts:132-134, 235-237`) — native,
  on by default: **Match**. Toggleable per session (`set_auto_compaction` RPC, `rpc-types.ts:47`;
  `autoCompactionEnabled` in `agent-session.ts:2208`).
- Lifecycle: `compaction_start` / `compaction_end` RPC events consumed at `PiAdapter.ts:1797-1821`
  and mapped to `context_compaction` items — matches `lifecycle: "native"`. Given start/end events
  exist, the claimed `statusVisibility: "partial"` is conservative-but-fine.

**Cannot verify without keys.** Live compaction (needs a model provider configured for pi) and the
`contextUsage: "exact"` claim (pi reports usage from real API usage objects — `estimateContextTokens`
falls back to estimates when trailing messages exist, so "exact" is optimistic in the tail case).

**Live smoke test.** 1) `pi --mode rpc`; 2) send `compact` with and without `customInstructions`;
3) toggle `set_auto_compaction` and cross the `contextWindow − 16384` boundary; assert
`compaction_start`/`compaction_end` ordering and post-compact token drop.

## 7. Cursor

**Verified real behavior.** None. `cursor-agent` is not installed on this box and is closed-source;
nothing was probed.

**Implementation claims.** Manual unsupported; automatic `mode: "native"` with none/opaque
visibility; telemetry none / provider-estimated (`CursorAdapter.ts:129-144`).

**Verdict: `automatic.mode: "native"` is an over-claim on current evidence.** Nothing observable
here demonstrates cursor-agent compacts natively; "unknown" (as used for Antigravity) would be the
defensible value. The rest (unsupported manual, no lifecycle telemetry) is appropriately minimal.

**Cannot verify without keys/CLI.** Everything — requires installing `cursor-agent` and a Cursor login.

**Live smoke test.** 1) Install cursor-agent; run ACP `initialize` and dump `availableCommands` /
capabilities for any compact-like command; 2) run a long session and watch for context-shrink
behavior or any compaction notification; downgrade `automatic.mode` to "unknown" if none appears.

## 8. Droid (Factory)

**Verified real behavior.** None on this box — `droid` CLI not installed, closed-source.

**Implementation claims.** Runtime probe: manual becomes `session-rollover` / `control-command` /
instructions **only if** the ACP session advertises a compaction-like command
(`droidCommandSignalsCompaction`, `DroidAdapter.ts:134-161`); otherwise unsupported. Automatic:
`native` with none/opaque visibility.

**Verdict: probe design is sound; the hardcoded bits are weaker.** The advertised-command gate is
exactly the right pattern (claims track what the CLI actually advertises at runtime). Two soft
spots: (a) `mode: "session-rollover"` is asserted from TUI folklore ("Droid's TUI compaction paths
imply session-rollover semantics", `DroidAdapter.ts:141`) — unverified; (b) `automatic.mode:
"native"` again lacks any on-box evidence (same critique as Cursor).

**Cannot verify without keys/CLI.** Whether droid advertises `/compact` over ACP at all, rollover
vs. same-session semantics, native auto behavior.

**Live smoke test.** 1) Install droid CLI, ACP `initialize` + `session/new`, dump
`availableCommands`; 2) if compact advertised, invoke it and observe whether session id changes
(rollover) or is preserved (same-session) — correct `manual.mode` accordingly.

## 9. Antigravity

**Verified real behavior.** None — no Antigravity runtime on this box.

**Implementation claims.** Fully zeroed: manual unsupported, automatic `unknown`, telemetry
none/none (`AntigravityAdapter.ts:42-57`).

**Verdict: Match by construction.** This is the honest "we know nothing" descriptor and is the
template Cursor/Droid `automatic.mode` should arguably follow. Nothing to contradict.

**Cannot verify without keys.** Whether Antigravity compacts internally at all.

**Live smoke test.** Run a long Antigravity session via its print/transcript pipeline and inspect
transcript steps for any compaction/summary artifacts; only then upgrade the descriptor.

---

## Summary table

| Provider | Manual claim | Auto claim | Verdict | Evidence quality |
| --- | --- | --- | --- | --- |
| Codex | same-session native-rpc | native, on (90% window fallback) | **Match** | Source (openai/codex) + local handshake |
| Claude | unsupported (SDK path) | native, on | Plausible; manual under-claims the TUI | Adapter-side only; CLI absent |
| Grok | same-session `/compact` + instructions | native, on | Manual **verified live**; auto unverified | Live ACP `initialize` (grok 0.2.106) |
| OpenCode | same-session `session.summarize` | native, on (20k buffer) | Match; trigger "exact" slightly over-claimed | Source (sst/opencode) + local handshake |
| Kilo | inherited from OpenCode | inherited | Assumed, not verified (fork drift risk) | None (no Kilo artifact on box) |
| Pi | same-session `session.compact()` | native, on (reserve 16384) | Match; instructions wrongly declared unsupported | Source (badlogic/pi-mono) |
| Cursor | unsupported | **native — over-claim** | Over-claim on auto | None |
| Droid | probe-gated rollover | **native — over-claim** | Probe good; hardcoded semantics unverified | None |
| Antigravity | unsupported | unknown | Match (honest floor) | None |

## Top mismatches / gaps

1. **Cursor `automatic.mode: "native"` has zero supporting evidence** (`CursorAdapter.ts:136`) —
   should be `"unknown"` like Antigravity until a cursor-agent session demonstrates otherwise.
2. **Droid `automatic.mode: "native"` and `manual.mode: "session-rollover"` are asserted, not
   observed** (`DroidAdapter.ts:141-152`); the runtime command probe is right, the hardcoded
   semantics are folklore.
3. **Pi `supportsInstructions: false` contradicts the Pi RPC**, which accepts
   `customInstructions` on `compact` (`pi-mono rpc-types.ts:46` vs. `PiAdapter.ts:2530-2535`) —
   capability exists upstream and is being refused with an inaccurate error message.
4. **OpenCode/Kilo `triggerVisibility: "exact"` overstates observability** — completion is exact
   (`session.compacted`) but the auto trigger is a server-side overflow computation with no
   pre-trigger signal; and the Kilo values are wholesale inherited from OpenCode without any
   fork-level verification.
5. **Nothing intra-session is verified for Grok/Claude auto-compaction** — Grok's live handshake
   proves manual `/compact` (with instruction hint, 500k window) but exposes no auto-compaction
   threshold; Claude's entire native story (`compact_boundary`, `autoCompactWindow`) rests on
   adapter-side handling of a stream nobody on this box can produce without keys.
