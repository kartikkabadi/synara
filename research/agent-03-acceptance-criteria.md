# Research Agent 3: Acceptance criteria coverage

Audit of the 41 acceptance criteria from the compaction implementation spec (§32)
against the code and tests on `devin/compaction-final-integration` (PR #66,
integrating #55–#65).

## Summary

| Status | Count | Criteria |
| --- | --- | --- |
| verified | 32 | 1, 2, 3, 5, 6, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 33, 34, 35, 36, 37, 38, 39, 41 |
| implemented-not-tested | 5 | 7, 8, 9, 10, 11 |
| partial | 4 | 4, 16, 32, 40 |
| not-addressed | 0 | — |

Key file abbreviations:

- `CR` = `apps/server/src/orchestration/compaction/CompactionReactor.ts` (+ `.test.ts`)
- `decide` = `apps/server/src/orchestration/compaction/decideCompaction.ts` (+ `.test.ts`)
- `state` = `apps/server/src/orchestration/compaction/compactionState.ts` (+ `.test.ts`)
- `status` = `apps/server/src/orchestration/compaction/compactionRuntimeStatus.ts` (+ `.test.ts`)
- `PSvc` = `apps/server/src/provider/Layers/ProviderService.ts` (+ `.test.ts`)
- `char` = `apps/server/src/provider/Layers/compactionBehavior.test.ts`
- `disc` = `packages/contracts/src/providerDiscovery.ts` (+ `.test.ts`)
- `ctxUI` = `apps/web/src/lib/contextWindow.ts` (+ `.test.ts`) and `apps/web/src/components/chat/ContextWindowMeter.tsx` (+ `.test.tsx`)

## Capability truth (1–5)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Every provider has structured compaction capabilities | #55, #63, #58 | `ProviderCompactionCapabilities` schema (`disc:54-77`); descriptors in all 8 adapter files + `codexAppServerManager.ts:1956` (Kilo reuses OpenCode's) | `disc.test` "decodes the structured compaction descriptor"; `char` "provider compaction capability flags" covers 7 kinds | verified | Claude/Kilo not in the characterization table (covered by descriptor code only) |
| 2 | ACP does not imply auto-compaction | #55, #58 | Cursor descriptor `manual: unsupported` with comment "ACP proves no compaction path" (`CursorAdapter.ts:127-144`); Droid probe requires an advertised command (`DroidAdapter.ts:132-160`) | `CursorAdapter.test` "stays unsupported because cursor-agent acp proves no compaction path"; `DroidAdapter.test` probe tests | verified | — |
| 3 | Interactive CLI commands do not imply protocol support | #55, #58 | Droid TUI `/compress` documented as rollover-only; ACP probe stays `unsupported` unless compact/compress is advertised (`DroidAdapter.ts:1982-2002`) | `DroidAdapter.test` "stays unsupported when ACP advertises no compaction command" / "flips to supported only when ACP advertises compact/compress" | verified | — |
| 4 | OpenCode and Kilo can report distinct behavior | #55, #63 | Kilo runs the OpenCode-compatible adapter with its own `KILO_ADAPTER_CONFIG` (`OpenCodeAdapter.ts:118-130, 4126-4140`), so per-provider divergence is possible, but the compaction descriptor is a single shared constant (`OpenCodeAdapter.ts:4041-4057`) | None specific to Kilo compaction | partial | No Kilo-specific compaction descriptor or test proving the two can diverge |
| 5 | Unsupported providers are displayed honestly | #64 | `deriveContextCompactionMeterCopy` returns "unavailable" from the descriptor only (`ctxUI`); `manualAvailability.reason` in `status:96-104` | `ContextWindowMeter.test` "renders unavailable copy when the descriptor rules out compaction"; `contextWindow.test` "reports compaction as unavailable when neither manual nor automatic exists" | verified | — |

## Manual operations (6–14)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | Codex manual compaction works | #56, #60 | `thread/compact/start` JSON-RPC in `codexAppServerManager.ts`; `compactThread` surface; capability `same-session`/`native-rpc` | `codexAppServerManager.test` "emits compaction progress before waiting for thread/compact/start"; `char` codex projection tests; `PSvc.test` compaction semantics (mocked codex adapter) | verified | No automated live e2e against a real Codex CLI |
| 7 | Grok manual compaction works | #56, #63 | `GrokAdapter.ts:1967` `compactThread` via ACP `/compact` (`x.ai/compact_conversation`); capability `same-session`/`control-command`/instructions | Only the between-turn heuristic is tested (`char`, `GrokAdapter.test`); no test drives `compactThread` | implemented-not-tested | No unit or live test of the Grok `compactThread` path |
| 8 | OpenCode manual compaction works | #56, #63 | `compactThread` via `session.summarize` (`OpenCodeAdapter.ts`); descriptor `same-session`/`native-sdk` | `char` asserts the surface exists; no test drives it | implemented-not-tested | No test exercising OpenCode `compactThread` end to end |
| 9 | Kilo manual compaction works | #63 | Shares the OpenCode adapter implementation (`makeKiloAdapterLive`) | None Kilo-specific | implemented-not-tested | Inherits #8's gap plus no Kilo-specific test |
| 10 | Pi manual compaction works | #56, #63 | `compactThread` via `session.compact()` (`PiAdapter.ts`); descriptor `same-session`/`native-sdk` | `char` asserts the surface exists; no test drives it | implemented-not-tested | No test exercising Pi `compactThread` |
| 11 | Claude does not expose fake manual support | #55, #63 | Descriptor `manual: unsupported` (`ClaudeAdapter.ts:5231-5247`), native auto only | No adapter test asserts this; Claude absent from the `char` table (only `status.test` touches the Claude trigger) | implemented-not-tested | Add Claude to the characterization table / an adapter capability test |
| 12 | Cursor does not expose fake manual support | #55, #58 | `cursorCompaction` `manual: unsupported` (`CursorAdapter.ts:129-144`) | `CursorAdapter.test` + `char` table (cursor `unsupported`) | verified | — |
| 13 | Droid does not expose fake ACP manual support | #58 | `resolveDroidCompactionCapabilities` probes live advertised commands; `unsupported` by default | `DroidAdapter.test` probe tests; `char` table | verified | — |
| 14 | Antigravity does not expose synthetic support | #58 | `antigravityCompaction` fully `unsupported`; synthetic compaction design-gated behind `docs/antigravity-compaction-design.md` (`AntigravityAdapter.ts:40-57`) | `AntigravityAdapter.test` "asserts compaction is unsupported until the synthetic design is approved" | verified | — |

## Automatic behavior (15–22)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | Provider-native auto is the default where available | #65 | `decide:101-103` returns `none`/`provider-native-auto` when `automatic.mode === "native"` and provider auto isn't disabled | `decide.test` "defers to native provider auto-compaction" / "acts when native auto-compaction is disabled provider-side" | verified | — |
| 16 | Provider-native thresholds are used rather than replaced | #62, #65 | Synara never overrides native triggers; `providerAutoTrigger` (`status:28-45`) only reports them for display | `status.test` trigger tests | partial | Grok descriptor says `enabledByDefault: true` while the characterization notes CLI default `enabled: false` @ 85% — one of the two is wrong |
| 17 | Synara does not double-compact | #65 | `decide:101-103` abstains under native auto; `CR` dedupes by requestId and rejects while pending/running (`CR:442-452`) | `CR.test` "does not auto-trigger ... when native auto is active"; "returns the existing operation for a duplicate request id" | verified | — |
| 18 | Synara auto is hidden unless eligible | #64, #65 | `CompactionSettingsSection` rendered only when `automatic.mode !== "native"` and manual is supported (`ContextWindowMeter.tsx:222-246`); `autoOptionsFromSettings` yields null without an evaluable trigger (`CR:64-81`) | `ContextWindowMeter.test` meter-state tests | verified | — |
| 19 | Missing or unreliable usage causes abstention | #59, #65 | `decide:121-131`: `usage-unavailable` on unevaluable trigger; `pending` on low confidence or `processed-total-only` | `decide.test` "cannot evaluate a percent trigger...", "goes pending instead of compacting on low-confidence usage", "goes pending when the provider only reports processed totals" | verified | — |
| 20 | Active turns are never compacted concurrently | #60, #61 | `PSvc:2284-2288` rejects compaction during an active turn; `CR:456-470` defers requests behind the turn | `CR.test` "defers a request behind an active turn..."; `decide.test` "goes pending behind an active turn" | verified | — |
| 21 | Pending auto requests are re-evaluated after turn completion | #61, #65 | `promotePendingRequest` on `turn.completed`/`turn.aborted` (`CR:574-582, 628-634`); fresh evaluations wait for the next usage event | `CR.test` "defers behind an active turn as pending, then compacts after the turn" | verified | — |
| 22 | Thrashing suspends automatic behavior | #65 | Cooldown re-check suspends as `compaction-thrashing` (`CR:545-561`); repeated failures suspend after 2 (`CR:505-509`) | `CR.test` "suspends as compaction-thrashing..." / "suspends as repeated-failure after two consecutive failures and resumes via settings" | verified | — |

## Session safety (23–29)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | Same-session compaction preserves the binding | #60 | `applyCompactionResult` keeps the runtime live for `same-session` (`PSvc:2134-2160`) | `PSvc.test` "keeps the binding active after same-session compaction and records analytics" | verified | — |
| 24 | Restart-required behavior is explicit | #56, #60 | `runtime-restart-required` result kind; binding marked stopped (`PSvc:2160-2185`); `sessionEffect: "runtime-restart"` persisted (`CR:361-364`) | `PSvc.test` "marks the binding stopped when compaction requires a runtime restart" | verified | — |
| 25 | Session rollover is atomic | #60 | `session-rollover` path stops the old session and rebinds in one `applyCompactionResult` pass (`PSvc:2185-2210`) | `PSvc.test` rollover test asserts `stopSession` and rebind | verified | — |
| 26 | Stale lifecycle generations are rejected | #60, #61 | `expectedLifecycleGeneration` checked in `PSvc:2272-2274` and again in `CR.validate` (`CR:414-427`) | `PSvc.test` "rejects compaction requests with a stale lifecycle generation"; `CR.test` "rejects a request carrying a stale lifecycle generation" | verified | — |
| 27 | Uncertain operations are not retried blindly | #61 | Unknown-outcome failures become sticky `uncertain` (`state:99-111`); reconciliation settles interrupted running ops as uncertain, non-retryable (`CR:658-713`) | `CR.test` "does not retry an uncertain operation automatically" / "reconciles a persisted running operation as uncertain at startup"; `state.test` "marks an unknown-outcome failure as uncertain" | verified | — |
| 28 | Resume works after compaction | #60 | Compacted state does not tear down active turns; idle cleanup skipped after same-session compaction (`PSvc`) | `PSvc.test` "preserves active turns across compacted thread state boundaries", "does not schedule idle cleanup after same-session compaction", "stops a compacted runtime that remains running without an active turn" | verified | — |
| 29 | Provider and Synara thread identities remain consistent | #60 | Binding runtime payload updated with `lastRuntimeEvent: "provider.compactThread"`, thread id unchanged across all result kinds (`PSvc:2123-2210`) | `PSvc.test` compaction-semantics suite asserts binding payloads per result kind | verified | — |

## Observability (30–35)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 30 | Compaction has one stable lifecycle item | #62, #64 | Work log collapses progress rows into their terminal row (`apps/web/src/workLog.ts:685, 763-780`) | `workLog.test` "collapses a compaction progress row into its terminal row", "collapses same-timestamp compaction rows...", "does not merge a new compaction progress row into an earlier terminal row" | verified | — |
| 31 | Start, completion, and failure are normalized | #57, #61, #62 | Canonical `ThreadCompactionLifecycleEvent`s; provider-native events mapped to the same reducer (`CR:584-643`); ingestion projects compacting/compacted/failed uniformly | `ProviderRuntimeIngestion.test` "projects compacted thread state / progress / completion and failure into thread activities"; `state.test` full lifecycle | verified | — |
| 32 | Before/after usage is shown when available | #61, #62 | `beforeUsage`/`afterUsage` captured (`CR:336, 356`), persisted (migration 73 rows), and exposed via `lastCompaction` in `ThreadCompactionRuntimeStatus` (`status:113-138`) | `status.test` "summarizes a settled operation"; `providerRuntime.test` decodes status with last compaction | partial | Web UI does not render the before/after numbers anywhere (meter shows phase/trigger copy only) |
| 33 | Opaque data is labelled opaque | #55, #62 | `CompactionTrigger` has an explicit `opaque` kind; `formatCompactionTriggerLabel` returns null for opaque instead of inventing a threshold (`ctxUI:549-562`) | `status.test` "reports an opaque trigger for Codex and OpenCode"; meter tests | verified | — |
| 34 | Native owner versus Synara owner is visible | #62, #64 | `owner: provider/synara/none` in runtime status (`status:83-86`); distinct "provider-auto" vs "synara-auto" meter copy (`ctxUI:593-604`) | `ContextWindowMeter.test` "renders provider-managed / synara-managed auto compaction copy"; `contextWindow.test` runtime-status suite | verified | — |
| 35 | Analytics contain no summaries or transcript contents | #60 | `analytics.record("provider.thread.compacted", { provider, resultKind, owner, trigger, durationMs })` only (`PSvc:2292-2298`) | `PSvc.test` compaction-analytics assertions capture the exact property set | verified | — |

## Maintainability (36–41)

| # | Criterion | PR(s) | Evidence | Test coverage | Status | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | Policy is pure and unit-tested | #65 | `decideAutoCompaction` and `compactionReducer` are pure functions with explicit inputs | `decide.test` (18 cases) and `state.test` (6 cases) cover every branch | verified | — |
| 37 | Provider mechanics remain in adapters | #56, #63 | Each `compactThread` lives in its adapter (RPC/SDK/command specifics never leak into orchestration) | `char` "expose compactThread exactly for providers with a manual mechanism" | verified | — |
| 38 | Coordination remains in orchestration | #61 | `CompactionReactor` under `apps/server/src/orchestration/compaction/`; `wsRpc.ts:1366-1371` routes RPCs through the reactor, not adapters | `CR.test` suite | verified | — |
| 39 | No recurring polling loop is required | #61, #65 | Reactor is a drainable worker fed only by runtime events (`CR:716-742`); auto decisions run on `thread.token-usage.updated`, no timers | Event-driven behavior exercised throughout `CR.test` | verified | — |
| 40 | No provider-specific threshold is hardcoded into generic code | #62 | Mostly clean, but `compactionRuntimeStatus.ts:23-45` hardcodes `PI_DEFAULT_RESERVE_TOKENS = 16384`, `GROK_DEFAULT_TRIGGER_PERCENT = 85`, and a Claude case inside orchestration code (display-only) | `status.test` locks these values in | partial | Display thresholds for Grok/Pi/Claude live in orchestration rather than the adapters' capability descriptors |
| 41 | No generic ACP compaction state machine is created prematurely | #58 | Only a per-provider command probe for Droid (`resolveDroidCompactionCapabilities`); no shared ACP compaction machinery | `DroidAdapter.test` probe tests | verified | — |

## Top blockers

1. **Manual compaction paths for Grok, OpenCode, Kilo, and Pi have no tests** (criteria 7–10): the adapter `compactThread` implementations are only asserted to *exist* by the characterization suite; nothing drives them, even mocked. Codex is the only provider whose manual path is exercised.
2. **Claude is absent from the characterization table** (criterion 11): its `manual: unsupported` descriptor is code-only with no test guarding against a future fake-manual regression.
3. **Before/after usage is plumbed but not rendered** (criterion 32): `beforeUsage`/`afterUsage` reach persistence and the runtime status, but no web surface shows them.
4. **Grok auto-compaction default mismatch** (criterion 16): the descriptor claims `enabledByDefault: true` while the characterization comment records the CLI default as `enabled: false` (85% threshold) — one is wrong and could mislead the decider's native-auto deferral.
5. **Provider-specific display thresholds in orchestration** (criterion 40): Grok 85% / Pi 16,384 / Claude window logic hardcoded in `compactionRuntimeStatus.ts` instead of coming from the adapters.
