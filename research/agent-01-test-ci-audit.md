# Per-PR Test and CI Audit — Compaction Stack (#55–#66)

Audit date: 2026-07-21. Sources: `git_view_pr` / `git_pr_checks` snapshots taken 2026-07-21 ~09:35 UTC, plus `git diff --merge-base` against each PR's base branch on a fresh clone.

## Summary Table

| PR | Title (short) | Branch → Base | Size | Merge status | Test files touched | CI (passed/failed/skipped) |
|----|---------------|---------------|------|--------------|--------------------|-----------------------------|
| #55 | PR 1: structured compaction capability contract | `devin/compaction-pr1-capabilities` → `main` | L | Mergeable | 5 | 8 / **1** / 1 |
| #56 | PR 3: compaction request/result contract | `devin/compaction-pr3-contract` → `devin/compaction-pr1-capabilities` | L | Mergeable | 3 | 9 / 0 / 1 |
| #57 | PR 0: provider compaction characterization tests | `devin/compaction-pr0-characterization` → `main` | L | Mergeable | 1 (new) | 9 / 0 / 1 |
| #58 | PR 10: Cursor/Droid/Antigravity verification | `devin/compaction-pr10-provider-expansion` → `devin/compaction-pr1-capabilities` | XL | Mergeable | 3 | 9 / 0 / 1 |
| #59 | PR 2: context occupancy vs cumulative tokens | `devin/compaction-pr2-token-usage` → `devin/compaction-pr1-capabilities` | L | Mergeable | 9 | 9 / 0 / 1 |
| #60 | PR 4: result-kind-aware ProviderService semantics | `devin/compaction-pr4-service-semantics` → `devin/compaction-pr3-contract` | L | Mergeable | 1 | 9 / 0 / 1 |
| #61 | PR 5: CompactionReactor + durable lifecycle | `devin/compaction-pr5-reactor` → `devin/compaction-pr3-contract` | XXL | Mergeable | 4 | 9 / 0 / 1 |
| #62 | PR 7: native auto-compaction observability | `devin/compaction-pr7-auto-observability` → `devin/compaction-integration` | L | Mergeable | 5 | 9 / 0 / 1 |
| #63 | PR 6: provider compaction lifecycle normalization | `devin/compaction-pr6-provider-normalization` → `devin/compaction-integration` | L | Mergeable | 6 | 9 / 0 / 1 |
| #64 | PR 8: compaction web UI | `devin/compaction-pr8-web-ui` → `devin/compaction-pr7-auto-observability` | L | Mergeable | 5 | 9 / 0 / 1 |
| #65 | PR 9: Synara-managed auto-compaction fallback | `devin/compaction-pr9-synara-auto` → `devin/compaction-pr8-web-ui` | L | Mergeable | 2 | 9 / 0 / 1 |
| #66 | Final integration | `devin/compaction-final-integration` → `main` | XXL | Mergeable | 26 (cumulative) | 9 / 0 / 1 |

All 12 PRs are open, authored by `devin-ai-integration[bot]`, labeled `vouch:trusted`, and mergeable with no conflicts. The one skipped CI job everywhere is "Sync PR size label definitions" (expected skip). Note #62 and #63 target an intermediate branch `devin/compaction-integration` that has no PR of its own.

The CI pipeline per PR: Collect PR targets, Prepare PR size config, Format/Lint/Typecheck/Test/Browser Test/Build, Windows Process Regression, Release Smoke, Socket Security (×2), Label PR, Label PR size.

## Recurring "pre-existing" test failures

Every PR description that reports a full `bun run test` run cites the same two failures and claims they reproduce on the unmodified base branch:

1. `apps/server/src/git/GitCore.test.ts` — "reuses an existing remote…" trailing-slash assertion (`origin-1` vs `origin`).
2. `apps/server/src/provider/acp/AcpSdkConformance.test.ts` — 90s timeout in "preserves early session updates and prompt update ordering" (described as environment-dependent/flaky; #56 notes it passes on re-run).

These claims are consistent across #55, #56, #57, #59, #60, #61, #63, #64, #66. I attempted to reproduce them locally on a clean `main` checkout in this audit environment, but `bun install` could not complete here (the `@effect/language-service` ts-patch prepare scripts were repeatedly SIGKILLed), so local reproduction was not possible in this session. GitHub CI's "Format, Lint, Typecheck, Test, Browser Test, Build" job is green on all 12 PRs, which suggests these two failures are local-environment artifacts (or are excluded/retried in CI). **They remain unfixed on `main` and should be triaged.**

---

## PR #55 — Compaction PR 1: structured provider compaction capability contract

- **Metadata:** `devin/compaction-pr1-capabilities` → `main`; size:L; mergeable, no conflicts. 22 files, +702/−78.
- **Tests added/modified:**
  - `packages/contracts/src/providerDiscovery.test.ts` — `describe("ProviderComposerCapabilities")`, `describe("supportsThreadCompactionFromCompaction")`: "decodes the structured compaction descriptor", "derives the legacy boolean from the manual compaction mode", "falls back to the legacy snapshot boolean when no descriptor is available".
  - `apps/server/src/provider/acp/AcpRuntimeModel.test.ts` — "omits the automatic-compaction claim from usage snapshots unless the caller supplies it".
  - `apps/server/src/provider/Layers/ProviderDiscoveryService.test.ts` — discovery fallback capabilities claim no compaction.
  - `apps/web/src/lib/contextWindow.test.ts` — `describe("deriveContextCompactionMeterCopy")`: provider-auto/unavailable/silent cases.
  - `apps/web/src/components/chat/ContextWindowMeter.test.tsx` — `describe("ContextWindowMeterDetails")`: descriptor-driven copy rendering.
- **Test commands (per description):** `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run test`.
- **Pass/fail:** full suite passes except the two recurring failures (reproduced on clean `main` per description).
- **CI status:** **8 passed, 1 failed, 1 skipped.** ❌ `Windows Process Regression` (job 88556174276). Log shows the failure is in `bun install --frozen-lockfile` on Windows: the `@synara/cli` prepare script (ts-patch of TypeScript for `@effect/language-service`) dies with `TypeError: Cannot read properties of undefined (reading 'ES2022')` — an install/toolchain failure, not a test regression. The same job **passes on all 11 other PRs**, including #56/#58/#59 which are stacked directly on this branch, so it is almost certainly flaky/infra. Needs a re-run to confirm.
- **Coverage gaps:** per-adapter `compaction` descriptors are asserted as declared data, not verified against live CLIs; ACP `usageCompactsAutomatically` claims (Grok true, Cursor/Droid false) rest on manual investigation, no automated probe; meter copy tested only at unit level.
- **Recommendations:** re-run the Windows job before merge; add a characterization link-check that descriptor claims stay consistent with `compactionBehavior.test.ts` (#57).

## PR #56 — feat: compaction request/result contract (PR 3)

- **Metadata:** `devin/compaction-pr3-contract` → `devin/compaction-pr1-capabilities`; size:L; mergeable. 16 files, +452/−92.
- **Tests:**
  - `packages/contracts/src/providerRuntime.test.ts` — `describe("ProviderCompactionRequest")` / `describe("ProviderCompactionResult")`: "decodes a manual request with instructions", "decodes a synara-auto request without optional fields", "decodes each result kind", "rejects unknown triggers", "requires a resume cursor for session rollover".
  - `apps/server/src/provider/Layers/ProviderService.test.ts` — result pass-through for all kinds, instruction rejection, instruction pass-through when supported.
  - `apps/server/src/provider/Layers/CodexAdapter.test.ts` — instruction-rejection / same-session behavior.
- **Commands:** `bun run fmt`, `bun run lint` (0 errors), `bun run typecheck` (8/8), targeted vitest suites, full `bun run test`.
- **Pass/fail:** targeted suites green; full suite only the two recurring failures.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** contract decode tests are schema-level only; no adapter other than Codex exercises the new request/result path in this PR.
- **Recommendations:** none blocking; adapter-level coverage arrives in #60/#63.

## PR #57 — test: characterize verified provider compaction behavior (compaction PR 0)

- **Metadata:** `devin/compaction-pr0-characterization` → `main`; size:L; mergeable. 1 new file, +318: `apps/server/src/provider/Layers/compactionBehavior.test.ts`.
- **Tests:** 8 new tests across `describe("codex composer capabilities")`, `describe("grok between-turn compaction heuristic")`, `describe("compaction characterization table consistency")` — e.g. "advertises native thread compaction from the app-server manager", "treats compaction- and summarization-shaped tool calls as context compaction", "does not classify ordinary tool calls as context compaction", "marks a provider compactable exactly when a manual mechanism exists".
- **Commands:** `bunx vitest run apps/server/src/provider/Layers apps/server/src/codexAppServerManager.test.ts` — **495 passed, 2 skipped** (includes the 8 new tests); full `bun run test` — the 2 recurring failures only.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** the characterization table encodes behavior verified manually against installed CLI versions; it will silently go stale as providers update their CLIs — nothing pins or re-verifies CLI versions.
- **Recommendations:** record the verified CLI versions inside the test file (or a fixture) and add a periodic live-CLI verification job (opt-in / scheduled, not per-PR).

## PR #58 — Compaction PR10: verify Cursor/Droid/Antigravity; add Droid ACP compaction probe

- **Metadata:** `devin/compaction-pr10-provider-expansion` → `devin/compaction-pr1-capabilities`; **size:XL**; mergeable. 7 files, +200/−55.
- **Tests:** `CursorAdapter.test.ts` ("stays unsupported because cursor-agent acp proves no compaction path"), `DroidAdapter.test.ts` (`describe("Droid compaction capability probe")`: "flips to supported only when ACP advertises compact/compress", "stays unsupported when ACP advertises no compaction command"), `AntigravityAdapter.test.ts` ("asserts compaction is unsupported until the synthetic design is approved").
- **Commands:** verification against installed CLIs (`cursor-agent 2026.07.17`, `droid 0.176.0`, `agy`) plus vitest suites per description.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** the Droid ACP probe is tested only against mocked ACP `initialize` responses — no automated live check that `droid` actually starts advertising compact/compress; Antigravity behavior is design-doc-gated with a placeholder assertion.
- **Recommendations:** add a fixture captured from a real `droid` ACP handshake so the probe parses real payload shapes, not hand-written mocks.

## PR #59 — feat(usage): separate context occupancy from cumulative processed tokens (PR 2)

- **Metadata:** `devin/compaction-pr2-token-usage` → `devin/compaction-pr1-capabilities`; size:L; mergeable. 21 files, +727/−42.
- **Tests (9 files):** `providerRuntime.test.ts` (`describe("nested V2 usage semantics")`: nested context/cumulative claims, unknown measurement label rejection, legacy flat payload compatibility), `claudeTokenUsage.test.ts`, `AcpRuntimeModel.test.ts` (ACP used/size → provider-estimated context claim), adapter tests (Claude, Codex, OpenCode, Pi incl. `normalizePiTokenUsage`), `contextWindow.test.ts` / `ContextWindowMeter.test.tsx` (low-confidence downgrade, clamping, merge behavior).
- **Commands:** `bun run fmt` / `lint` / `typecheck` / `test` (Bun 1.3.12 / Node 24); the 2 recurring failures verified against a clean base checkout.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** claim-confidence semantics tested with synthetic payloads only; no test feeding a recorded real provider usage stream end-to-end through merge + meter.
- **Recommendations:** add golden-file tests with captured real usage event sequences per provider.

## PR #60 — feat(server): result-kind-aware compaction semantics in ProviderService (PR 4)

- **Metadata:** `devin/compaction-pr4-service-semantics` → `devin/compaction-pr3-contract`; size:L; mergeable. 2 files, +438/−27.
- **Tests:** `ProviderService.test.ts` only, using `it.effect` (missed by naive grep): "does not schedule idle cleanup after same-session compaction", "keeps the binding active after same-session compaction and records analytics", "marks the binding stopped when compaction requires a runtime restart", "replaces the session identity and increments the generation on session-rollover", "rejects compaction requests with a stale lifecycle generation", "rejects compaction while a turn is active", "rejects compaction when the adapter lacks compactThread".
- **Commands/results:** `bun run test` (apps/server) — **2483 passed; ProviderService.test.ts 74/74**; only the 2 recurring failures.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** session-rollover identity replacement is tested against an in-memory adapter fake; no test that a real adapter survives rollover.
- **Recommendations:** covered downstream by #63's adapter lifecycle tests; fine as-is.

## PR #61 — feat(server): CompactionReactor and durable compaction lifecycle (PR 5)

- **Metadata:** `devin/compaction-pr5-reactor` → `devin/compaction-pr3-contract`; **size:XXL**; mergeable. 17 files, +1629/−4.
- **Tests (4 files):** `compaction/compactionState.test.ts` (`describe("compactionReducer")`: idle→pending→running→idle lifecycle, stale-generation rejection, duplicate request handling, uncertain outcomes, suspend-from-any-state), `compaction/CompactionReactor.test.ts` (manual request completion, defer behind active turn, startup reconciliation of persisted running op as uncertain, provider-native auto recorded as provider-owned), `Layers/OrchestrationReactor.test.ts`, `persistence/Migrations.test.ts` (migration 73, `ThreadCompactionOperations`).
- **Commands/results:** targeted new suites 14/14; full suite only the 2 recurring failures.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** biggest PR by insertions with no crash-recovery test beyond single "persisted running → uncertain" reconciliation; no property/fuzz test of the reducer despite it being a pure decider; no concurrency test of two reactors on the same DB.
- **Recommendations:** add property-based tests for `compactionReducer` transition invariants; add a kill-and-restart integration test around a running compaction.

## PR #62 — feat(compaction): native auto-compaction observability (PR 7)

- **Metadata:** `devin/compaction-pr7-auto-observability` → `devin/compaction-integration` (intermediate branch, no PR); size:L; mergeable. 12 files, +728/−35.
- **Tests (5 files, ~24 decls):** `providerRuntime.test.ts` (`describe("ThreadCompactionRuntimeStatus")`: decode provider-owned status, reject unknown owner, malformed payloads ignored), `compaction/compactionRuntimeStatus.test.ts` (`deriveThreadCompactionRuntimeStatus`, `compactionSummaryFromOperation`: per-provider triggers — Claude absolute, Grok percent, Pi reserve, opaque for Codex/OpenCode), `CompactionReactor.test.ts`, `contextWindow.test.ts` / `ContextWindowMeter.test.tsx` (runtime-status-first copy, trigger formatting).
- **Commands/results:** targeted `vitest run` on the 5 files — **69 tests, all passing**.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** full `bun run test` not cited in the description (only the targeted 69); activity-log derivation tested with synthetic logs.
- **Recommendations:** cite/run the full suite before merge to catch cross-suite regressions.

## PR #63 — PR 6: normalize compaction lifecycle across Codex, Claude, Grok, OpenCode/Kilo, and Pi

- **Metadata:** `devin/compaction-pr6-provider-normalization` → `devin/compaction-integration`; size:L; mergeable. 13 files, +763/−77.
- **Tests (6 files):** `ProviderRuntimeIngestion.test.ts` (compaction item lifecycle projected into activities, not compacted thread state), adapter tests for Claude, Codex, Grok (`describe("Grok native compaction trigger discovery")`: reads `intra_compaction` threshold from initialize `_meta`, omits invalid threshold), OpenCode, Pi (`describe("Pi compaction runtime events")`: compaction_start/compaction_end lifecycle, aborted → failed, usage refresh before completing).
- **Commands/results:** `bun run test` — **2508 passed**; the 2 recurring failures reproduce on `devin/compaction-integration`.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** lifecycle events driven by hand-built provider event fixtures; no recorded real event streams; Kilo covered only via the shared OpenCode factory.
- **Recommendations:** capture one real compaction event trace per provider as a fixture.

## PR #64 — feat(web): compaction web UI — status, manual trigger, settings, timeline (PR 8)

- **Metadata:** `devin/compaction-pr8-web-ui` → `devin/compaction-pr7-auto-observability`; size:L; mergeable. 21 files, +572/−43.
- **Tests (5 files):** `ContextWindowMeter.test.tsx` ("renders the in-progress spinner copy while compaction is running", "renders the error reason with a retry affordance when retryable", "hides the retry affordance when the failure is not retryable", "renders synara-managed auto compaction copy with the trigger", "renders the settings toggle only for synara-managed candidates"), `MessagesTimeline.test.tsx` ("renders a failed compaction entry"), `workLog.test.ts`, plus server-side `OrchestrationReactor.test.ts` / `ProviderRuntimeIngestion.test.ts`.
- **Commands/results:** `bun run test` — all web/contracts tests pass incl. new ones; only the 2 recurring server failures.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** **UI never exercised in a real browser** — jsdom/component tests only; PR checklist screenshot item is unchecked; no test of the `/compact` slash command toast path (`useComposerSlashCommands.ts`) or of the settings inputs' validation; no interaction test that "Compact now" actually round-trips `provider.compactThread` through the WS client.
- **Recommendations:** before merge, run the app and manually verify the meter states + settings section (or add a Playwright test in the existing Browser Test CI stage); add screenshots to the PR.

## PR #65 — feat(compaction): Synara-managed automatic compaction fallback (PR 9)

- **Metadata:** `devin/compaction-pr9-synara-auto` → `devin/compaction-pr8-web-ui`; size:L; mergeable. 5 files, +760/−11.
- **Tests (2 files, ~25 decls):** `compaction/decideCompaction.test.ts` (`describe("decideAutoCompaction")`: percent/remaining-tokens/absolute triggers, missing maxTokens, provider-reported usedPercent, low-confidence → pending, cooldown, disabled, non-idle, native-auto deference, unsupported provider, suspended), `CompactionReactor.test.ts` (`describe("synara-auto")`: auto-trigger from usage event, pending behind active turn, thrashing suspension, repeated-failure suspension + resume via settings, provider-state-uncertain suspension).
- **Commands/results:** vitest compaction suite — **47/47 pass**.
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** decider is well covered, but no end-to-end test where a real (or faked-at-the-adapter-boundary) provider stream drives usage → auto-trigger → compactThread → runtime status → UI; thrash/cooldown interplay tested only at the reducer level.
- **Recommendations:** add one integration test through ProviderService + CompactionReactor with a scripted adapter.

## PR #66 — feat: context compaction and auto-compaction architecture (final integration)

- **Metadata:** `devin/compaction-final-integration` → `main`; **size:XXL**; mergeable. 69 files, +6386/−247. `--no-ff` merge of the whole stack (#55–#65).
- **Tests:** cumulative — all 26 test files from the stack (contracts, adapters, orchestration/compaction, persistence migration 73, web components). Characterization suite `compactionBehavior.test.ts` passes unchanged against merged code (8/8), a good signal the merge preserved verified behavior.
- **Commands/results:** `bun run fmt` pass; `bun run lint` 0 errors (250 pre-existing warnings); `bun run typecheck` 8/8; `bun run test` — **2546 passed, 2 failed** (the two recurring pre-existing failures).
- **CI:** 9 passed, 0 failed, 1 skipped.
- **Coverage gaps:** inherits every gap above; as the branch that actually lands on `main`, it has no browser-level or live-provider validation of the combined feature.
- **Recommendations:** treat this as the gate: one manual (or Playwright) browser pass over compaction UI + one live compaction against a real provider (Claude or Codex) before merging.

---

## Top findings

1. **CI is green across the stack except one flaky-looking job:** #55's `Windows Process Regression` failed in `bun install` (ts-patch prepare script `TypeError: ... 'ES2022'` on Windows), not in any test; the identical job passes on all 11 other PRs, including PRs stacked on #55. Re-run it; if it fails again, the ts-patch step needs pinning/hardening on Windows.
2. **Two "pre-existing" local test failures are cited by nearly every PR** (`GitCore.test.ts` remote trailing-slash, `AcpSdkConformance.test.ts` 90s timeout) and are never fixed. CI is green, suggesting they are local-environment artifacts, but they add noise to every verification claim and should be triaged on `main` directly. (Local reproduction wasn't possible in this audit environment: `bun install` prepare scripts were repeatedly SIGKILLed.)
3. **No real-browser or live-provider verification anywhere in the stack.** All provider behavior is mocked/fixture-driven; the web UI (#64) is tested only via jsdom component tests, and its screenshot checklist item is unchecked. The final integration PR (#66) lands ~6.4k lines on `main` without a browser pass or a single live compaction run.
4. **Characterization suite (#57) is a strength but has a staleness risk:** it locks in behavior verified against specific installed CLI versions (`cursor-agent 2026.07.17`, `droid 0.176.0`, etc.) but nothing records or re-verifies those versions, so provider CLI updates can silently invalidate the table.
5. **Test depth is uneven relative to risk:** the two XXL PRs are the riskiest — #61 (reactor + persistence, +1629 lines) has no crash-recovery test beyond one reconciliation case and no property tests on the pure reducer; #66 inherits everything. Meanwhile #62 cites only a 69-test targeted run, not a full-suite run, in its verification.

## Cross-cutting recommendations before merging the stack

- Re-run #55's Windows job; pin/harden the ts-patch prepare step if it recurs.
- Triage the two recurring local failures on `main` (fix GitCore's trailing-slash remote reuse; raise or stabilize the AcpSdkConformance timeout).
- Add a Playwright pass (the CI job already has a "Browser Test" stage) covering: context meter compaction states, "Compact now", settings toggle/threshold/cooldown, retry affordance.
- Run one live manual `/compact` and one Synara-auto trigger against a real provider before merging #66.
- Record verified provider CLI versions in `compactionBehavior.test.ts` and schedule periodic re-verification.
- Add property-based tests for `compactionReducer` and a kill/restart integration test for `CompactionReactor`.
