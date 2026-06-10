# REVIEW — final merge-readiness review of the Devin ACP provider work

You are a senior reviewer (frontier model). All implementation was done by
smaller executor agents working from the plans in this directory. Your job is
to review everything they produced like a tech lead before merge: independently
re-verify, judge against the locked architecture, and render a verdict. You do
NOT implement fixes — you report findings.

## Context (self-contained — assume no prior session knowledge)

- Repo: Synara — a multi-provider web GUI for coding agents. Bun + TypeScript +
  Effect-TS monorepo: `apps/server` (WebSocket server, provider adapters),
  `apps/web` (React), `packages/contracts` (schema-only), `packages/shared`,
  `packages/effect-acp` (vendored ACP client).
- Branch under review: `devin-acp-provider-v2` — PR #145, adding Devin
  (`devin acp` CLI) as a provider via the shared ACP runtime
  (`apps/server/src/provider/acp/AcpSessionRuntime.ts`).
- Baseline for the plan work: commit `f572445`. The executor work is every
  commit after that. Get the diff:
  `git log --oneline f572445..HEAD` and `git diff f572445..HEAD`.
- Plans executed: `plans/001-*.md` through `plans/005-*.md`, status tracked in
  `plans/README.md`. Each plan has machine-checkable "Done criteria" and
  explicit scope boundaries.

## Locked architecture decisions (the review rubric — do not re-litigate)

1. Devin is a first-class `ProviderKind` with a dedicated adapter — NOT a
   generic custom ACP provider.
2. Discovery is runtime-first: model list, modes, and slash commands come from
   the live ACP session when possible.
3. Static data exists only as explicit, narrow, concern-specific fallback
   modules with provenance comments (`DevinModelCatalog`, `DevinModeMapper`
   alias heuristics). No duplicated model lists across server/web/tests.
4. Server truth owns capability flags; the web app is presentation-only.
5. No capability claimed in UI that the adapter cannot actually provide; no
   silent fallback paths.
6. Rollback/revert stays unsupported (explicit error) until native Devin
   revert/fork semantics are mapped. Thread compaction unsupported.
7. Structured user-input: Devin participates via ACP form elicitation.
   URL-mode elicitation and browser/out-of-band auth are OUT of scope and must
   be declined, not implemented.
8. Auth is headless-first: `WINDSURF_API_KEY` env or cached `devin auth login`
   token.

## Review procedure

### Pass 1 — status and claims audit

1. Read `plans/README.md`. For every plan marked DONE, open the plan file and
   re-run its **Done criteria** commands yourself (greps, test runs). Do not
   trust the executor's report. For any BLOCKED plan, assess whether the block
   reason is real.
2. Verification commands (repo root):
   - `bun install`
   - `bunx vitest run apps/server/src/provider/**/*.test.ts packages/shared/src/**/*.test.ts packages/contracts/src/**/*.test.ts`
     (NEVER `bun test` — wrong runner; the root `bun run test` script does not
     forward path arguments to Vitest)
   - `bun fmt && bun lint && bun typecheck` (run once)

### Pass 2 — diff review (read every changed file)

`git diff f572445..HEAD --stat` then read each change. Judge:

- **Scope discipline**: any file modified outside the union of the plans'
  "In scope" lists? Any behavior change not called for by a plan?
- **Single source of truth**: grep for resurrected duplication —
  `grep -rn "swe-1-6\|claude-opus-4-8" apps/server packages | grep -v test`
  should show the contracts catalog + derivations, not parallel hardcoded lists.
- **Effect-TS hygiene**: no leaked fibers/deferreds (pending user-input map is
  settled on stopSession AND interruptTurn), no `Effect.runPromise` in adapter
  code, errors mapped to tagged `ProviderAdapter*` errors, scopes closed.
- **Shared-runtime blast radius**: changes to `AcpRuntimeModel.ts` /
  `AcpSessionRuntime.ts` (plan 004) must be additive. Confirm Cursor and Grok
  adapter tests pass unchanged and their event loops handle (or safely ignore)
  the new `AvailableCommandsUpdated` tag.
- **Capability honesty**: `getComposerCapabilities` in
  `apps/server/src/provider/Layers/DevinAdapter.ts` must match implemented
  reality: slash-command discovery true only if `listCommands` works; model
  list true (runtime-first listModels); compaction/rollback false/unsupported.
- **Contract safety**: any change to `packages/contracts` must be
  backward-compatible (new fields optional; nothing removed or narrowed).
- **Test quality**: new tests assert behavior (events published, deferreds
  resolved, fallbacks chosen), not implementation details; env-var tests
  save/restore `process.env`; no test pins live Devin command/model names on
  runtime-discovery paths.

### Pass 3 — adversarial pass (think like a breaker)

- Elicitation: what happens if Devin sends a form elicitation while no turn is
  active? Two concurrent elicitations? An elicitation answered after
  stopSession? Decline/cancel mid-turn — can it wedge `activeTurnId`?
- Discovery: listModels/listCommands racing session shutdown (`ctx.stopped`
  guards); empty/garbage config options from the runtime.
- Resume: does the resume cursor (`schemaVersion: 1`) survive all new paths?
- Health: `WINDSURF_API_KEY` set but agent doesn't advertise the auth method —
  is the user-facing story coherent (health green, session-start error message
  actionable)?

## Verdict format

Produce:

1. **Verdict**: MERGE-READY | MERGE-READY WITH NITS | NOT READY (blocking items).
2. **Findings table**: | # | Severity (blocker/major/minor/nit) | File:line | Issue | Suggested fix |
3. **Done-criteria re-verification table**: plan × criterion × pass/fail.
4. **Decision-compliance checklist**: the 8 locked decisions above, each
   PASS/FAIL with one line of evidence.
5. **What you did not review** (be explicit — e.g. live `devin acp` behavior
   against a real account, web UI rendering).

Do not fix anything yourself. If you find blockers, write them up precisely
enough that an executor agent (or the human) can act on each one directly.
