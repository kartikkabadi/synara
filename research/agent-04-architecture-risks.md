# Agent 4 — Architecture and Code Risk Review: Compaction

Scope: the compaction architecture as merged on `devin/compaction-final-integration`
(head `7a808a7f`, merge of `devin/compaction-pr10-provider-expansion`). Reviewed layers:
contracts, `ProviderService` routing, `CompactionReactor` orchestration, the pure state
machine and deciders, and the per-provider adapters (Codex, Claude, Grok, OpenCode, Pi).

Verdict up front: the overall shape is sound — a pure reducer + pure decider + durable
operation rows + a single event-driven reactor worker is the right architecture, and the
plan's hard constraints are respected in the generic code. The material risks are
concentrated in (a) in-memory state that should be durable, (b) a request-admission race,
(c) the Codex "completed on acknowledgement" mismatch, and (d) unbounded per-thread maps.

---

## 1. Contracts layer (`packages/contracts/src/providerRuntime.ts`, `providerDiscovery.ts`)

**Design.** `ProviderCompactionCapabilities` (providerDiscovery.ts:54–77) is a
truth-claim descriptor (`manual.mode`, `automatic.mode`, `telemetry`) rather than a
boolean, with the legacy `supportsThreadCompaction` boolean derived via
`supportsThreadCompactionFromCompaction` (providerDiscovery.ts:80–83). The lifecycle
event union (`ThreadCompactionLifecycleEvent`, providerRuntime.ts:500–527) is small and
covers requested/started/completed/failed/suspended. `SynaraAutoCompactionTrigger`
(providerRuntime.ts:541–546) deliberately excludes `opaque`, so an unevaluable trigger
cannot reach the decider. This is good, minimal contract design.

**Issues.**
- `ThreadCompactionSettings` (providerRuntime.ts:531–536) allows
  `autoEnabled: true` with `trigger` absent or `opaque`; the reactor silently maps this
  to "no auto-compaction" (`autoOptionsFromSettings`, CompactionReactor.ts:64–81) instead
  of rejecting at the RPC boundary. A user who enables auto-compaction with an opaque
  trigger gets silent no-op behavior with no feedback. Recommend validation in
  `providerSetCompactionSettings` handling (wsRpc.ts:1368–1371) that rejects
  `autoEnabled: true` without an evaluable trigger.
- The legacy `supportsThreadCompaction` boolean still travels with every descriptor.
  Fine for migration, but there is no deprecation marker or removal plan; new call sites
  can keep depending on it (it is already re-derived in five adapters).

## 2. ProviderService (`apps/server/src/provider/Layers/ProviderService.ts`)

**Design.** `compactThread` (ProviderService.ts:2234–2303) routes through
`resolveRoutableSession` with `allowRecovery: true`, validates instructions support
against capabilities, checks `expectedLifecycleGeneration` against the binding
(ProviderService.ts:2266–2275), rejects during an active turn, then delegates to the
adapter and applies the result via `applyCompactionResult` (ProviderService.ts:2134–2232).
The session-rollover branch persists the new cursor under a fresh lifecycle generation
*before* retiring the old runtime (ProviderService.ts:2186–2229), which is the correct
crash-safe ordering.

**Issues.**
- **Ownership misclassification in analytics** (ProviderService.ts:2292–2298): the
  analytics record hardcodes `owner: "provider"` for every `compactThread` call,
  including `trigger: "synara-auto"` and `"manual"` requests that the reactor durably
  records with `owner: "synara"` (CompactionReactor.ts:341–350). Analytics and the
  durable operation rows disagree about who owned the same pass. The field should be
  derived from the trigger (or passed through from the reactor), not hardcoded.
- **TOCTOU between the active-turn check and the adapter call**
  (ProviderService.ts:2276–2289): the check reads the binding payload and
  `listSessions()`, then calls `adapter.compactThread`. A turn can start in the gap.
  Grok defends itself (`turnStarting` + `compactingThread` in one synchronous block,
  GrokAdapter.ts:2036–2046), but Codex/OpenCode/Pi rely solely on this racy outer check.
  Low practical likelihood (reactor already defers behind active turns), but the
  invariant "no compaction during a turn" is enforced in three different places with
  three different mechanisms — see Maintainability.
- **`same-session` result forces binding status to `"running"`**
  (ProviderService.ts:2150–2158) regardless of the binding's prior status. If the
  binding was `stopped`/idle-stopped between validation and result application, the
  directory now claims a running runtime that may not exist. Prefer preserving
  `binding.status` the way the rollover branch does (`binding.status ?? "running"`,
  ProviderService.ts:2200).
- Duplicated validation with the reactor: capability lookup, provider-kind check, and
  active-turn check all execute twice per request (CompactionReactor.ts:391–429 and
  ProviderService.ts:2244–2287). Defensible as defense-in-depth (the reactor's view is a
  projection, ProviderService's is the binding), but the divergence risk is real — the
  two layers already use different sources for "active turn".

## 3. CompactionReactor (`apps/server/src/orchestration/compaction/CompactionReactor.ts`)

**Design.** Single drainable worker (capacity 256) consuming
`thread.token-usage.updated`, `turn.completed/aborted`, and `context_compaction`
item events (CompactionReactor.ts:716–742); persist-before-act via `applyEvent` →
`persistOperation`; one-shot startup reconciliation that classifies interrupted rows
instead of resuming them (CompactionReactor.ts:663–714). Uncertain outcomes are sticky
and never auto-retried. Auto-compaction runs are forked into `autoScope` so a deferred
request cannot deadlock the worker that must process the turn-completion event
(CompactionReactor.ts:565–571) — a correctly identified and avoided self-deadlock.

**Issues (ordered by severity).**
- **R1 — Thread settings and suspension state are memory-only.**
  `setThreadSettings` (CompactionReactor.ts:747–760) writes to the in-memory `settings`
  map; nothing persists `ThreadCompactionSettings`. After a server restart every thread's
  auto-compaction is silently disabled until the client re-sends settings, and any
  `suspended` state (thrashing / repeated-failure protection) is likewise wiped —
  reconciliation only rehydrates pending/running rows, not suspensions. This undermines
  the "durable, event-driven" premise for the auto path specifically. Persist settings in
  a table (and either persist suspensions or accept and document that restarts clear
  them; clearing suspensions while also clearing the settings that caused them at least
  fails consistent — but today settings clearing means auto never resumes at all).
- **R2 — Admission race allows two concurrent operations per thread.**
  `request` (CompactionReactor.ts:431–472) checks `getState(threadId)` for
  running/pending, then runs `validate` — which performs multiple async lookups
  (projection query, capability discovery, runtime repo) — before `runOperation` emits
  `thread.compaction-started`. Two concurrent requests with different `requestId`s (e.g.
  a manual RPC racing a forked auto run) can both pass the state check and both invoke
  `providerService.compactThread`. The reducer ignores the second `started` event
  (compactionState.ts:79–81), so the durable state stays coherent, but two provider
  compactions actually execute. The requestId-dedupe (CompactionReactor.ts:434–441) does
  not help because the ids differ. Fix: re-check state (or take a per-thread admission
  slot) synchronously after `validate` returns, immediately before `runOperation`;
  `autoInFlight` already does half of this for the auto path only.
- **R3 — Synara-owned completion is recorded on adapter return, not provider
  completion.** `runOperation` marks `thread.compaction-completed` as soon as
  `providerService.compactThread` succeeds (CompactionReactor.ts:355–372). For Codex the
  adapter resolves on the `thread/compact/start` *acknowledgement*
  (codexAppServerManager.ts:1600–1604; CodexAdapter.ts:1859–1873) — the actual compaction
  completes later and is surfaced via `context_compaction` item events, which
  `handleProviderNativeCompleted` then ignores because `state.owner !== "provider"`
  (CompactionReactor.ts:603–608)... except the state is already `idle` by then, so the
  native-started handler (CompactionReactor.ts:584–601) re-enters `running` as a
  *provider-owned* pass with a synthetic `provider:${eventId}` request id. Net effect for
  Codex manual/synara-auto compaction: a premature `completed` row with a stale
  `afterUsage`, followed by a second phantom provider-owned operation for the same pass.
  `afterUsage: latestUsage.get(...)` at that instant (CompactionReactor.ts:356) is
  whatever pre-compaction snapshot was last seen. Recommend: adapters whose compact call
  is start-only should either await the completion event internally (as Grok does with
  its prompt round-trip) or return a result kind that tells the reactor to wait for the
  `context_compaction` item.completed before settling.
- **R4 — Provider-native start clobbers a pending Synara request.**
  If state is `pending` (Synara request queued behind an active turn) and the provider's
  native auto-compaction fires mid-turn, `handleProviderNativeStarted` only early-returns
  for `running` (CompactionReactor.ts:586–589); the reducer overwrites `pending` with a
  provider-owned `running` (compactionState.ts:78–91). The pending waiter remains in
  `pendingWaiters` and is promoted on turn completion (CompactionReactor.ts:574–582),
  compacting again immediately after the native pass — a double compaction. The
  turn-completed comment (CompactionReactor.ts:629–631) argues stale usage cannot
  re-trigger a *fresh* decision, but an already-queued waiter bypasses that protection.
  Promotion should re-validate against current state/usage (or at least drop the waiter
  if a provider-owned pass completed after the request was queued).
- **R5 — Unbounded in-memory growth.** `settledResults` is never evicted
  (CompactionReactor.ts:134, 322–323): one entry per compaction request for the process
  lifetime. `states`, `latestUsage`, `lastCompactions`, `lastAutoCompactionAt` also grow
  monotonically per thread with no eviction on thread deletion. `settledResults` only
  needs to outlive late duplicate RPCs — a TTL or small LRU suffices.
- **R6 — Pending waiters can hang an RPC forever.** A request deferred behind an active
  turn (CompactionReactor.ts:456–470) resolves only when a `turn.completed/aborted`
  event arrives. If the session is stopped/crashes without either event, the RPC caller's
  `Deferred.await` never settles and the durable row stays `pending` until the *next*
  restart's reconciliation. A timeout or session-stop hook that fails pending waiters
  would bound this.
- **R7 — Capability cache is never invalidated** (CompactionReactor.ts:124, 148–167).
  Positive results are cached per provider forever; fine while descriptors are static
  constants, but OpenCode's descriptor is flagged as pending verification
  (OpenCodeAdapter.ts:4038–4041) and any future dynamic capability breaks this silently.
  Conversely, `null` results are *not* cached, so a provider whose discovery errors gets
  a discovery call on every token-usage event via `maybeAutoCompact` → `lookupCapabilities`
  (CompactionReactor.ts:519–523) — a failure amplifier on the hottest event path.
- **R8 — Manual compaction is blocked by auto-suspension.** `request` rejects any
  request while `suspended` (CompactionReactor.ts:443–447), including `trigger:
  "manual"`. Suspension exists to stop the *auto* loop (thrashing, repeated failure);
  a user manually compacting is a reasonable recovery action and arguably the intended
  way to escape thrashing. Recommend allowing manual requests through suspension (they
  already cannot double-run thanks to the running/pending checks).
- Minor: reconciliation coerces a pending row's `provider-auto` trigger to
  `synara-auto` (CompactionReactor.ts:686) — the state type simply lacks
  `provider-auto` for pending; harmless today (provider passes are never pending) but a
  silent data rewrite. Minor: interrupted *provider-owned* running rows are also settled
  as `uncertain` (CompactionReactor.ts:690–712) even though Synara never owned the
  outcome; the user sees a scary "uncertain" phase for a pass the provider likely
  finished fine. Minor: `publishStatus` serializes via `JSON.parse(JSON.stringify(...))`
  (CompactionReactor.ts:195).

## 4. Pure logic (`compactionState.ts`, `decideCompaction.ts`, `compactionRuntimeStatus.ts`)

**Design.** `compactionReducer` is a genuinely pure, total reducer with stale-request-id
protection (compactionState.ts:61–134). `decideAutoCompaction` is pure with all inputs
explicit, correctly defers to provider-native auto (decideCompaction.ts:101–103),
requires an explicit per-thread trigger (no default threshold), refuses unreliable
telemetry (`confidence === "low"`, `processed-total-only` → `pending`,
decideCompaction.ts:129–131), and gates on idle thread state. This is the strongest part
of the implementation.

**Issues.**
- `triggerReached` percent fallback divides `usedTokens / maxTokens` (decideCompaction.ts:62–67)
  — consistent with the snapshot's own `usedPercent` semantics, but worth an explicit
  test asserting parity between the two paths.
- `compactionRuntimeStatus.ts:23–24` hardcodes provider-specific constants
  (`PI_DEFAULT_RESERVE_TOKENS = 16_384`, `GROK_DEFAULT_TRIGGER_PERCENT = 85`) and
  provider-name switch cases (`providerAutoTrigger`, lines 28–45) inside a generic
  orchestration module. This is *not* a plan violation — these are descriptive
  reports of native provider behavior, not a Synara default policy — but the knowledge
  belongs in each adapter's capability descriptor (e.g. an optional
  `automatic.nativeTrigger` field), not in a name-keyed switch that will silently
  return `opaque` when a provider renames or a tenth provider arrives.
- `compactionPhaseFromControlState` reports `uncertain` as `retryable: true`
  (compactionRuntimeStatus.ts:59) while the persisted row records `retryable: false`
  for unknown outcomes (CompactionReactor.ts:381: `retryable: outcomeKnown`). The client
  is told an uncertain pass is retryable while the durable record says it is not —
  pick one semantic ("a *new* manual request is allowed" vs "this operation may be
  retried") and align both.

## 5. Adapters

- **CodexAdapter** (Layers/CodexAdapter.ts:1859–1873): thin, rejects instructions,
  returns `same-session` on start acknowledgement — see R3. The
  `manager.compactThread` catch path logs and swallows into a request error correctly.
- **ClaudeAdapter** (Layers/ClaudeAdapter.ts:5229–5247): no `compactThread`; descriptor
  honestly reports `manual: unsupported`, `automatic: native`. Correct — no fake
  operation invented.
- **GrokAdapter** (Layers/GrokAdapter.ts:1967–2046+): by far the most intricate —
  pre-lock replay waits, a synchronous claim (`claimGrokCompactionSlot`) that guards
  against restart-swapped contexts, `turnStarting` interleavings, in-flight duplicates,
  and active turns, plus quiet-window suppression of stale post-cancel events and
  abandoned-compaction cleanup. The invariant comments are excellent. Risks: this is
  ~10 interacting context flags on `GrokSessionContext` (GrokAdapter.ts:260–301);
  correctness depends on single-fiber synchronous sections that nothing enforces
  structurally. The plan constraint *not* to extract shared ACP compaction machinery
  before a second verified provider is respected — but when that second ACP provider
  lands, this file is the extraction candidate and should be extracted then, not
  copied.
- **OpenCodeAdapter** (Layers/OpenCodeAdapter.ts:3654–3681): `session.summarize`
  requires a parseable current model slug and fails with a clear validation error
  otherwise; descriptor comment admits event mapping is unverified against a live
  server (OpenCodeAdapter.ts:4038–4041) — the descriptor's truth-claim is ahead of its
  verification. Should be flagged as provisional in the descriptor or verified.
- **PiAdapter** (Layers/PiAdapter.ts:2526–2548): `context.runtime.session.compact()`
  with error wrapping; `compaction_start`/`compaction_end` mapped to
  `context_compaction` items with *random* item ids per event
  (PiAdapter.ts:1798, 1813), so start and end of one pass do not share an item id —
  any consumer correlating item lifecycles by id sees two half-open items.

## 6. Plan-constraint compliance

| Constraint | Status |
| --- | --- |
| No universal 85% default in generic code | **Compliant.** No trigger ⇒ no auto-compaction (CompactionReactor.ts:61–81). The `85` in compactionRuntimeStatus.ts:24 is a descriptive report of Grok's native behavior, not a Synara policy — but move it into the Grok descriptor (see §4). |
| Event-driven, no recurring polling loop | **Compliant.** Decisions run only on `thread.token-usage.updated`; no `setInterval`/`Schedule` loops in the compaction modules. |
| Never retry uncertain compaction operations | **Compliant** in the reactor (sticky `uncertain`, reconcile classifies instead of resuming, `retryable: outcomeKnown`). One inconsistency: the client-facing phase claims `retryable: true` (§4). |
| No shared ACP compaction machinery before a 2nd verified provider | **Compliant.** Grok's machinery is fully local to GrokAdapter.ts. |
| No global/provider/project/thread settings hierarchy in v1 | **Compliant.** Settings are thread-scoped only (`ProviderSetCompactionSettingsInput`). The flip side: they are also not persisted at all (R1). |
| Final principle: descriptors are truth-claims, no faked operations | **Mostly compliant.** Claude and Antigravity honestly report unsupported; OpenCode's descriptor is ahead of verification; Codex's `same-session` return is issued before the compaction actually completes (R3), which is a small truth gap in behavior rather than in the descriptor. |

## 7. Testability

Covered well: the pure reducer (6 tests), the decider (17 tests, every gate),
runtime-status derivation (8), and the reactor's happy paths, dedupe, deferral,
suspension, and reconciliation (30 tests in CompactionReactor.test.ts). The pure-core /
effectful-shell split is what makes this possible — keep it.

Not covered (and why it matters):
1. The R2 admission race — needs a test that starts two `request`s with different ids
   where `validate` is made slow; currently nothing pins the intended exclusivity.
2. R3/R4 interleavings — provider-native `item.started` arriving while a Synara request
   is `pending`, and `item.completed` arriving after a premature Synara `completed`.
3. Restart behavior of settings/suspension (R1) — untestable today because the state is
   memory-only; a persistence layer would make "settings survive restart" a one-line test.
4. `ProviderService.applyCompactionResult` rollover crash-ordering — the comment claims
   crash safety (ProviderService.ts:2187–2189) but no test kills the effect between the
   two upserts.
5. `compactionBehavior.test.ts` (6 tests) pins descriptor shapes only, not adapter
   compact behavior against a fake runtime for Codex/OpenCode/Pi (Grok has deeper
   coverage in GrokAdapter.test.ts).

## 8. Maintainability

- The "no compaction during an active turn" invariant is enforced in three layers with
  three data sources: reactor (projection `session.activeTurnId`,
  CompactionReactor.ts:456), ProviderService (binding payload + `listSessions`,
  ProviderService.ts:2276–2282), Grok (context flags, GrokAdapter.ts:2036–2046).
  Document which layer is authoritative; today a disagreement produces
  confusing validation errors rather than deferral.
- The instructions-unsupported rejection is copy-pasted in Codex/OpenCode/Pi adapters
  while ProviderService *already* centrally rejects instructions against capabilities
  (ProviderService.ts:2255–2265). The adapter-level copies are dead defense — either
  delete them or delete the central check, not both.
- Provider-name switches in `providerAutoTrigger` (compactionRuntimeStatus.ts:28–45)
  will not scale to 9+ providers; fold into descriptors.
- `outcomeKnownForError` (CompactionReactor.ts:99–110) classifies by error tag name —
  adding a new adapter error tag silently defaults to "outcome unknown" ⇒ `uncertain` ⇒
  sticky user-facing error state. An explicit `outcomeKnown` field on the error types
  (or an exhaustive switch that fails typecheck on new tags) would fail loudly instead.
- Two files named `CompactionReactor.ts` (Services interface + Layers-style impl under
  `orchestration/compaction/`) while every other reactor pairs `Services/` with the impl
  elsewhere; consistent but the duplicate basename hurts grep/jump-to-file ergonomics.

---

## Prioritized risk list

| # | Risk | Severity | Where |
| --- | --- | --- | --- |
| 1 | Thread compaction settings and suspensions are memory-only; every restart silently disables all Synara-managed auto-compaction | **High** | CompactionReactor.ts:121, 747–760 |
| 2 | Codex compaction settles `completed` on start-acknowledgement with stale `afterUsage`, then re-enters as a phantom provider-owned pass | **High** | CompactionReactor.ts:351–372, 584–601; CodexAdapter.ts:1859–1873; codexAppServerManager.ts:1561–1604 |
| 3 | Admission race: two requests with different ids can both pass the state check during async `validate` and double-compact | **Medium-High** | CompactionReactor.ts:431–472 |
| 4 | Provider-native start clobbers a queued pending request; the waiter still promotes on turn completion → back-to-back double compaction | **Medium** | CompactionReactor.ts:574–601; compactionState.ts:78–91 |
| 5 | Unbounded growth of `settledResults` and per-thread maps; uncached-null capability lookups amplify discovery failures on every usage event | **Medium** | CompactionReactor.ts:120–134, 148–167 |
| 6 | Manual compaction rejected while auto-suspended, removing the natural user recovery action | Medium-Low | CompactionReactor.ts:443–447 |
| 7 | `retryable` semantics disagree between client phase (`true`) and durable row (`false`) for uncertain outcomes | Low | compactionRuntimeStatus.ts:59; CompactionReactor.ts:381 |
| 8 | Analytics hardcodes `owner: "provider"` for all compactThread calls, contradicting durable rows | Low | ProviderService.ts:2292–2298 |
| 9 | Provider-specific constants and name-switches embedded in generic orchestration module | Low | compactionRuntimeStatus.ts:23–45 |
| 10 | OpenCode descriptor truth-claims unverified against a live server; Pi start/end items use uncorrelated random ids | Low | OpenCodeAdapter.ts:4038–4041; PiAdapter.ts:1797–1826 |
