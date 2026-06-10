# Plan 001: Single source of truth for Devin models — extract DevinModelCatalog and make listModels runtime-first

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat f572445..HEAD -- apps/server/src/provider/Layers/DevinAdapter.ts apps/server/src/provider/acp/ packages/contracts/src/model.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `f572445`, 2026-06-10

## Why this matters

The Devin provider PR currently keeps THREE separate Devin model lists/alias maps:
the adapter's `staticDevinModels()` + `DEVIN_ACP_MODEL_ALIASES`, the contracts
catalog `MODEL_OPTIONS_BY_PROVIDER.devin`, and the contracts alias map
`MODEL_SLUG_ALIASES_BY_PROVIDER.devin`. The two alias maps even disagree: contracts
maps `opus -> "opus"` (identity) while the adapter maps `opus -> "claude-opus-4-8-medium"`.
The locked architecture decision for this PR is: Devin model discovery is
**runtime-first** (ask the live ACP session), with a **single, explicit fallback
catalog module** (`DevinModelCatalog`) as the only static data, with provenance.
This plan closes the main merge blocker called out in the architecture review:
"hardcoded Devin model alias/catalog data is still embedded in adapter code."

## Current state

Relevant files:

- `apps/server/src/provider/Layers/DevinAdapter.ts` — Devin ACP adapter. Contains the hardcoded data to extract:

```ts
// DevinAdapter.ts:60-72
const DEVIN_ACP_MODEL_ALIASES: Readonly<Record<string, string>> = {
  swe: "swe-1-6",
  opus: "claude-opus-4-8-medium",
  sonnet: "claude-sonnet-4-6",
  gpt: "gpt-5-5-medium",
  codex: "gpt-5-3-codex-medium",
  gemini: "gemini-3-5-flash-medium",
};

function normalizeDevinAcpModel(model: string): string {
  const trimmed = model.trim();
  return DEVIN_ACP_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
```

```ts
// DevinAdapter.ts:155-165
function staticDevinModels() {
  return [
    { slug: "adaptive", name: "Adaptive" },
    { slug: "swe-1-6", name: "SWE 1.6" },
    { slug: "swe-1-6-fast", name: "SWE 1.6 Fast" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-opus-4-8-medium", name: "Claude Opus 4.8 Medium" },
    { slug: "gpt-5-5-medium", name: "GPT-5.5 Medium" },
    { slug: "gemini-3-5-flash-medium", name: "Gemini 3.5 Flash Medium" },
  ];
}
```

```ts
// DevinAdapter.ts:845-850 (inside the adapter object literal)
listModels: () =>
  Effect.succeed({
    models: staticDevinModels(),
    source: "devin",
    cached: true,
  }),
```

`normalizeDevinAcpModel` is called at `DevinAdapter.ts:405` (startSession) and
`DevinAdapter.ts:595` (sendTurn).

- `packages/contracts/src/model.ts` — schema-only contracts package (data constants are allowed; runtime logic is NOT).
  - `MODEL_OPTIONS_BY_PROVIDER.devin` at lines 553-638: the same 7 models as `staticDevinModels()`, each shaped `{ slug, name, capabilities: { reasoningEffortLevels: [], supportsFastMode: false, supportsThinkingToggle: false, promptInjectedEffortLevels: [], contextWindowOptions: [] } }`.
  - `MODEL_SLUG_ALIASES_BY_PROVIDER.devin` at lines 699-706 — currently an identity map:

```ts
// packages/contracts/src/model.ts:699-706
devin: {
  swe: "swe",
  opus: "opus",
  sonnet: "sonnet",
  gpt: "gpt",
  codex: "codex",
  gemini: "gemini",
},
```

- `packages/shared/src/model.ts` — `normalizeModelSlug(model, provider)` (line 569) applies `MODEL_SLUG_ALIASES_BY_PROVIDER[provider]`; `resolveModelSlug` (line 624) passes devin slugs through unchecked: `if (provider === "devin" || provider === "pi") return normalized;`.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` — shared ACP engine. The runtime shape (line 78-118) exposes `getConfigOptions: Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>` and `setModel`. After `start()`, the session setup response carries `configOptions`; the option with `category === "model"` (see `extractModelConfigId`, `AcpRuntimeModel.ts:102-111`) is a `select` option whose values are the runtime's live model list (`collectSessionConfigOptionValues`, `AcpRuntimeModel.ts:127-136`). Select option entries have shape `{ value, name? }` or grouped `{ options: [{ value, name? }] }`.
- `apps/server/src/provider/Layers/CursorAdapter.ts:1363-1445` — exemplar `listModels` with `ProviderAdapterRequestError` error mapping (`method: "model/list"`).
- Contract result shape (`packages/contracts/src/providerDiscovery.ts:269-274`): `ProviderListModelsResult = { models: ProviderModelDescriptor[], source?, cached? }`; `ProviderModelDescriptor` requires `slug` (called `slug`? check lines 250-268 — it has model descriptor fields; match what `staticDevinModels()` already satisfies: `{ slug, name }`).

Repo conventions: Effect-TS everywhere (`Effect.gen`, tagged errors from `apps/server/src/provider/Errors.ts`), tests with `@effect/vitest` (`describe` / `it.effect` / `assert`) colocated as `*.test.ts`. Match `apps/server/src/provider/acp/CursorAcpSupport.ts` + its test for module layout of provider-specific ACP support files.

## Commands you will need

| Purpose                   | Command (run from repo root `/tmp/synara-pr`)                          | Expected on success |
| ------------------------- | ---------------------------------------------------------------------- | ------------------- |
| Install                   | `bun install`                                                          | exit 0              |
| Targeted tests            | `bunx vitest run apps/server/src/provider/**/*.test.ts`                | all pass            |
| Single test file          | `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` | all pass            |
| Final gate (once, at end) | `bun fmt && bun lint && bun typecheck`                                 | all exit 0          |

NEVER run `bun test` (it's the wrong runner) — always `bun run test`. Per repo
AGENTS.md, run the fmt/lint/typecheck trio ONCE as a final verification pass,
not during iteration.

## Scope

**In scope** (the only files you should modify/create):

- `apps/server/src/provider/acp/DevinModelCatalog.ts` (create)
- `apps/server/src/provider/acp/DevinModelCatalog.test.ts` (create)
- `apps/server/src/provider/Layers/DevinAdapter.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts`
- `packages/contracts/src/model.ts` (ONLY the `MODEL_SLUG_ALIASES_BY_PROVIDER.devin` map)

**Out of scope** (do NOT touch):

- `MODEL_OPTIONS_BY_PROVIDER.devin` in `packages/contracts/src/model.ts` — it stays; the catalog module will import from it so there is one static list.
- `packages/shared/src/model.ts` — `resolveModelSlug` devin passthrough is intentional (runtime-discovered models won't be in the static set).
- `apps/web/**` — web is a passive consumer; no UI changes in this plan.
- `AcpSessionRuntime.ts`, `AcpRuntimeModel.ts` — read-only here; do not modify shared ACP plumbing in this plan.
- Other providers' adapters and alias maps.

## Git workflow

- Branch: work directly on the current PR branch `devin-acp-provider-v2` (this plan is part of making PR #145 merge-ready).
- Commit per step; message style observed in `git log`: short imperative sentence (e.g. `Extract DevinModelCatalog fallback module`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Unify the alias map in contracts

In `packages/contracts/src/model.ts` (lines 699-706), change the devin alias map
from identity to the canonical slugs currently used in the adapter:

```ts
devin: {
  swe: "swe-1-6",
  opus: "claude-opus-4-8-medium",
  sonnet: "claude-sonnet-4-6",
  gpt: "gpt-5-5-medium",
  codex: "gpt-5-3-codex-medium",
  gemini: "gemini-3-5-flash-medium",
},
```

Before committing, search for tests pinning the old identity values:
`grep -rn '"swe"' packages/shared/src packages/contracts/src apps/web/src --include='*.test.ts'`
If a test asserts `normalizeModelSlug("opus", "devin") === "opus"` (or similar),
update it to the new canonical value. If non-test production code depends on the
identity mapping, STOP (see STOP conditions).

**Verify**: `bunx vitest run packages/shared/src/model.test.ts` → all pass.

### Step 2: Create `apps/server/src/provider/acp/DevinModelCatalog.ts`

A narrow fallback module with explicit provenance. Target shape:

```ts
/**
 * DevinModelCatalog - Devin model fallback data.
 *
 * PROVENANCE: This is a snapshot of the models advertised by `devin acp`
 * (Devin CLI) as of 2026-06. It is FALLBACK DATA ONLY — the authoritative
 * model list comes from the live ACP session's "model" config option
 * (see listModels in Layers/DevinAdapter.ts). Update this snapshot only when
 * Devin's defaults change; never let UI or tests treat it as runtime truth.
 *
 * @module DevinModelCatalog
 */
import { MODEL_OPTIONS_BY_PROVIDER, MODEL_SLUG_ALIASES_BY_PROVIDER } from "@t3tools/contracts";

export const DEVIN_FALLBACK_MODELS = MODEL_OPTIONS_BY_PROVIDER.devin.map((option) => ({
  slug: option.slug,
  name: option.name,
}));

export function normalizeDevinModelSlug(model: string): string {
  const trimmed = model.trim();
  return MODEL_SLUG_ALIASES_BY_PROVIDER.devin[trimmed.toLowerCase()] ?? trimmed;
}
```

Check the actual export names/paths in `packages/contracts` before writing the
import (`grep -n "export const MODEL_OPTIONS_BY_PROVIDER\|export const MODEL_SLUG_ALIASES_BY_PROVIDER" packages/contracts/src/model.ts`
and check how `apps/server` imports from `@t3tools/contracts` elsewhere, e.g. the
import block at `DevinAdapter.ts:6-18`).

**Verify**: file compiles as part of the final typecheck; defer.

### Step 3: Create `DevinModelCatalog.test.ts`

Model after `apps/server/src/provider/acp/CursorAcpSupport.test.ts` structurally
(plain `describe`/`it`/`assert` from `@effect/vitest` is fine — no Effect needed).
Cases:

- `normalizeDevinModelSlug("opus")` → `"claude-opus-4-8-medium"`.
- `normalizeDevinModelSlug(" SWE ")` → `"swe-1-6"` (trim + lowercase).
- `normalizeDevinModelSlug("claude-opus-4-8-medium")` → unchanged passthrough.
- `DEVIN_FALLBACK_MODELS` contains slug `"adaptive"` and every entry has non-empty `slug` and `name`.
- `DEVIN_FALLBACK_MODELS` slugs equal `MODEL_OPTIONS_BY_PROVIDER.devin.map(o => o.slug)` (the no-duplication guarantee).

**Verify**: `bunx vitest run apps/server/src/provider/acp/DevinModelCatalog.test.ts` → all pass.

### Step 4: Use the catalog in `DevinAdapter.ts` and delete the local copies

- Delete `DEVIN_ACP_MODEL_ALIASES`, `normalizeDevinAcpModel`, and `staticDevinModels` from `DevinAdapter.ts`.
- Import `DEVIN_FALLBACK_MODELS` and `normalizeDevinModelSlug` from `../acp/DevinModelCatalog.ts` (note: this repo uses explicit `.ts` extensions in relative imports — match the existing imports at the top of the file).
- Replace the two `normalizeDevinAcpModel(...)` call sites (lines 405 and 595) with `normalizeDevinModelSlug(...)`.

**Verify**: `grep -n "DEVIN_ACP_MODEL_ALIASES\|staticDevinModels\|normalizeDevinAcpModel" apps/server/src/provider/Layers/DevinAdapter.ts` → no matches.

### Step 5: Make `listModels` runtime-first

Replace the static `listModels` (DevinAdapter.ts:845-850) with a runtime-first
implementation. Design constraints, verified against the codebase:

- `ProviderListModelsInput` (`packages/contracts/src/providerDiscovery.ts:230-236`) carries no threadId — discovery is provider-global. The adapter holds `sessions: Map<ThreadId, DevinSessionContext>` and each context has `ctx.acp.getConfigOptions` (an `Effect` yielding the session's current `SessionConfigOption[]`).
- Runtime-first rule: if any live (non-stopped) session exists, read its config options, find the model option (an option with `category === "model"` — reuse `findSessionConfigOption`? No: that needs an id. Instead replicate the `extractModelConfigId` predicate inline: `opt.category === "model"`), and map `collectSessionConfigOptionValues`-style values to descriptors. Import `collectSessionConfigOptionValues` from `../acp/AcpRuntimeModel.ts` and use the option's entries to recover display names: select entries are `{ value, name? }` or grouped `{ options: [...] }` — prefer `name ?? value` for the descriptor `name`.
- Fallback rule: no live session, or the model option is missing/has zero values → return the catalog.

Target shape:

```ts
listModels: () =>
  Effect.gen(function* () {
    for (const ctx of sessions.values()) {
      if (ctx.stopped) continue;
      const configOptions = yield* ctx.acp.getConfigOptions;
      const modelOption = configOptions.find((opt) => opt.category === "model");
      if (!modelOption || modelOption.type !== "select") continue;
      const models = modelOption.options.flatMap((entry) =>
        "value" in entry
          ? [{ slug: entry.value, name: entry.name ?? entry.value }]
          : entry.options.map((o) => ({ slug: o.value, name: o.name ?? o.value })),
      );
      if (models.length > 0) {
        return { models, source: "devin.acp", cached: false };
      }
    }
    return { models: DEVIN_FALLBACK_MODELS, source: "devin.fallback", cached: true };
  }),
```

IMPORTANT: open `packages/effect-acp/src/_generated/schema.gen.ts` and confirm
the exact field names on `SessionConfigOption` select entries (search
`SessionConfigOption`). If entries have no `name` field, use `value` for both. If
`category` is not a field on the option type, find how `extractModelConfigId`
(`AcpRuntimeModel.ts:102-111`) discriminates and copy that predicate exactly.

Also update the `source` strings: the old code used `source: "devin"`. New values:
`"devin.acp"` (runtime) and `"devin.fallback"` (catalog). Grep
`grep -rn '"devin"' apps/web/src --include='*.ts*' | grep -i source` to confirm
nothing pins the old source string; if something does, STOP.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → existing tests pass (the alias test at line 197-237 asserts `opus → claude-opus-4-8-medium`, which still holds via the contracts map).

### Step 6: Add adapter tests for runtime-first listModels

In `DevinAdapter.test.ts`, extend `makeMockRuntime` (lines 19-70) so
`getConfigOptions` is configurable (add optional `configOptions` input, default `[]`).
Add tests following the existing `it.effect(...).pipe(Effect.provide(makeDevinAdapterLive({ makeRuntime: ... })))` pattern:

1. "lists models from the live ACP session config options" — start a session whose
   mock runtime returns a model config option, e.g.
   `{ id: "model", category: "model", type: "select", currentValue: "swe-1-6", options: [{ value: "swe-1-6", name: "SWE 1.6" }, { value: "claude-opus-4-8-medium", name: "Claude Opus 4.8 Medium" }] }`
   (cast as needed to the effect-acp type, matching how the file already casts mock
   values with `as unknown as`). Assert `listModels` yields those two models and
   `source === "devin.acp"`.
2. "falls back to the static catalog when no session is live" — no startSession;
   assert `listModels` yields `DEVIN_FALLBACK_MODELS` and `source === "devin.fallback"`.
3. "falls back when the live session exposes no model option" — session started
   with `configOptions: []`; assert fallback result.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass, including 3 new tests.

### Step 7: Final verification pass

Run, once each, as separate final verification passes:

- `bunx vitest run apps/server/src/provider/**/*.test.ts packages/shared/src/**/*.test.ts packages/contracts/src/**/*.test.ts`
- `bun fmt && bun lint && bun typecheck`

**Verify**: all exit 0.

## Test plan

Covered in steps 3 and 6. New tests:

- `DevinModelCatalog.test.ts`: alias normalization (3 cases), fallback list integrity (2 cases).
- `DevinAdapter.test.ts`: runtime-first discovery, no-session fallback, no-model-option fallback.
  Pattern exemplar: existing `DevinAdapter.test.ts` mock-runtime tests (lines 123-237).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "DEVIN_ACP_MODEL_ALIASES\|staticDevinModels" apps/server/src/provider/Layers/DevinAdapter.ts` → no matches
- [ ] `apps/server/src/provider/acp/DevinModelCatalog.ts` exists with a PROVENANCE comment
- [ ] `grep -c "swe-1-6" packages/contracts/src/model.ts` ≥ 2 (alias map now canonical) and the devin alias map no longer contains `swe: "swe"`
- [ ] `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/DevinModelCatalog.test.ts` → all pass
- [ ] `bun fmt && bun lint && bun typecheck` → exit 0 (single final pass)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts (drift since `f572445`).
- Non-test production code (server or web) depends on the identity devin alias map values from `packages/contracts/src/model.ts:699-706`.
- `SessionConfigOption` in `packages/effect-acp/src/_generated/schema.gen.ts` has no `category` field and `extractModelConfigId` uses a different discriminator you cannot reuse cleanly.
- Any web-app test or UI code pins `source === "devin"` from listModels.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Future Devin CLI releases may change default model slugs; only `MODEL_OPTIONS_BY_PROVIDER.devin` (contracts) and the alias map need updating — the adapter derives everything.
- If Plan 004 (slash-command discovery) adds runtime caching of discovery surfaces, `listModels` should adopt the same cache pattern; revisit then.
- Reviewer should scrutinize: the select-option entry shape mapping (grouped vs flat), and that `listModels` never throws when a session is mid-shutdown (`ctx.stopped` guard).
