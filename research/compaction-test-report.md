# Compaction Stack — Consolidated Test & Readiness Report

Consolidated from five research agent reports (see Appendix) on 2026-07-21. Scope: the context-compaction PR stack #55–#66 in `kartikkabadi/synara`, integrating on `devin/compaction-final-integration` (head `7a808a7f`, targeting `main`).

---

## 1. Executive Summary

The compaction stack delivers a complete, layered architecture for manual and automatic context compaction across Synara's 9 providers: a structured truth-claim capability contract (`ProviderCompactionCapabilities`, PR #55), a request/result contract (#56), a characterization suite pinning verified provider behavior (#57), Cursor/Droid/Antigravity verification (#58), context-occupancy vs. cumulative token separation (#59), result-kind-aware `ProviderService` semantics (#60), a durable event-driven `CompactionReactor` with SQLite persistence (migration 73, #61), native auto-compaction observability (#62), provider lifecycle normalization for Codex/Claude/Grok/OpenCode/Kilo/Pi (#63), a compaction web UI (#64), a Synara-managed auto-compaction fallback (#65), and a final `--no-ff` integration merge (#66, 69 files, +6386/−247). The architectural shape — pure reducer (`compactionReducer`) + pure decider (`decideAutoCompaction`) + durable operation rows + a single drainable event-driven reactor worker — is sound and respects all of the plan's hard constraints (no universal 85% default, no polling loops, sticky uncertain outcomes, no premature shared ACP machinery, no settings hierarchy).

What is tested: unit/component coverage is broad and CI is green across the stack (9 passed / 0 failed / 1 expected skip on 11 of 12 PRs; #55 has one flaky-looking Windows install failure). The final integration run reports **2546 tests passed** with only 2 recurring pre-existing local failures (`GitCore.test.ts` remote trailing-slash, `AcpSdkConformance.test.ts` 90s timeout) that reproduce on clean `main` and appear to be local-environment artifacts. 32 of the 41 acceptance criteria are fully verified by tests; 5 are implemented-but-untested and 4 are partial. Provider capability claims are source/CLI-verified for Codex (openai/codex source + live handshake), Grok (live ACP `initialize` proving `/compact` with instructions), OpenCode (sst/opencode source), and Pi (pi-mono source).

What is NOT tested: **no live compaction has ever been executed against any provider** — no provider API keys are available (the one present key, `OPENCODE_GO_API_KEY`, authenticates but its workspace has zero credit). The manual `compactThread` paths for Grok, OpenCode, Kilo, and Pi have no tests at all (even mocked); the web UI (#64) has never been exercised in a real browser (jsdom only, PR screenshot checklist unchecked); Kilo is wholesale assumed identical to OpenCode with no fork-level verification; and the architecture review found two High-severity runtime risks (memory-only settings/suspensions; Codex premature-completion + phantom double operation) plus a request-admission race. **Overall readiness: mergeable on CI signal, but not production-validated** — one browser pass over the compaction UI and one live compaction against a real provider are the minimum gates before merging #66, and the High-severity reactor risks should be fixed first.

---

## 2. Provider-by-Provider Status

Verdict legend (from agent 2): **Match** = source/CLI evidence supports the claim; **Plausible** = consistent but needs a live keyed session; **Over-claim** = asserted stronger than what is observable.

### 2.1 Codex

- **Implementation claim** (`apps/server/src/codexAppServerManager.ts:1956`): manual same-session / native-rpc / no instructions; automatic native (on by default); exact status/trigger visibility; native lifecycle, exact context usage.
- **Real behavior (verified):** `codex app-server` responds to unauthenticated `initialize`. Manual compaction RPC exists exactly as used: `ThreadCompactStart => "thread/compact/start"` (`codex-rs/app-server-protocol/src/protocol/common.rs:583`; params/response at `protocol/v2/thread.rs:965-972`, no instructions field). Lifecycle: `ThreadItem::ContextCompaction` (`protocol/v2/item.rs:388`) plus deprecated `"thread/compacted"` notification (`common.rs:1702`); adapter consumes both (`codexAppServerManager.ts:1600`, `:3044`). Auto: `run_inline_auto_compact_task` (`codex-rs/core/src/compact.rs:92`); `auto_compact_token_limit: null` in bundled models.json falls back to **90% of the resolved context window** (`protocol/src/openai_models.rs:459-469`) — effectively on by default.
- **Verdict: Match.** Only provider with a first-class compaction RPC + item-level lifecycle; "exact/exact" is justified.
- **Test coverage:** `codexAppServerManager.test` ("emits compaction progress before waiting for thread/compact/start"), characterization suite, `ProviderService.test` semantics (mocked adapter). Criterion 6 verified.
- **Gaps / risks:** the adapter returns `same-session` on the **start acknowledgement**, not actual completion (`CodexAdapter.ts:1859-1873`) — see architecture risk #2 (premature `completed` with stale `afterUsage`, followed by a phantom provider-owned second operation).
- **Live-test feasibility:** blocked on `OPENAI_API_KEY` or `codex login` (ChatGPT plan). Recipe in §6.

### 2.2 Claude (claudeAgent)

- **Implementation claim** (`ClaudeAdapter.ts:5231`): manual unsupported ("No manual compaction through the current Claude SDK path", `:5229-5230`); automatic native, on by default; partial/derived visibility; native lifecycle, exact context usage.
- **Real behavior:** CLI not installed, closed-source — no direct verification. Adapter consumption points: `compact_boundary` stream message → `state: "compacted"` (`ClaudeAdapter.ts:3372-3377`), `status === "compacting"` → waiting (`:3366`), `autoCompactWindow` model option plumbed to the SDK session (`:4358-4386`, 1M-budget warning at `:4660`).
- **Verdict: Plausible, with one deliberate under-claim** — the interactive Claude Code TUI has `/compact`, but the SDK/stream-json path Synara uses does not, so `manual: unsupported` is truthful for the integration.
- **Test coverage gap:** Claude is absent from the characterization table; its `manual: unsupported` descriptor is code-only with no test guarding against a future fake-manual regression (criterion 11, implemented-not-tested).
- **Live-test feasibility:** blocked on `ANTHROPIC_API_KEY` or `claude` login. Everything (whether `compact_boundary` actually arrives, `autoCompactWindow` honoring, context-usage exactness) needs a live session.

### 2.3 Grok

- **Implementation claim** (`GrokAdapter.ts:1935`): manual same-session / control-command / **supports instructions**; automatic native, on by default; partial/derived; native lifecycle, provider-estimated context usage.
- **Real behavior (strongest live evidence in the research):** official CLI `@xai-official/grok` `grok 0.2.106 (bde89716f6)`; `grok agent stdio` is a real ACP endpoint whose unauthenticated `initialize` returns `availableCommands` including `{"name":"compact","description":"Compress conversation history to save context window","input":{"hint":"optional context about what to preserve"}}`, plus `context` and `session-info`, `_meta.modelState.currentModelId: "grok-4.5"` with `totalContextTokens: 500000`. Adapter sends `GROK_COMPACT_PROMPT = "/compact"` (`GrokAdapter.ts:139`) with elaborate timeout/cancel handling (`:149-298`); spawn shape confirmed by `--help` (`provider/acp/GrokAcpSupport.ts:64-82`).
- **Verdict:** manual **verified live (Match)**; automatic `native, enabledByDefault: true` is **plausible but unverified** — nothing in the handshake advertises intra-session auto-compaction or a threshold. Note also the **default mismatch** (criterion 16): the descriptor claims `enabledByDefault: true` while the characterization comment records CLI default `enabled: false` @ 85% — one is wrong and could mislead the decider's native-auto deferral.
- **Test coverage gap:** only the between-turn compaction heuristic is tested; **nothing drives `GrokAdapter.compactThread`** (criterion 7, implemented-not-tested). The adapter itself is the most intricate in the stack (~10 interacting context flags on `GrokSessionContext`, `GrokAdapter.ts:260-301`); correctness depends on single-fiber synchronous sections nothing enforces structurally.
- **Live-test feasibility:** blocked on `XAI_API_KEY` or `grok` login (prompt turns error unauthenticated). Grok's manual `/compact` is the most self-contained adapter flow — second-best first live test.

### 2.4 OpenCode

- **Implementation claim** (`OpenCodeAdapter.ts:4041`): manual same-session / native-sdk / no instructions; automatic native, on by default; exact/exact visibility; native lifecycle, provider-estimated usage.
- **Real behavior (source-verified):** `opencode acp` `initialize` returns `agentInfo {"name":"OpenCode","version":"1.18.4"}` with **no compaction at the ACP layer** — Synara correctly integrates via the SDK/server. Manual: `POST /session/{sessionID}/summarize` = `session.summarize` (`opencode-src/packages/sdk/openapi.json:6999-7002`), called at `OpenCodeAdapter.ts:3673-3674`; takes no instruction text. Lifecycle: `session.compacted` event (`packages/schema/src/event-manifest.ts:24,77`; `EventSessionCompacted` at `sdk/openapi.json:36442`), `part.type === "compaction"` messages (`packages/opencode/src/session/compaction.ts:67,301,532`; `message-v2.ts:228`); adapter consumes at `OpenCodeAdapter.ts:932`, `:2691`. Auto: `isOverflow` in `session/overflow.ts` — triggers when `tokens.total >= limit.input − reserved`, `reserved = cfg.compaction.reserved ?? min(20_000, maxOutputTokens)`; disabled only if `cfg.compaction.auto === false` → on by default.
- **Verdict:** manual and auto **Match**; `triggerVisibility: "exact"` is a **slight over-claim** — completion is exact (`session.compacted`) but the trigger is a server-side overflow computation with no pre-trigger signal; "exact/derived" would be truthful. The descriptor comment itself admits event mapping is unverified against a live server (`OpenCodeAdapter.ts:4038-4041`) — the truth-claim is ahead of its verification.
- **Test coverage gap:** no test drives `compactThread` end-to-end (criterion 8, implemented-not-tested).
- **Live-test feasibility:** the `OPENCODE_GO_API_KEY` **authenticates** against the Zen endpoint (`https://opencode.ai/zen/v1`) but `POST /zen/v1/chat/completions` fails HTTP 401 `CreditsError: "Insufficient balance"` (workspace `wrk_01KG0AV4VVG9H2CXDKQHAAZ29D`). **A credit top-up immediately unlocks the highest-value live test** — OpenCode is the only adapter with explicit auto/overflow compaction signals (`overflow: true`, `auto: true`).

### 2.5 Kilo

- **Implementation claim:** identical to OpenCode — shares the adapter and the single capability constant (`OpenCodeAdapter.ts:4041`); only differentiation is `supportsNativeSlashCommandDiscovery: provider === "opencode"` (`:4066`), configured via `KILO_ADAPTER_CONFIG` (`OpenCodeAdapter.ts:118-130, 4126-4140`).
- **Verdict: Assumption, not verification.** No Kilo CLI or source was checked; fork divergence (event names, `session.summarize` availability, compaction buffer) is unaudited. Criterion 4 (OpenCode/Kilo can report distinct behavior) is only partial — divergence is *possible* but the descriptor is a shared constant with no Kilo-specific test.
- **Live-test feasibility:** same recipe as OpenCode against the Kilo binary (`@kilocode/cli`); specifically confirm `session.compacted` and `part.type === "compaction"` survived the fork and diff its `overflow.ts` constants.

### 2.6 Pi

- **Implementation claim** (`PiAdapter.ts:2729`): manual same-session / native-sdk / no instructions; automatic native, on by default; partial/derived; native lifecycle, exact context usage.
- **Real behavior (source-verified via pi-mono):** manual RPC `{ type: "compact", customInstructions?: string }` with `CompactionResult` (`packages/coding-agent/src/modes/rpc/rpc-types.ts:46,171`); adapter uses `session.compact()` (`PiAdapter.ts:2537`, method label `thread/compact` at `:2541`). Auto: `shouldCompact` returns `contextTokens > contextWindow − reserveTokens` with `DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384 }` (`core/compaction/compaction.ts:132-134, 235-237`); toggleable via `set_auto_compaction` RPC (`rpc-types.ts:47`; `agent-session.ts:2208`). Lifecycle: `compaction_start`/`compaction_end` consumed at `PiAdapter.ts:1797-1821`.
- **Verdict: Match, with one mismatch** — **Pi's RPC accepts `customInstructions` but the adapter declares `supportsInstructions: false` and actively rejects instruction-bearing requests** (`PiAdapter.ts:2532`: "Pi context compaction does not support custom instructions.") — an under-claim of a real capability with an inaccurate error message. Also `contextUsage: "exact"` is optimistic: `estimateContextTokens` falls back to estimates when trailing messages exist. Additionally, `compaction_start`/`compaction_end` are mapped to `context_compaction` items with **random, uncorrelated item ids per event** (`PiAdapter.ts:1798, 1813`) — consumers correlating by id see two half-open items.
- **Test coverage gap:** no test drives `compactThread` (criterion 10, implemented-not-tested).
- **Live-test feasibility:** blocked on `PI_API_KEY`.

### 2.7 Cursor

- **Implementation claim** (`CursorAdapter.ts:129-144`): manual unsupported; automatic `mode: "native"` with none/opaque visibility; telemetry none / provider-estimated.
- **Real behavior:** none observed — `cursor-agent` not installed, closed-source.
- **Verdict: `automatic.mode: "native"` is an over-claim on current evidence** (`CursorAdapter.ts:136`) — nothing demonstrates cursor-agent compacts natively; `"unknown"` (as used for Antigravity) is the defensible value. The unsupported-manual claim is verified by test ("stays unsupported because cursor-agent acp proves no compaction path"); criteria 2 and 12 verified.
- **Live-test feasibility:** install cursor-agent (`cursor-agent 2026.07.17` was the version used for #58's manual verification), dump ACP `initialize` `availableCommands`, run a long session watching for compaction; downgrade `automatic.mode` to `"unknown"` if none appears.

### 2.8 Droid (Factory)

- **Implementation claim** (`DroidAdapter.ts:134-161`): runtime probe — manual becomes `session-rollover` / `control-command` / instructions **only if** the ACP session advertises a compaction-like command (`droidCommandSignalsCompaction`); otherwise unsupported. Automatic `native` with none/opaque visibility.
- **Real behavior:** none on the box — CLI not installed, closed-source. Verification for #58 was done against `droid 0.176.0`.
- **Verdict: probe design is sound; the hardcoded bits are weaker.** (a) `mode: "session-rollover"` is asserted from TUI folklore ("Droid's TUI compaction paths imply session-rollover semantics", `DroidAdapter.ts:141`) — unverified; (b) `automatic.mode: "native"` lacks any evidence (same critique as Cursor). Probe tests cover the flip/stay behavior (criteria 3, 13 verified) but only against hand-written mocked ACP `initialize` responses — no fixture from a real `droid` handshake.
- **Live-test feasibility:** install droid CLI, ACP `initialize` + `session/new`, dump `availableCommands`; if compact is advertised, invoke it and observe whether the session id changes (rollover) or is preserved (same-session) — correct `manual.mode` accordingly. `DROID_API_KEY` missing, but compaction is unsupported via ACP regardless (TUI-only `/compact`; comment at `DroidAdapter.ts:1941`).

### 2.9 Antigravity

- **Implementation claim** (`AntigravityAdapter.ts:42-57`): fully zeroed — manual unsupported, automatic `unknown`, telemetry none/none; synthetic compaction design-gated behind `docs/antigravity-compaction-design.md`.
- **Verdict: Match by construction** — the honest "we know nothing" descriptor, and the template Cursor/Droid `automatic.mode` should arguably follow. Test: "asserts compaction is unsupported until the synthetic design is approved" (criterion 14 verified).
- **Live-test feasibility:** run a long Antigravity session via its print/transcript pipeline and inspect for compaction/summary artifacts before upgrading the descriptor.

### Provider verdict summary

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

---

## 3. Per-PR Test / CI Summary

All 12 PRs are open, authored by `devin-ai-integration[bot]`, labeled `vouch:trusted`, mergeable with no conflicts (audited 2026-07-21 ~09:35 UTC). The single skipped CI job everywhere is "Sync PR size label definitions" (expected). #62 and #63 target an intermediate branch `devin/compaction-integration` that has no PR of its own. CI pipeline per PR: Collect PR targets, Prepare PR size config, Format/Lint/Typecheck/Test/Browser Test/Build, Windows Process Regression, Release Smoke, Socket Security (×2), Label PR, Label PR size.

| PR | Title (short) | Branch → Base | Size / diff | Tests added | Commands & results | CI | Key coverage gaps | Recommendations |
|----|---------------|---------------|-------------|-------------|--------------------|----|-------------------|-----------------|
| #55 | PR 1: capability contract | `devin/compaction-pr1-capabilities` → `main` | L; 22 files, +702/−78 | 5 files: `providerDiscovery.test.ts` (descriptor decode, legacy-boolean derivation, fallback), `AcpRuntimeModel.test.ts`, `ProviderDiscoveryService.test.ts`, `contextWindow.test.ts` (`deriveContextCompactionMeterCopy`), `ContextWindowMeter.test.tsx` | fmt/lint/typecheck/test; full suite passes except 2 recurring failures | **8 / 1 / 1** — ❌ Windows Process Regression (job 88556174276): `bun install --frozen-lockfile` fails on Windows in the `@synara/cli` prepare script (ts-patch, `TypeError: … 'ES2022'`) — install/toolchain flake, passes on all 11 other PRs | Descriptors asserted as declared data, not verified vs. live CLIs; ACP `usageCompactsAutomatically` claims rest on manual investigation; meter copy unit-only | Re-run Windows job; add descriptor-vs-characterization link check |
| #56 | PR 3: request/result contract | `devin/compaction-pr3-contract` → pr1 | L; 16 files, +452/−92 | `providerRuntime.test.ts` (request/result decode, unknown-trigger rejection, rollover cursor requirement), `ProviderService.test.ts` (result pass-through, instruction rejection/pass-through), `CodexAdapter.test.ts` | fmt / lint 0 errors / typecheck 8/8 / targeted vitest + full test; only 2 recurring failures | 9 / 0 / 1 | Schema-level only; only Codex exercises the new path | None blocking; adapter coverage arrives in #60/#63 |
| #57 | PR 0: characterization tests | `devin/compaction-pr0-characterization` → `main` | L; 1 new file, +318 (`compactionBehavior.test.ts`) | 8 tests: codex composer capabilities, grok between-turn heuristic, characterization table consistency | targeted vitest **495 passed, 2 skipped**; full test only 2 recurring failures | 9 / 0 / 1 | Table encodes manually verified CLI behavior; goes silently stale — no CLI-version pinning | Record verified CLI versions in the file; scheduled live re-verification job |
| #58 | PR 10: Cursor/Droid/Antigravity | `devin/compaction-pr10-provider-expansion` → pr1 | **XL**; 7 files, +200/−55 | `CursorAdapter.test.ts`, `DroidAdapter.test.ts` (ACP probe flip/stay), `AntigravityAdapter.test.ts` | verification vs. `cursor-agent 2026.07.17`, `droid 0.176.0`, `agy` + vitest | 9 / 0 / 1 | Droid probe tested only vs. hand-written ACP mocks; Antigravity is a design-gated placeholder | Capture a real `droid` ACP handshake fixture |
| #59 | PR 2: occupancy vs cumulative tokens | `devin/compaction-pr2-token-usage` → pr1 | L; 21 files, +727/−42 | 9 files: nested V2 usage schema, `claudeTokenUsage`, ACP claim mapping, Claude/Codex/OpenCode/Pi adapters (`normalizePiTokenUsage`), meter low-confidence/clamping/merge | fmt/lint/typecheck/test (Bun 1.3.12 / Node 24); 2 recurring failures verified pre-existing on base | 9 / 0 / 1 | Synthetic payloads only; no recorded real usage stream through merge + meter | Golden-file tests with captured per-provider usage sequences |
| #60 | PR 4: ProviderService semantics | `devin/compaction-pr4-service-semantics` → pr3 | L; 2 files, +438/−27 | `ProviderService.test.ts` (`it.effect`): idle-cleanup skip, binding kept active + analytics, restart-required stop, rollover identity/generation, stale-generation rejection, active-turn rejection, missing-compactThread rejection | apps/server suite **2483 passed; ProviderService.test.ts 74/74** | 9 / 0 / 1 | Rollover tested only vs. in-memory adapter fake | Covered downstream by #63; fine as-is |
| #61 | PR 5: CompactionReactor + durability | `devin/compaction-pr5-reactor` → pr3 | **XXL**; 17 files, +1629/−4 | 4 files: `compactionState.test.ts` (reducer lifecycle, stale-gen, dupes, uncertain, suspend), `CompactionReactor.test.ts`, `OrchestrationReactor.test.ts`, `Migrations.test.ts` (migration 73, `ThreadCompactionOperations`) | targeted suites 14/14; full suite only 2 recurring failures | 9 / 0 / 1 | Biggest PR; no crash-recovery test beyond one reconciliation case; no property/fuzz tests on the pure reducer; no two-reactor concurrency test | Property-based reducer tests; kill-and-restart integration test |
| #62 | PR 7: native auto observability | `devin/compaction-pr7-auto-observability` → `devin/compaction-integration` | L; 12 files, +728/−35 | 5 files (~24 decls): `ThreadCompactionRuntimeStatus` decode, `compactionRuntimeStatus.test.ts` (per-provider triggers: Claude absolute, Grok percent, Pi reserve, opaque Codex/OpenCode), reactor, meter copy | targeted vitest on 5 files — **69 tests, all passing**; **full suite not cited** | 9 / 0 / 1 | Full-suite run missing from description; activity-log derivation synthetic-only | Run/cite full suite before merge |
| #63 | PR 6: provider lifecycle normalization | `devin/compaction-pr6-provider-normalization` → `devin/compaction-integration` | L; 13 files, +763/−77 | 6 files: `ProviderRuntimeIngestion.test.ts`, Claude/Codex/Grok (`intra_compaction` threshold from initialize `_meta`), OpenCode, Pi (`compaction_start`/`_end`, aborted → failed, usage refresh) | `bun run test` — **2508 passed**; 2 recurring failures reproduce on base | 9 / 0 / 1 | Hand-built event fixtures, no recorded real streams; Kilo only via shared factory | Capture one real compaction event trace per provider |
| #64 | PR 8: compaction web UI | `devin/compaction-pr8-web-ui` → pr7 | L; 21 files, +572/−43 | 5 files: `ContextWindowMeter.test.tsx` (spinner, retryable/non-retryable error, synara-auto copy, settings-toggle gating), `MessagesTimeline.test.tsx` (failed entry), `workLog.test.ts`, server-side reactor/ingestion | `bun run test` — all web/contracts pass; only 2 recurring server failures | 9 / 0 / 1 | **UI never exercised in a real browser** (jsdom only); screenshot checklist unchecked; no `/compact` slash-command toast test (`useComposerSlashCommands.ts`); no settings-input validation test; no "Compact now" round-trip test through the WS client | Manual or Playwright browser pass before merge; add screenshots |
| #65 | PR 9: Synara-auto fallback | `devin/compaction-pr9-synara-auto` → pr8 | L; 5 files, +760/−11 | 2 files (~25 decls): `decideCompaction.test.ts` (percent/remaining/absolute triggers, missing maxTokens, provider usedPercent, low-confidence pending, cooldown, disabled, non-idle, native deference, unsupported, suspended), `CompactionReactor.test.ts` synara-auto suite (auto-trigger, pending-behind-turn, thrashing/repeated-failure suspension + resume, uncertain suspension) | compaction vitest suite **47/47** | 9 / 0 / 1 | No end-to-end usage → auto-trigger → compactThread → status → UI test; thrash/cooldown interplay reducer-level only | One integration test through ProviderService + reactor with a scripted adapter |
| #66 | Final integration | `devin/compaction-final-integration` → `main` | **XXL**; 69 files, +6386/−247; `--no-ff` merge of #55–#65 | Cumulative 26 test files; characterization suite passes unchanged vs. merged code (8/8) | fmt pass; lint 0 errors (250 pre-existing warnings); typecheck 8/8; `bun run test` — **2546 passed, 2 failed** (the recurring pair) | 9 / 0 / 1 | Inherits every gap above; lands on `main` with **no browser-level or live-provider validation** | Gate: one browser pass over compaction UI + one live compaction (Claude or Codex) before merge |

### Recurring "pre-existing" test failures

Cited by nearly every PR (#55, #56, #57, #59, #60, #61, #63, #64, #66) and claimed to reproduce on the unmodified base:

1. `apps/server/src/git/GitCore.test.ts` — "reuses an existing remote…" trailing-slash assertion (`origin-1` vs `origin`).
2. `apps/server/src/provider/acp/AcpSdkConformance.test.ts` — 90s timeout in "preserves early session updates and prompt update ordering" (environment-dependent/flaky; #56 notes it passes on re-run).

Local reproduction was not possible in the audit environment (`bun install` prepare scripts — the `@effect/language-service` ts-patch — were repeatedly SIGKILLed). GitHub CI's test job is green on all 12 PRs, suggesting local-environment artifacts. **They remain unfixed on `main` and should be triaged.**

### Cross-cutting test recommendations

- Re-run #55's Windows Process Regression job; pin/harden the ts-patch prepare step on Windows if it recurs.
- Triage the two recurring local failures on `main` (fix GitCore's trailing-slash remote reuse; raise or stabilize the AcpSdkConformance timeout).
- Add a Playwright pass (CI already has a "Browser Test" stage): context-meter compaction states, "Compact now", settings toggle/threshold/cooldown, retry affordance.
- Run one live manual `/compact` and one Synara-auto trigger against a real provider before merging #66.
- Record verified provider CLI versions in `compactionBehavior.test.ts` and schedule periodic re-verification.
- Add property-based tests for `compactionReducer` and a kill/restart integration test for `CompactionReactor`.

---

## 4. Acceptance Criteria Matrix (41 criteria, spec §32)

Audited against `devin/compaction-final-integration` (PR #66).

**Summary:** verified 32 · implemented-not-tested 5 (7, 8, 9, 10, 11) · partial 4 (4, 16, 32, 40) · not-addressed 0.

Key file abbreviations: `CR` = `apps/server/src/orchestration/compaction/CompactionReactor.ts` (+ `.test.ts`); `decide` = `.../decideCompaction.ts`; `state` = `.../compactionState.ts`; `status` = `.../compactionRuntimeStatus.ts`; `PSvc` = `apps/server/src/provider/Layers/ProviderService.ts`; `char` = `.../compactionBehavior.test.ts`; `disc` = `packages/contracts/src/providerDiscovery.ts`; `ctxUI` = `apps/web/src/lib/contextWindow.ts` + `apps/web/src/components/chat/ContextWindowMeter.tsx` (each + tests).

### Capability truth (1–5)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Every provider has structured compaction capabilities | #55, #63, #58 | `ProviderCompactionCapabilities` schema (`disc:54-77`); descriptors in all 8 adapter files + `codexAppServerManager.ts:1956` (Kilo reuses OpenCode's) | `disc.test` descriptor decode; `char` capability flags cover 7 kinds | verified | Claude/Kilo not in the characterization table |
| 2 | ACP does not imply auto-compaction | #55, #58 | Cursor `manual: unsupported` "ACP proves no compaction path" (`CursorAdapter.ts:127-144`); Droid probe requires advertised command (`DroidAdapter.ts:132-160`) | Cursor + Droid probe tests | verified | — |
| 3 | Interactive CLI commands do not imply protocol support | #55, #58 | Droid TUI `/compress` documented rollover-only; probe stays `unsupported` unless compact/compress advertised (`DroidAdapter.ts:1982-2002`) | Droid probe flip/stay tests | verified | — |
| 4 | OpenCode and Kilo can report distinct behavior | #55, #63 | Kilo has its own `KILO_ADAPTER_CONFIG` (`OpenCodeAdapter.ts:118-130, 4126-4140`) but the compaction descriptor is one shared constant (`:4041-4057`) | None Kilo-specific | **partial** | No Kilo-specific descriptor or divergence test |
| 5 | Unsupported providers are displayed honestly | #64 | `deriveContextCompactionMeterCopy` "unavailable" from descriptor only; `manualAvailability.reason` (`status:96-104`) | Meter + contextWindow unavailable tests | verified | — |

### Manual operations (6–14)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | Codex manual compaction works | #56, #60 | `thread/compact/start` in `codexAppServerManager.ts`; capability `same-session`/`native-rpc` | manager progress test; `char` projections; `PSvc.test` (mocked) | verified | No live e2e vs. real Codex CLI |
| 7 | Grok manual compaction works | #56, #63 | `GrokAdapter.ts:1967` `compactThread` via ACP `/compact` (`x.ai/compact_conversation`) | Only the between-turn heuristic tested; **nothing drives `compactThread`** | **implemented-not-tested** | No unit or live test of Grok `compactThread` |
| 8 | OpenCode manual compaction works | #56, #63 | `compactThread` via `session.summarize` | `char` asserts surface exists only | **implemented-not-tested** | No e2e test |
| 9 | Kilo manual compaction works | #63 | Shares OpenCode adapter (`makeKiloAdapterLive`) | None Kilo-specific | **implemented-not-tested** | Inherits #8 + no Kilo test |
| 10 | Pi manual compaction works | #56, #63 | `compactThread` via `session.compact()` | `char` asserts surface exists only | **implemented-not-tested** | No test exercising Pi `compactThread` |
| 11 | Claude does not expose fake manual support | #55, #63 | Descriptor `manual: unsupported` (`ClaudeAdapter.ts:5231-5247`) | No adapter test; Claude absent from `char` table | **implemented-not-tested** | Add Claude to characterization/capability test |
| 12 | Cursor does not expose fake manual support | #55, #58 | `cursorCompaction` `manual: unsupported` (`CursorAdapter.ts:129-144`) | Cursor test + `char` table | verified | — |
| 13 | Droid does not expose fake ACP manual support | #58 | `resolveDroidCompactionCapabilities` probes live commands; `unsupported` default | Probe tests; `char` table | verified | — |
| 14 | Antigravity does not expose synthetic support | #58 | Fully `unsupported`; design-gated (`AntigravityAdapter.ts:40-57`) | "unsupported until the synthetic design is approved" | verified | — |

### Automatic behavior (15–22)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | Provider-native auto is the default where available | #65 | `decide:101-103` returns `none`/`provider-native-auto` under native auto | native-deferral tests | verified | — |
| 16 | Provider-native thresholds are used rather than replaced | #62, #65 | Synara never overrides native triggers; `providerAutoTrigger` (`status:28-45`) reports for display only | `status.test` trigger tests | **partial** | **Grok descriptor `enabledByDefault: true` vs. characterization note CLI default `enabled: false` @ 85% — one is wrong** |
| 17 | Synara does not double-compact | #65 | `decide:101-103` abstains under native auto; `CR` dedupes by requestId, rejects while pending/running (`CR:442-452`) | no-auto-trigger + duplicate-id tests | verified | — |
| 18 | Synara auto is hidden unless eligible | #64, #65 | Settings section only when `automatic.mode !== "native"` and manual supported (`ContextWindowMeter.tsx:222-246`); `autoOptionsFromSettings` null without evaluable trigger (`CR:64-81`) | meter-state tests | verified | — |
| 19 | Missing or unreliable usage causes abstention | #59, #65 | `decide:121-131`: `usage-unavailable` / `pending` on low confidence or `processed-total-only` | decide tests for all three | verified | — |
| 20 | Active turns are never compacted concurrently | #60, #61 | `PSvc:2284-2288` rejects during active turn; `CR:456-470` defers | deferral + pending tests | verified | — |
| 21 | Pending auto requests re-evaluated after turn completion | #61, #65 | `promotePendingRequest` on `turn.completed/aborted` (`CR:574-582, 628-634`) | defer-then-compact test | verified | — |
| 22 | Thrashing suspends automatic behavior | #65 | Cooldown re-check suspends as `compaction-thrashing` (`CR:545-561`); repeated failures suspend after 2 (`CR:505-509`) | suspension + resume tests | verified | — |

### Session safety (23–29)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | Same-session compaction preserves the binding | #60 | `applyCompactionResult` keeps runtime live (`PSvc:2134-2160`) | binding-active + analytics test | verified | — |
| 24 | Restart-required behavior is explicit | #56, #60 | `runtime-restart-required` kind; binding stopped (`PSvc:2160-2185`); `sessionEffect: "runtime-restart"` persisted (`CR:361-364`) | stop test | verified | — |
| 25 | Session rollover is atomic | #60 | Old session stopped and rebound in one `applyCompactionResult` pass (`PSvc:2185-2210`) | rollover test asserts `stopSession` + rebind | verified | — |
| 26 | Stale lifecycle generations are rejected | #60, #61 | `expectedLifecycleGeneration` checked in `PSvc:2272-2274` and `CR.validate` (`CR:414-427`) | stale-generation tests in both layers | verified | — |
| 27 | Uncertain operations are not retried blindly | #61 | Sticky `uncertain` (`state:99-111`); reconciliation settles interrupted running as uncertain, non-retryable (`CR:658-713`) | no-auto-retry + reconciliation + state tests | verified | — |
| 28 | Resume works after compaction | #60 | Compacted state doesn't tear down active turns; idle cleanup skipped (`PSvc`) | 3 preservation/cleanup tests | verified | — |
| 29 | Provider and Synara thread identities remain consistent | #60 | `lastRuntimeEvent: "provider.compactThread"`, thread id unchanged across result kinds (`PSvc:2123-2210`) | binding-payload assertions per result kind | verified | — |

### Observability (30–35)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 30 | Compaction has one stable lifecycle item | #62, #64 | Work log collapses progress rows into terminal row (`apps/web/src/workLog.ts:685, 763-780`) | 3 collapse tests | verified | — |
| 31 | Start, completion, and failure are normalized | #57, #61, #62 | Canonical `ThreadCompactionLifecycleEvent`s; native events mapped to same reducer (`CR:584-643`) | ingestion projection + full-lifecycle state tests | verified | — |
| 32 | Before/after usage shown when available | #61, #62 | `beforeUsage`/`afterUsage` captured (`CR:336, 356`), persisted (migration 73), exposed via `lastCompaction` (`status:113-138`) | status + decode tests | **partial** | **Web UI never renders the before/after numbers** (meter shows phase/trigger copy only) |
| 33 | Opaque data is labelled opaque | #55, #62 | Explicit `opaque` trigger kind; `formatCompactionTriggerLabel` returns null instead of inventing a threshold (`ctxUI:549-562`) | opaque-trigger + meter tests | verified | — |
| 34 | Native owner vs Synara owner is visible | #62, #64 | `owner: provider/synara/none` (`status:83-86`); distinct meter copy (`ctxUI:593-604`) | provider-/synara-managed copy tests | verified | — |
| 35 | Analytics contain no summaries/transcript contents | #60 | `analytics.record("provider.thread.compacted", { provider, resultKind, owner, trigger, durationMs })` only (`PSvc:2292-2298`) | exact-property-set assertions | verified | — |

### Maintainability (36–41)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | Policy is pure and unit-tested | #65 | `decideAutoCompaction` + `compactionReducer` pure with explicit inputs | 18 + 6 cases, every branch | verified | — |
| 37 | Provider mechanics remain in adapters | #56, #63 | Each `compactThread` in its adapter; specifics never leak into orchestration | `char` compactThread-exactly-for-manual test | verified | — |
| 38 | Coordination remains in orchestration | #61 | `CompactionReactor` under `orchestration/compaction/`; `wsRpc.ts:1366-1371` routes through the reactor | `CR.test` suite | verified | — |
| 39 | No recurring polling loop | #61, #65 | Drainable worker fed only by runtime events (`CR:716-742`); decisions on `thread.token-usage.updated`, no timers | event-driven behavior throughout `CR.test` | verified | — |
| 40 | No provider-specific threshold hardcoded in generic code | #62 | Mostly clean, but `compactionRuntimeStatus.ts:23-45` hardcodes `PI_DEFAULT_RESERVE_TOKENS = 16384`, `GROK_DEFAULT_TRIGGER_PERCENT = 85`, and a Claude case (display-only) | `status.test` locks the values in | **partial** | Display thresholds for Grok/Pi/Claude live in orchestration, not adapter descriptors |
| 41 | No premature generic ACP compaction state machine | #58 | Only the per-provider Droid command probe; no shared machinery | Droid probe tests | verified | — |

### Top acceptance blockers

1. **Manual compaction paths for Grok, OpenCode, Kilo, and Pi have no tests** (criteria 7–10): `compactThread` implementations are only asserted to *exist*; nothing drives them, even mocked. Codex is the only provider whose manual path is exercised.
2. **Claude is absent from the characterization table** (criterion 11): `manual: unsupported` is code-only with no regression guard.
3. **Before/after usage is plumbed but not rendered** (criterion 32).
4. **Grok auto-compaction default mismatch** (criterion 16): descriptor `enabledByDefault: true` vs. characterization CLI default `enabled: false` @ 85% — could mislead the decider's native-auto deferral.
5. **Provider-specific display thresholds in orchestration** (criterion 40): Grok 85% / Pi 16,384 / Claude window logic in `compactionRuntimeStatus.ts` instead of adapter descriptors.

---

## 5. Architecture Risks (prioritized)

Verdict up front (agent 4): the shape — pure reducer + pure decider + durable operation rows + a single event-driven reactor worker — is right, and the plan's hard constraints are respected in the generic code. Material risks concentrate in (a) in-memory state that should be durable, (b) a request-admission race, (c) the Codex "completed on acknowledgement" mismatch, and (d) unbounded per-thread maps.

| # | Risk | Severity | Where |
| --- | --- | --- | --- |
| 1 | **Thread compaction settings and suspensions are memory-only** — `setThreadSettings` (`CompactionReactor.ts:747-760`) writes only to the in-memory `settings` map; nothing persists `ThreadCompactionSettings`. Every server restart silently disables all Synara-managed auto-compaction until the client re-sends settings, and thrashing/repeated-failure `suspended` state is wiped (reconciliation only rehydrates pending/running rows). Undermines the "durable, event-driven" premise for the auto path. | **High** | `CompactionReactor.ts:121, 747-760` |
| 2 | **Codex compaction settles `completed` on start-acknowledgement with stale `afterUsage`, then re-enters as a phantom provider-owned pass.** `runOperation` marks completed as soon as `providerService.compactThread` returns (`CR:355-372`), but the Codex adapter resolves on the `thread/compact/start` acknowledgement (`codexAppServerManager.ts:1600-1604`; `CodexAdapter.ts:1859-1873`). The later `context_compaction` item events then re-enter `running` as a provider-owned pass with a synthetic `provider:${eventId}` id (`CR:584-601`, since state is already `idle`). `afterUsage: latestUsage.get(...)` (`CR:356`) is a pre-compaction snapshot. Fix: adapters whose compact call is start-only should await the completion event internally (as Grok does) or return a result kind telling the reactor to wait. | **High** | `CompactionReactor.ts:351-372, 584-601`; `CodexAdapter.ts:1859-1873`; `codexAppServerManager.ts:1561-1604` |
| 3 | **Admission race: two requests with different ids can both pass the state check during async `validate` and double-compact.** `request` (`CR:431-472`) checks `getState(threadId)`, then runs multi-async-lookup `validate` before `runOperation` emits `thread.compaction-started`; a manual RPC racing a forked auto run can both invoke `providerService.compactThread`. The reducer ignores the second `started` (`compactionState.ts:79-81`) so durable state stays coherent, but two provider compactions execute; requestId-dedupe (`CR:434-441`) doesn't help. Fix: re-check state (or a per-thread admission slot) synchronously after `validate`; `autoInFlight` already does half of this for auto only. | **Medium-High** | `CompactionReactor.ts:431-472` |
| 4 | **Provider-native start clobbers a queued pending Synara request → back-to-back double compaction.** `handleProviderNativeStarted` early-returns only for `running` (`CR:586-589`); a native pass overwrites `pending`, but the waiter stays in `pendingWaiters` and promotes on turn completion (`CR:574-582`), compacting again right after the native pass. Promotion should re-validate against current state/usage or drop the waiter after a provider-owned completion. | **Medium** | `CompactionReactor.ts:574-601`; `compactionState.ts:78-91` |
| 5 | **Unbounded in-memory growth; discovery-failure amplification.** `settledResults` is never evicted (`CR:134, 322-323`); `states`, `latestUsage`, `lastCompactions`, `lastAutoCompactionAt` grow monotonically per thread with no eviction on thread deletion. Capability cache (`CR:124, 148-167`) caches positives forever but not `null` results, so a provider whose discovery errors is re-queried on every token-usage event via `maybeAutoCompact` → `lookupCapabilities` (`CR:519-523`). TTL/LRU for `settledResults`; cache negatives. | **Medium** | `CompactionReactor.ts:120-134, 148-167` |
| 6 | **Manual compaction rejected while auto-suspended** (`CR:443-447`), including `trigger: "manual"` — removing the natural user recovery action from thrashing. Allow manual requests through suspension (running/pending checks already prevent double-runs). | Medium-Low | `CompactionReactor.ts:443-447` |
| 7 | **`retryable` semantics disagree**: client phase reports `uncertain` as `retryable: true` (`compactionRuntimeStatus.ts:59`) while the durable row records `retryable: false` (`CR:381`: `retryable: outcomeKnown`). Pick one semantic and align. | Low | `compactionRuntimeStatus.ts:59`; `CompactionReactor.ts:381` |
| 8 | **Analytics hardcodes `owner: "provider"` for every `compactThread` call** (`ProviderService.ts:2292-2298`), contradicting the reactor's durable rows which record `owner: "synara"` for synara-auto/manual (`CR:341-350`). Derive from trigger or pass through. | Low | `ProviderService.ts:2292-2298` |
| 9 | **Provider-specific constants and name-switches in generic orchestration** (`PI_DEFAULT_RESERVE_TOKENS = 16_384`, `GROK_DEFAULT_TRIGGER_PERCENT = 85`, Claude case; `providerAutoTrigger` switch): not a plan violation (descriptive, not policy) but belongs in adapter descriptors (e.g. optional `automatic.nativeTrigger`); the switch silently returns `opaque` on rename or a tenth provider. | Low | `compactionRuntimeStatus.ts:23-45` |
| 10 | **OpenCode descriptor unverified against a live server** (`OpenCodeAdapter.ts:4038-4041` admits it); **Pi start/end items use uncorrelated random ids** (`PiAdapter.ts:1797-1826`), so consumers see two half-open items per pass. | Low | `OpenCodeAdapter.ts:4038-4041`; `PiAdapter.ts:1797-1826` |

### Additional design issues (non-risk-table)

- **Contracts:** `ThreadCompactionSettings` (`providerRuntime.ts:531-536`) allows `autoEnabled: true` with an absent/`opaque` trigger; `autoOptionsFromSettings` silently no-ops (`CR:64-81`) — should be rejected at the RPC boundary (`wsRpc.ts:1368-1371`). The legacy `supportsThreadCompaction` boolean travels with every descriptor with no deprecation marker; already re-derived in five adapters.
- **ProviderService:** TOCTOU between the active-turn check and the adapter call (`PSvc:2276-2289`) — Grok defends itself (`turnStarting` + `compactingThread` in one synchronous block, `GrokAdapter.ts:2036-2046`); Codex/OpenCode/Pi rely on the racy outer check. `same-session` results force binding status to `"running"` regardless of prior status (`PSvc:2150-2158`); prefer preserving `binding.status` as the rollover branch does (`:2200`). Validation is duplicated across reactor and service with different "active turn" sources.
- **Reducer/decider (strongest part):** `compactionReducer` is pure and total with stale-request-id protection (`compactionState.ts:61-134`); `decideAutoCompaction` correctly defers to native auto, requires an explicit trigger, refuses unreliable telemetry, gates on idle. Minor: `triggerReached` percent fallback (`decideCompaction.ts:62-67`) deserves a parity test between `usedPercent` and `usedTokens/maxTokens` paths.
- **Maintainability:** the "no compaction during an active turn" invariant is enforced in three layers with three data sources (reactor projection `session.activeTurnId` `CR:456`; service binding + `listSessions` `PSvc:2276-2282`; Grok context flags `GrokAdapter.ts:2036-2046`) — document which is authoritative. Instructions-unsupported rejection is copy-pasted in Codex/OpenCode/Pi adapters while `PSvc:2255-2265` already centrally rejects — delete one layer. `outcomeKnownForError` (`CR:99-110`) classifies by error tag name; new tags silently default to `uncertain` — use an explicit `outcomeKnown` field or exhaustive switch. Two files named `CompactionReactor.ts` hurt grep ergonomics. Reconciliation minor issues: pending `provider-auto` coerced to `synara-auto` (`CR:686`); interrupted provider-owned rows settled as scary `uncertain` (`CR:690-712`); `publishStatus` serializes via `JSON.parse(JSON.stringify(...))` (`CR:195`).
- **Untested interleavings that matter:** the R3 admission race (needs a slow-`validate` two-request test); native `item.started` while a Synara request is `pending` and `item.completed` after a premature `completed`; settings/suspension restart behavior (untestable while memory-only); `applyCompactionResult` rollover crash-ordering (comment claims crash safety at `PSvc:2187-2189`, no test kills between the two upserts); `compactionBehavior.test.ts` pins descriptor shapes only, not adapter compact behavior against a fake runtime for Codex/OpenCode/Pi.

### Plan-constraint compliance

| Constraint | Status |
| --- | --- |
| No universal 85% default in generic code | **Compliant.** No trigger ⇒ no auto-compaction (`CR:61-81`); the `85` in `compactionRuntimeStatus.ts:24` is a descriptive report of Grok's native behavior — but move it into the Grok descriptor. |
| Event-driven, no recurring polling loop | **Compliant.** Decisions only on `thread.token-usage.updated`; no `setInterval`/`Schedule` loops. |
| Never retry uncertain compaction operations | **Compliant** in the reactor; one inconsistency: client-facing phase claims `retryable: true` (risk #7). |
| No shared ACP compaction machinery before a 2nd verified provider | **Compliant.** Grok's machinery is fully local to `GrokAdapter.ts` — extract (don't copy) when the second ACP provider lands. |
| No global/provider/project/thread settings hierarchy in v1 | **Compliant.** Thread-scoped only — but also not persisted at all (risk #1). |
| Descriptors are truth-claims, no faked operations | **Mostly compliant.** Claude/Antigravity honest; OpenCode descriptor ahead of verification; Codex's `same-session` return issued before actual completion (risk #2). |

---

## 6. Live Testing and Key Requirements

### 6.1 Current secrets (presence only)

| Secret | Present | Relevant to compaction testing |
| --- | --- | --- |
| `OPENCODE_GO_API_KEY` | yes | yes — OpenCode Zen endpoint; **authenticates but workspace `wrk_01KG0AV4VVG9H2CXDKQHAAZ29D` has zero credit** (`POST /zen/v1/chat/completions` → HTTP 401 `CreditsError: "Insufficient balance"`; `GET /zen/v1/models` is public and lists `gpt-5.4`-family and `claude-*` models) |
| `GITHUB_TOKEN` | yes | no (git operations only) |
| `CRATES_IO_TOKEN` | yes | no |
| `windsurf_api_key` | yes | no (Devin CLI only; must not be used elsewhere) |
| `XAI_API_KEY` | **no** | needed for Grok |
| `OPENAI_API_KEY` | **no** | needed for Codex (or ChatGPT `codex login`) |
| `ANTHROPIC_API_KEY` | **no** | needed for Claude Code (or subscription login) |
| `PI_API_KEY` | **no** | needed for Pi |
| `DROID_API_KEY` | **no** | needed for Droid (compaction unsupported via ACP anyway) |
| `CURSOR_API_KEY` | **no** | Cursor has no compaction support |

### 6.2 Missing keys / blockers

| Provider | Blocker |
| --- | --- |
| Codex | `OPENAI_API_KEY` or interactive `codex login` (ChatGPT plan) |
| Claude | `ANTHROPIC_API_KEY` or interactive `claude` login |
| Grok | `XAI_API_KEY` or interactive `grok` login |
| OpenCode/Kilo | credit top-up on the existing Zen workspace, or any provider key `opencode auth` accepts |
| Pi | `PI_API_KEY` |
| Droid | `DROID_API_KEY` — but compaction unsupported via ACP regardless |
| Cursor / Antigravity | n/a — no compaction support |

### 6.3 Test matrix

| Provider | Manual compaction | Auto compaction | Key status today | Live-testable today |
| --- | --- | --- | --- | --- |
| Codex | yes (`thread/compact/start`) | yes (`compactsAutomatically`) | missing (`OPENAI_API_KEY`) | no |
| Claude | no (auto-only) | yes (`autoCompactWindow` budget) | missing (`ANTHROPIC_API_KEY`) | no |
| Grok | yes (`/compact` prompt) | no | missing (`XAI_API_KEY`) | no |
| OpenCode | yes (`session.summarize`) | yes (`compaction` part, `overflow`) | key valid, **zero credit** | no (needs top-up) |
| Kilo | yes (same adapter) | yes (same adapter) | none | no |
| Pi | yes (`session.compact`) | no | missing (`PI_API_KEY`) | no |
| Droid | unsupported (ACP) | unsupported | missing (moot) | no |
| Cursor | unsupported | unsupported | missing (moot) | no |
| Antigravity | unsupported | unsupported | n/a | no |

**Bottom line: no provider is live-testable today.** Cheapest first live test: top up the OpenCode Zen workspace (key already works). Next-best: `XAI_API_KEY` (Grok's manual `/compact` is the most self-contained adapter flow) or `OPENAI_API_KEY` (Codex covers both manual and auto).

### 6.4 Per-provider live-test recipes

All recipes assume the isolated harness in §6.5 and driving Synara's server RPC `thread/compact` (or the equivalent adapter method) from the web UI or a WebSocket client.

**Codex** — Install `npm i -g @openai/codex`; auth `OPENAI_API_KEY` or `codex login`. Synara path: `CodexAdapter.compactThread` → `codexAppServerManager.compactThread` → app-server `thread/compact/start`; progress `thread/compacting` (item `context_compaction`, detail "Compacting context") then `thread/compacted` → state `compacted`. Standalone sanity: `codex` TUI `/compact`, or `codex app-server` with JSON-RPC `{"method":"thread/compact/start","params":{"threadId":"..."}}`. Through Synara: start a Codex thread, one short turn, trigger compaction from the thread menu; expect `item.updated` with `itemType: "context_compaction"` then `thread.state.changed` → `"compacted"`. Auto: fill context with large pasted inputs (~200k tokens) until `thread/compacting` fires without a manual request; also set `model_auto_compact_token_limit` low to confirm native auto mid-turn.

**Claude Code** — Install `npm i -g @anthropic-ai/claude-code`; auth `ANTHROPIC_API_KEY` or interactive login. No manual RPC; `ClaudeAdapter` passes `autoCompactEnabled: true` + optional `autoCompactWindow` (from model options / "Auto-compact" selector). Force cheaply: pick the smallest `autoCompactWindow` option, send a few prompts with large pasted files (tens of thousands of tokens); watch for the SDK `compact_boundary` message → state `compacted` (status `compacting` maps to a `waiting` turn state). Also flip the auto-compact budget between 200k/1M and verify the warning copy. The TUI `/compact` exists but is not the path Synara exercises.

**Grok** — Install the xAI Grok CLI (`npm install -g @xai-official/grok`; health check runs `grok models`); auth `XAI_API_KEY` or login. Synara path: `GrokAdapter.compactThread` sends the literal `"/compact"` prompt, guarded by `compactingThread` (rejects concurrent sends), a hard timeout (`GROK_COMPACT_TIMEOUT_MS`), and a post-timeout quiet window (`GROK_COMPACT_ABANDON_QUIET_MS = 5s`); a failed compaction tool-call is recorded (`compactionFailedToolDetail`) so a "successful" `/compact` with a failed tool is not persisted as compacted. Manual: 1–2 turns, trigger compaction (optionally with instructions, e.g. `/compact keep the test plan`); expect a single `context_compaction` item then state `compacted`; assert shrunk `context` output. Auto: no adapter-forced path; drive usage toward the 500k window to see whether any native auto event fires.

**OpenCode / Kilo** — Install `npm i -g opencode-ai` (or `@kilocode/cli`); auth `opencode auth login` or provider key env; hosted Zen uses `OPENCODE_API_KEY`/the Go key. Synara path: `compactThread` calls SDK `session.summarize` with the current `provider/model` slug (errors without a selection). Events: `session.compacted` → state `compacted`; message parts with `part.type === "compaction"` emit `context_compaction` progress; `overflow: true` produces "Compacting context after provider context overflow"; `auto` flags auto-compaction. Manual: thread on e.g. `opencode/gpt-5.4`, one turn, trigger compaction (TUI: `/compact`, alias `/summarize`); assert `session.compacted` on the SSE event bus and a `compaction` part. Auto: exceed the model's context (or set `compaction.reserved` high on a cheap model) until a `compaction` part arrives with `auto: true` / `overflow: true` — the only adapter distinguishing overflow-driven compaction, the best auto-verification target. For Kilo, additionally confirm the fork preserved `session.compacted` / compaction parts and diff `overflow.ts` constants.

**Pi** — Install `npm i -g @earendil-works/pi-coding-agent`; auth `PI_API_KEY`. Synara path: `PiAdapter.compactThread` → `session.compact()`; events `compaction_start`/`compaction_end` map to `context_compaction` items ("Compacting context" / "Context compacted"). Manual: one short turn, trigger compaction; expect the start/end item pair. Also (standalone `pi --mode rpc`): send `compact` with and without `customInstructions`; toggle `set_auto_compaction` and cross the `contextWindow − 16384` boundary; assert start/end ordering and post-compact token drop. No adapter-forced auto path — test manual only through Synara.

**Droid / Cursor / Antigravity** — `supportsThreadCompaction: false` for all three; nothing to live-test end-to-end through Synara. Discovery-only checks: Droid — ACP `initialize` + `session/new`, dump `availableCommands`; if compact is advertised, invoke and check session-id preservation vs. rollover. Cursor — dump ACP capabilities for any compact-like command; watch a long session for context-shrink; downgrade `automatic.mode` to `"unknown"` if nothing appears. Antigravity — inspect long-session transcripts for compaction/summary artifacts before upgrading the descriptor.

### 6.5 Safe test harness

Follow the repo's Local Dev Instance Isolation rules (AGENTS.md):

```bash
# dry-run first to confirm no port collisions
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 bun run dev -- \
  --home-dir ./.synara-compaction-test --port 58090 --dry-run

# real run
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 SYNARA_NO_BROWSER=1 bun run dev -- \
  --home-dir ./.synara-compaction-test --port 58090
```

- Never start plain `bun run dev` while the user's instance is running.
- Unset `SYNARA_AUTH_TOKEN` so the dev browser WebSocket is not rejected.
- Verify ports with `lsof -nP -iTCP:58090 -sTCP:LISTEN` (both IPv4 and IPv6 binds).
- Isolated state lives under `./.synara-compaction-test` (own `state.sqlite`) — test threads never touch the user's history.
- Post-hoc verification: query the native event log in the isolated `state.sqlite` for `item.updated` rows with `itemType = 'context_compaction'` and `thread.state.changed` rows with `state = 'compacted'`. Provider child-process traffic (Codex app-server JSON-RPC, ACP stdio for Grok/Pi/Droid) can be captured by pointing the provider `binaryPath` at a wrapper script that tees stdin/stdout to a log before exec'ing the real binary. If the UI shows no threads, probe `orchestration.getSnapshot` over WebSocket before assuming state loss.

### 6.6 Verification environment note

The provider verification (agent 2) was performed on a fresh VM: the referenced pre-installed CLI paths (`/home/ubuntu/.grok/bin/grok`, `/home/ubuntu/clis/node_modules/.bin/{codex,opencode}`) were empty, so binaries were freshly installed and sources cloned: Grok CLI `grok 0.2.106 (bde89716f6)`, Codex CLI `codex-cli 0.144.6`, OpenCode CLI `1.18.4` (all under `/home/ubuntu/clis/node_modules/.bin/`), plus source clones of openai/codex, sst/opencode, badlogic/pi-mono, and a Synara worktree at `devin/compaction-final-integration` (`7a808a7f`). The live-testing agent (agent 5) had none of the provider CLIs installed; its recipes derive from adapter source, `ProviderHealth.ts` install metadata, and upstream docs, with install commands included.

---

## 7. Recommended Next Steps

1. **When keys arrive, test in this order:** (a) top up the OpenCode Zen workspace and run the OpenCode manual + auto/overflow recipe (§6.4) — highest value, only adapter with explicit auto/overflow signals; (b) `XAI_API_KEY` → Grok manual `/compact` with instructions (most self-contained flow, and the adapter with zero `compactThread` test coverage); (c) `OPENAI_API_KEY` or `codex login` → Codex manual + auto, which also directly exercises the High-severity risk #2 interleaving (start-ack completion + phantom provider pass); (d) `ANTHROPIC_API_KEY` → Claude auto via smallest `autoCompactWindow`; (e) `PI_API_KEY` → Pi manual + `customInstructions` probe.
2. **Fix before merging #66 (code changes):**
   - Persist `ThreadCompactionSettings` and suspension state (risk #1, High) — makes "settings survive restart" a one-line test.
   - Fix the Codex premature-completion path (risk #2, High): await the `context_compaction` completion event in the adapter or add a wait-for-completion result kind.
   - Close the admission race (risk #3): synchronous state re-check / per-thread admission slot after `validate`.
   - Resolve the Grok `enabledByDefault` contradiction (criterion 16) — verify against the CLI and fix whichever side is wrong.
   - Re-run #55's Windows Process Regression job (flaky `bun install`/ts-patch failure); pin/harden if it recurs.
3. **Test additions before merge:** drive `compactThread` for Grok/OpenCode/Pi against fake runtimes (criteria 7–10); add Claude to the characterization table (criterion 11); one Playwright pass in the existing Browser Test CI stage covering meter states, "Compact now", settings toggle/threshold/cooldown, and the retry affordance (#64 has zero real-browser coverage); one integration test through ProviderService + CompactionReactor with a scripted adapter (#65).
4. **Merge gate for #66:** one manual (or Playwright) browser pass over the compaction UI + one live compaction against a real provider.
5. **Fix soon after merge (lower severity):** drop the pending waiter after a provider-native pass (risk #4); TTL/LRU `settledResults` and cache negative capability lookups (risk #5); allow manual compaction through suspension (risk #6); align `retryable` semantics (risk #7); derive analytics `owner` from the trigger (risk #8); reject `autoEnabled: true` without an evaluable trigger at the RPC boundary; render before/after usage in the web UI (criterion 32); correlate Pi start/end item ids.
6. **Defer (track as tech debt):** move Grok/Pi/Claude display thresholds into adapter descriptors (`automatic.nativeTrigger`) and remove the provider-name switch in `compactionRuntimeStatus.ts:28-45`; deduplicate the instructions-unsupported rejection (adapter copies vs. `PSvc:2255-2265`); document the authoritative "no compaction during a turn" layer; explicit `outcomeKnown` on error types; deprecation plan for the legacy `supportsThreadCompaction` boolean; property-based `compactionReducer` tests and a kill/restart reactor integration test; CLI-version pinning + scheduled re-verification for the characterization table; Kilo fork-divergence audit; Cursor/Droid `automatic.mode` downgrade to `"unknown"` pending evidence; triage the two recurring local test failures on `main` (`GitCore.test.ts`, `AcpSdkConformance.test.ts`); extraction of Grok's ACP compaction machinery only when a second verified ACP provider lands.

---

## Appendix: Source research files

Full details are in the individual research agent reports in this directory:

- `research/agent-01-test-ci-audit.md` — Per-PR test and CI audit, compaction stack #55–#66.
- `research/agent-02-provider-verification.md` — Provider compaction behavior: verification vs. implementation claims.
- `research/agent-03-acceptance-criteria.md` — Acceptance criteria coverage (41 criteria from spec §32).
- `research/agent-04-architecture-risks.md` — Architecture and code risk review.
- `research/agent-05-live-testing.md` — Live compaction testing feasibility, keys, and recipes.
