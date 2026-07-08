# Devin ACP PR #268 — Ship-Ready Polish Plan

**Date:** 2026-07-09  
**PR:** https://github.com/Emanuele-web04/synara/pull/268  
**Branch:** `devin-acp-provider` → `upstream/main`  
**Goal:** Make this PR reviewable and merge-safe **ASAP**, without shipping premature product risk.  
**User decisions (locked):**

1. **Aggressiveness:** Ship-ready ASAP — no big architecture rewrite.
2. **Shared ACP:** Harden + add high-ROI tests in this PR.
3. **History:** Squash into **2–4 logical commits**, force-push tip.

---

## Design

### Problem

PR #268 is a full Devin ACP provider integration labeled **size:XXL** (~127 files, ~11k+/~760−). It is already open, currently **CONFLICTING** with `upstream/main`, **vouch:unvouched**, with ~46 fixup commits and **~1.1k lines of uncommitted plan-mode polish** still local.

The maintainer **does not have a Devin subscription**. CI runs unit tests + (non-blocking) browser tests — **not** live Devin. Unit tests can pass while Cursor or Devin sessions still misbehave if shared ACP seams are wrong.

You cannot manually exercise the full settings/model surface. The plan must define **what confidence means** for merge: shared-path safety + critical Devin path + honest gaps.

### Constraints

- **Correctness over convenience** (repo Agents.md). Shared Cursor/ACP regressions are merge-blockers.
- **Ponytail ultra:** delete noise, do not invent abstractions; no “AcpAdapter base class” rewrite.
- **Agents.md:** one final verification bundle (`fmt` + `lint` + `typecheck` + `bun run test`); never `bun test`.
- **No live CLI in CI** (no secrets/sub; Devin not on runners).
- Browser suite in CI is **`continue-on-error: true`** — do not bank merge confidence on Playwright.
- Keep Devin behavior that already works (plan settle, Working clear, mode mapping, variant matrix).

### Architecture (what this PR really is)

```
UI / settings / model picker
        │
        ▼
contracts (ProviderKind "devin", DevinModelOptions, settings)
        │
        ▼
ProviderService + ProviderAdapterRegistry
        │
        ▼
DevinAdapter  ──►  AcpSessionRuntime  ──►  effect-acp protocol  ──►  `devin acp` child
   │                      │                        │
   │                      │                        └── UUID string id remap (shared)
   │                      └── spawn.env = full child env; authPolicy on-demand
   ├── DevinModeMapper / Catalog / SlugParser / Elicitation / AcpSupport
   └── plan capture (tags + Exit plan), planCaptureSettled freeze
```

**Deep modules (earn their keep):** `DevinAdapter`, variant matrix, elicitation validation, effect-acp UUID remap, env allowlist, checkpoint `supportsRollback` gate.

**Shallow but required registration:** service token, provider order, settings binary path, icons, composer registry entry.

**Do not deepen in this PR:** unify Cursor/Devin/Grok into one base adapter; unify all providers’ plan mode; grow static model catalogs as source of truth.

### Blast radius (worst case after merge)

| Tier  | Surface                                        | Worst case                                              | Who hits it                  |
| ----- | ---------------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| **0** | `effect-acp` UUID remap                        | Hung/crashed RPC, mismatched request IDs                | All ACP (Cursor, Devin, …)   |
| **0** | `AcpSessionRuntime` env = complete child env   | Cursor/Devin cannot start (PATH/HOME/auth)              | Cursor + Devin               |
| **0** | Cursor `buildAcpSpawnEnv` allowlist            | Cursor fails for some users (proxy/SSL/env)             | Cursor                       |
| **0** | Idle watchdog progress-only reset              | False timeout **or** stuck Working                      | Cursor + Devin (+ Grok path) |
| **1** | CheckpointReactor `supportsRollback === false` | Checkpoint restore blocked wrongly / or allowed wrongly | Any provider with wrong caps |
| **1** | Optional user-input answers                    | Submit fails or skips required                          | All elicitation UIs          |
| **1** | ProviderHealth CLI probe extract               | Wrong health status in Settings                         | Grok/OpenCode/etc.           |
| **2** | Devin-only adapter/plan/models                 | Plan loops, wrong model slug, auth loops                | Devin users only             |
| **3** | Drive-by lint (SoccerBall, toSorted, …)        | Near-zero product risk; high review noise               | —                            |

### What tests already prove

| Area                                                                  | Strength                            |
| --------------------------------------------------------------------- | ----------------------------------- |
| effect-acp UUID remap                                                 | **Strong** (real protocol path)     |
| Idle watchdog tags                                                    | **Strong**                          |
| DevinAdapter mock runtime (start/stop/plan/Working/modes/elicitation) | **Strong mock-only** — gold harness |
| Mode/slug/catalog/display pure tests                                  | **Strong**                          |
| Devin spawn env allowlist                                             | **Strong** for Devin prefixes       |
| Cursor spawn env secrets/PATH                                         | **Weak**                            |
| CheckpointReactor `supportsRollback: false`                           | **Missing**                         |
| Live Devin / Playwright Devin chat                                    | **None in CI**                      |

Uncommitted local work already extends plan capture, Exit plan, `planCaptureSettled`, tag stripping, timeline fold — **must land** before claiming plan is fixed.

### What we will _not_ do (YAGNI for this polish)

- AcpAdapter base-class refactor
- Halving `DevinAdapter.test.ts` mass (kills confidence for little review gain)
- Full model-layer collapse (shared display + parser + catalog stay)
- Live Devin in CI / new Playwright “send message to Devin”
- Working handoff flicker polish (micro-gap; post-merge ok)
- Subagents / MCP / skills / real session rollback
- Shipping `devin-acp-test-shots/` or hardcoded local QA scripts into the PR

### Success criteria (ready to ping maintainer)

1. Uncommitted plan + Working polish is **committed and on the tip**.
2. Drive-by noise files **reverted** or justified in one line in the PR body.
3. **P0 tests** green (shared gate + hardened plan/mode if gaps remain).
4. Rebased onto current `upstream/main` (not CONFLICTING).
5. History is **2–4 logical commits**.
6. PR body rewritten (shared risk, test plan, manual smoke, known limits).
7. Local: `bun fmt` + `bun lint` + `bun typecheck` + `bun run test` pass once.
8. Author manual smoke (Devin matrix + Cursor smoke) completed or honestly partial with notes.
9. You can message: “ready for review” with a short maintainer checklist (no Devin sub required for shared paths).

### Approach (ordered)

**Phase A — Land product truth**  
Commit the local plan-mode / Exit-plan / tag-strip / timeline work. This is the real Devin UX fix; the PR without it is incomplete.

**Phase B — Reduce review surface**  
Restore drive-by files to `upstream/main` versions where the only change is lint/toSorted/unused import. Keep intentional shared product changes (Cursor env, protocol, watchdog, checkpoint, pendingUserInput).

Optional micro-deletes only if zero risk: dead `isDevinPlanModeId`, 1-line web re-export of `devinModelVariants` (import shared directly). **Skip** large test deletions and model-stack rewrites.

**Phase C — Harden shared seams with tests (P0)**  
Fill the holes that protect non-Devin users and the plan path:

1. `CheckpointReactor`: `supportsRollback: false` blocks rewind; current-turn no-op still ok.
2. `acpSpawnEnv` + Cursor spawn: PATH/HOME kept; unrelated secrets dropped; browserless keys present.
3. DevinAdapter (only if not already covered by uncommitted tests): after plan capture, ordinary tools cancelled; plan+full-access never silent auto-approve; sequential bypass→ask mode apply.

P1 only if time after P0 green: model trait → full slug on mock `setModel`; optional elicitation field omit.

**Phase D — Git hygiene**  
`fetch upstream` + rebase onto `upstream/main`. Resolve conflicts carefully (migrations, ProviderHealth, release workflow). Interactive rebase / soft-reset into **2–4 commits**, e.g.:

1. `feat(devin): ACP provider, models, modes, settings, UI wiring`
2. `fix(acp): UUID request ids, spawn env allowlist, idle progress, rollback gate`
3. `fix(devin): plan capture settle, Working clear, Exit plan, tag strip`
4. `test: Devin adapter + shared ACP/checkpoint coverage`

(Or 2 commits: feat+shared / fix+test — still fine.)

Force-push to `origin/devin-acp-provider` only after rebase is clean.

**Phase E — PR presentation**  
Rewrite body: summary, architecture one-liner, shared blast radius, Devin capabilities/gaps, test plan (CI + unit + manual author/maintainer), known limitations, screenshots only if already local (do not commit shot tree).

**Phase F — Verify + smoke**  
One verification bundle. Author: Devin critical matrix + Cursor smoke. Maintainer: CI blocking steps + Cursor optional + read P0 tests.

### Manual smoke (author — Devin sub)

1. Settings health / binary blank
2. New thread, short reply, Working clears
3. Full-access tool turn
4. Approval-required after bypass (not stuck)
5. Plan under full-access: plan card, no tool storm, no re-plan loop
6. Interrupt clears Working
7. One model/trait switch
8. Checkpoint/edit-resend gated or clear error

### Manual smoke (maintainer — no Devin)

1. CI quality job green (fmt/lint/typecheck/test/build); browser may be noisy
2. Cursor new thread + tool + finish (shared ACP)
3. One non-ACP provider still sends
4. Checkpoint restore still works on Codex/Claude

### PR body skeleton (use in Phase E)

```markdown
## Summary

Devin as a first-class ACP provider: session lifecycle, model variant matrix,
mode mapping (plan/ask/bypass), elicitation, attachments, compact via /compact,
rollback fail-closed (ACP has no session revert).

## Shared ACP changes (review these even without Devin)

- effect-acp: UUID/string JSON-RPC ids (prevents RpcServer crash)
- AcpSessionRuntime: spawn.env is complete child env; on-demand auth for Devin
- Cursor/Devin: env allowlist via buildAcpSpawnEnv
- Idle watchdog: only real turn progress resets the timer
- CheckpointReactor: block rewind when supportsRollback === false
- Optional user-input questions can be omitted

## Devin plan mode

- Tag-based proposed plans (+ Exit plan mode tool)
- planCaptureSettled freezes re-plan loops
- Plan wins over Bypass: no silent tool auto-approve on plan turns

## Test plan

- [x] bun fmt / lint / typecheck / test (local)
- [x] CI quality job
- [x] Unit: DevinAdapter mock runtime, mode/catalog/slug, elicitation
- [x] Unit: effect-acp UUID, idle watchdog, spawn env, CheckpointReactor gate
- [ ] Author live Devin smoke (matrix above)
- [ ] Maintainer Cursor smoke (no Devin required)

## Known limitations

- No subagents/MCP/skills (ACP gap; ponytail comments)
- No session rollback (UI gated + checkpoint fail-closed)
- Live model list depends on Devin account; static fallback is cold-start only
- Browser CI is non-blocking upstream

## Maintainer note

You do not need a Devin subscription to review shared ACP risk.
Devin live path was author-smoked; unit harness covers plan/Working/modes.
```

---

## PR Plan

### PR 1: Land uncommitted plan polish + strip drive-bys

**Goal:** Product truth on tip; remove review noise that is not Devin.

**Files (expected):**

- Keep/modify: `DevinAdapter.ts`, `DevinAdapter.test.ts`, `planMode.ts`, `proposedPlan.ts`, `session-logic.ts`, `MessagesTimeline.logic.ts` + tests
- Revert drive-bys toward upstream when only lint/toSorted/unused: e.g. `SoccerBall.tsx`, `ThemePackEditor.tsx`, `browserManager.ts`, `auth/http.ts`, `codexAppServerManager.ts` (import-only), `GitCore.ts` `_cwd`, `keybindings.ts`, `theme.logic.ts`, `terminalHistory.test.ts`, similar
- Do **not** revert: Cursor/Devin ACP shared, effect-acp, CheckpointReactor product gate, pendingUserInput optional, ProviderHealth Devin wiring

**Steps:**

- [ ] Review `git diff` of uncommitted plan files; ensure tests match behavior
- [ ] Commit plan polish as a logical unit (will be squashed later)
- [ ] Identify drive-by files: `git diff upstream/main...HEAD --stat` vs intentional list
- [ ] Restore pure noise files from `upstream/main`
- [ ] Confirm QA dirs (`devin-acp-test-shots/`, local `.synara-*`) stay untracked

**Acceptance:**

- [ ] Working tree has only intentional Devin/shared product changes vs upstream
- [ ] Plan freeze / Exit plan / tag strip present on tip

---

### PR 2: P0 tests + tiny dead-code deletes

**Goal:** Shared-path and plan confidence without live CLI.

**Files:**

- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- `apps/server/src/provider/acp/acpSpawnEnv.test.ts` (new)
- `apps/server/src/provider/acp/CursorAcpSupport.test.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts` (only if gaps remain after plan commit)
- Optional: delete dead `isDevinPlanModeId`; replace web `devinModelVariants` re-export with shared import

**Steps:**

- [ ] CheckpointReactor: supportsRollback false blocks rewind; current turn no-op ok
- [ ] `buildAcpSpawnEnv`: PATH/HOME kept; secrets dropped; prefixes + extraEnv
- [ ] Cursor spawn: PATH/HOME present; secret not passed; browserless env set
- [ ] DevinAdapter: plan+full-access + post-capture tool cancel if not already asserted
- [ ] Skip P1 model/elicitation extras unless P0 is trivial leftover time

**Acceptance:**

- [ ] New/extended tests fail if gate/env/plan regressions reintroduced
- [ ] No new dependencies; mock-only

---

### PR 3: Rebase, squash history, force-push

**Goal:** Linear, readable history on current main.

**Steps:**

- [ ] `git fetch upstream`
- [ ] `git rebase upstream/main` (or rebase onto merge-base after drive-by cleanup)
- [ ] Resolve conflicts (migrations, ProviderHealth, workflows) without reintroducing drive-bys
- [ ] Squash to 2–4 commits with clear messages (feat / shared ACP / plan+Working / tests)
- [ ] Force-push `origin/devin-acp-provider` (user-confirmed)

**Acceptance:**

- [ ] `gh pr view 268` shows mergeable (not CONFLICTING)
- [ ] Commit list is short and intentional

---

### PR 4: Verification, PR body, maintainer handoff

**Goal:** One verification pass + presentation so review can start.

**Steps:**

- [ ] Run once: `bun fmt` && `bun lint` && `bun typecheck` && `bun run test`
- [ ] Optional: `bun run --cwd apps/web test:browser` for signal (non-blocking upstream)
- [ ] Author Devin smoke matrix (document partial results if any skip)
- [ ] Author Cursor smoke (shared ACP)
- [ ] Rewrite PR #268 body using skeleton above
- [ ] Update test-plan checkboxes honestly
- [ ] Comment: ready for review + maintainer checklist (CI + Cursor, no Devin required)

**Acceptance:**

- [ ] Verification green
- [ ] PR description matches tip
- [ ] You are willing to tell the maintainer “review now”

---

## Execution order (single track — not parallel stacks)

1. PR1 (land + strip)
2. PR2 (tests)
3. PR3 (rebase + squash)
4. PR4 (verify + body + handoff)

This is one branch / one open PR; “PR 1–4” are **phases**, not four GitHub PRs.

---

## Effort estimate

| Phase                       | Effort                   |
| --------------------------- | ------------------------ |
| Land plan + strip drive-bys | S–M                      |
| P0 tests                    | S–M                      |
| Rebase + squash             | S (M if nasty conflicts) |
| Verify + body + smokes      | M                        |

**Total:** roughly one focused session to “ready for review,” plus author live smokes.

---

## Out of scope (post-merge / follow-ups)

- Working sendBusy→running micro-flicker polish
- Catalog/picker cosmetics
- DevinAdapter file split for readability
- Model display map thinning to private codenames only
- Concurrent UUID stress tests (P2)
- Full CursorAdapter mock suite

---

## Decision log

| Decision   | Choice                  | Why                                                      |
| ---------- | ----------------------- | -------------------------------------------------------- |
| Scope      | Ship-ready ASAP         | User priority; avoid premature merge _and_ avoid rewrite |
| Shared ACP | Harden + test in PR     | Maintainer has no Devin; Cursor must stay safe           |
| History    | 2–4 commits             | Reviewable without 46 fixups                             |
| Tests      | P0 unit/mock only in CI | No Devin on CI; browser non-blocking                     |
| Refactors  | Micro-delete only       | Ponytail; depth already OK at seams                      |
| Live       | Author smoke matrix     | Honest coverage where unit lies                          |
