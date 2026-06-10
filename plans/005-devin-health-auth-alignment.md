# Plan 005: Align Devin health-check auth with the runtime auth contract (WINDSURF_API_KEY)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat f572445..HEAD -- apps/server/src/provider/Layers/ProviderHealth.ts apps/server/src/provider/acp/DevinAcpSupport.ts`
> If in-scope files changed, compare the "Current state" excerpts; on a
> mismatch, STOP. Plan 003 modifies DevinAcpSupport.ts (adds clientCapabilities)
> — that drift is expected and fine.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f572445`, 2026-06-10

## Why this matters

Devin runtime auth (used when actually starting an ACP session) accepts TWO
paths: the Windsurf API key from the `WINDSURF_API_KEY` env var, or a cached
`devin auth login` token (see `resolveDevinAcpAuthMethodId`). But the health
check only probes `devin auth status`. A user authenticated purely via
`WINDSURF_API_KEY` gets a red "Devin CLI is not authenticated. Run `devin auth
login`" health status while their sessions actually work — the health surface
and the runtime auth contract have drifted, which the decision matrix for PR
#145 explicitly flags ("Align them behind one Devin support contract"). Fix:
health must consult the same env-key signal the runtime uses.

## Current state

- `apps/server/src/provider/acp/DevinAcpSupport.ts:31-54` — the runtime auth contract:

```ts
export const DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID = "windsurf-api-key";
export const DEVIN_CACHED_TOKEN_AUTH_METHOD_IDS = ["cached_token", "devin", "devin_login"] as const;
export const DEVIN_API_KEY_ENV_KEYS = ["WINDSURF_API_KEY"] as const;
// ...
function hasDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEVIN_API_KEY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}
```

`hasDevinApiKeyEnv` is currently module-private; `resolveDevinAcpAuthMethodId`
(lines 56-81) prefers `windsurf-api-key`, falls back to cached-token methods,
and uses `hasDevinApiKeyEnv()` only to tailor its error message.

- `apps/server/src/provider/Layers/ProviderHealth.ts:1634-1701` —
  `parseDevinAuthStatusFromOutput(result)` classifies `devin auth status` output:
  "not logged in"/"not authenticated"/"login required"/"run devin auth login"
  → `{ status: "error", authStatus: "unauthenticated", message: "... Run `devin auth login` ..." }`.
  JSON output with an auth boolean → ready/error; exit 0 fallback → ready;
  otherwise warning/unknown.

- `ProviderHealth.ts:1703-1800` — `makeCheckDevinProviderStatus(binaryPath?)`:
  `devin --version` probe, then `devin auth status` probe, then
  `parseDevinAuthStatusFromOutput`. The env signal is never consulted.

- Existing tests: `apps/server/src/provider/Layers/ProviderHealth.test.ts` —
  find the Devin block with `grep -n "Devin\|parseDevinAuthStatusFromOutput" apps/server/src/provider/Layers/ProviderHealth.test.ts`
  and follow its fixture style exactly.

- Env-var test handling exemplar: `DevinAdapter.test.ts:94-109` saves/restores
  `process.env.WINDSURF_API_KEY` around the assertion.

## Commands you will need

| Purpose           | Command (repo root `/tmp/synara-pr`)                                     | Expected on success |
| ----------------- | ------------------------------------------------------------------------ | ------------------- |
| Install           | `bun install`                                                            | exit 0              |
| Health tests      | `bunx vitest run apps/server/src/provider/Layers/ProviderHealth.test.ts` | all pass            |
| Support tests     | `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts`   | all pass            |
| Final gate (once) | `bun fmt && bun lint && bun typecheck`                                   | all exit 0          |

NEVER run `bun test`; always `bun run test` / `bunx vitest run <file>`.

## Scope

**In scope** (only files to modify):

- `apps/server/src/provider/acp/DevinAcpSupport.ts` (export the env predicate)
- `apps/server/src/provider/Layers/ProviderHealth.ts` (Devin section only)
- `apps/server/src/provider/Layers/ProviderHealth.test.ts`

**Out of scope** (do NOT touch):

- Other providers' health checks in `ProviderHealth.ts`.
- The runtime auth resolution order in `resolveDevinAcpAuthMethodId` — it is
  correct and locked (headless-first; API key preferred when advertised).
- Any browser/out-of-band auth flow — out of scope per locked decision 11.

## Git workflow

- Branch: current PR branch `devin-acp-provider-v2`.
- One or two commits, imperative style (e.g. `Align Devin health auth with WINDSURF_API_KEY runtime auth`).
- Do NOT push unless instructed.

## Steps

### Step 1: Export the env predicate from `DevinAcpSupport.ts`

Change `function hasDevinApiKeyEnv` (line 52) to
`export function hasDevinApiKeyEnv`. No behavior change.

**Verify**: `grep -n "export function hasDevinApiKeyEnv" apps/server/src/provider/acp/DevinAcpSupport.ts` → 1 match.

### Step 2: Consult the env signal in the Devin health classification

In `ProviderHealth.ts`, import `hasDevinApiKeyEnv` from
`../acp/DevinAcpSupport.ts` and thread an env-aware branch into the Devin path.
Smallest honest change: give `parseDevinAuthStatusFromOutput` an optional second
parameter `options?: { readonly hasApiKeyEnv?: boolean }` and, in the
"unauthenticated" branch (lines 1641-1654) and the `parsedAuth.auth === false`
branch (lines 1674-1680), return instead:

```ts
if (options?.hasApiKeyEnv) {
  return {
    status: "ready",
    authStatus: "authenticated",
    message: "Devin CLI login not detected; using WINDSURF_API_KEY for authentication.",
  };
}
```

Then pass the live value at the single call site (line 1789):
`parseDevinAuthStatusFromOutput(authProbe.success.value, { hasApiKeyEnv: hasDevinApiKeyEnv() })`.

Check `ServerProviderStatusState` / `ServerProviderAuthStatus` allow
`"ready"`/`"authenticated"` with a `message` (other branches at 1671-1691 show
ready without message; the type at the top of the function declares `message?` —
so this is fine). Keep the pure function pure: the env read happens at the call
site, not inside the parser.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/ProviderHealth.test.ts` → existing tests pass (they call the parser without the new optional arg).

### Step 3: Tests

In `ProviderHealth.test.ts`, following the existing Devin fixture style:

1. "treats WINDSURF_API_KEY as authenticated when devin auth status reports logged out" —
   `parseDevinAuthStatusFromOutput({ stdout: "Not logged in. Run `devin auth login`.", stderr: "", code: 1 }, { hasApiKeyEnv: true })`
   → `{ status: "ready", authStatus: "authenticated", message: /WINDSURF_API_KEY/ }`.
   (Match the real `CommandResult` fixture shape used by neighboring tests.)
2. "still reports unauthenticated without the API key env" — same input,
   `{ hasApiKeyEnv: false }` → `status: "error"`, `authStatus: "unauthenticated"`.
3. "JSON auth=false with API key env present is still authenticated-via-key" —
   stdout `{"auth": false}` + `hasApiKeyEnv: true` → ready/authenticated.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/ProviderHealth.test.ts` → all pass, ≥3 new tests.

### Step 4: Final verification pass

Once each, as separate final verification passes:

- `bunx vitest run apps/server/src/provider/**/*.test.ts`
- `bun fmt && bun lint && bun typecheck`

**Verify**: all exit 0.

## Test plan

Step 3. Pattern exemplar: existing Devin tests in `ProviderHealth.test.ts`
(pure-parser fixtures; no child-process spawning needed for the new cases).

## Done criteria

- [ ] `hasDevinApiKeyEnv` exported from DevinAcpSupport and imported by ProviderHealth
- [ ] `parseDevinAuthStatusFromOutput` honors `hasApiKeyEnv` in both unauthenticated branches
- [ ] `bunx vitest run apps/server/src/provider/Layers/ProviderHealth.test.ts` → all pass with ≥3 new tests
- [ ] `bun fmt && bun lint && bun typecheck` → exit 0 (single final pass)
- [ ] `git status` clean outside in-scope list; `plans/README.md` updated

## STOP conditions

- The cited ProviderHealth lines don't match (drift since `f572445`).
- `ServerProviderStatus` cannot carry a message on a ready status (schema
  rejects it) — report rather than dropping the message silently.
- You find the health check is also used to gate session start anywhere
  (grep `makeCheckDevinProviderStatus` consumers) and the new ready-with-key
  status would change session-start behavior beyond presentation.

## Maintenance notes

- If Devin later adds more env-based auth keys, extend
  `DEVIN_API_KEY_ENV_KEYS` in DevinAcpSupport — health inherits it automatically
  via `hasDevinApiKeyEnv`.
- The runtime can still fail auth when the agent doesn't advertise
  `windsurf-api-key` (see `resolveDevinAcpAuthMethodId`'s error) even though
  health is green-via-key; that residual gap is acceptable and surfaced at
  session start. Reviewer should confirm the message copy is presentation-only
  (server truth owns the flags).
