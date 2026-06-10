# Plan 004: Native slash-command discovery for Devin via ACP `available_commands_update`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat f572445..HEAD -- apps/server/src/provider/acp/AcpRuntimeModel.ts apps/server/src/provider/acp/AcpSessionRuntime.ts apps/server/src/provider/Layers/DevinAdapter.ts`
> If in-scope files changed, compare the "Current state" excerpts against live
> code; on a mismatch, STOP. Expected benign drift: Plans 001-003 modify
> DevinAdapter.ts (model/mode helpers removed, elicitation added).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches shared ACP runtime used by Cursor and Grok)
- **Depends on**: none hard; rebase after 001-003 if they landed
- **Category**: tech-debt (capability gap vs locked architecture)
- **Planned at**: commit `f572445`, 2026-06-10

## Why this matters

Locked decision for PR #145: Devin exposes **native slash-command discovery**,
full-discovery-first (a curated allowlist only as a fallback if the runtime
cannot expose the full surface). The ACP protocol carries exactly this: a
`session/update` notification with `sessionUpdate: "available_commands_update"`
listing `AvailableCommand[]` — and the vendored `effect-acp` schema already
models it. But Synara's shared ACP runtime model silently drops that update, and
the Devin adapter declares `supportsNativeSlashCommandDiscovery: false` with no
`listCommands`. Devin docs indicate slash commands like `/steps`, `/fork`,
`/revert`, `/compact`, `/ask`, `/mode`, `/model` exist; without discovery, users
can't see or use them from Synara's composer.

## Current state

- `packages/effect-acp/src/_generated/schema.gen.ts:930-950` — `AvailableCommand`:
  `{ name: string, description: string, input?: AvailableCommandInput | null, _meta?... }`.
  And lines 2308-2310 / 2854-2864 — the `SessionNotification` union member:
  `{ sessionUpdate: "available_commands_update", availableCommands: AvailableCommand[] }`.

- `apps/server/src/provider/acp/AcpRuntimeModel.ts:594-666` —
  `parseSessionUpdateEvent` switches on `upd.sessionUpdate` for
  `current_mode_update`, `plan`, `tool_call`/`tool_call_update`, message chunks,
  usage. There is NO case for `available_commands_update` (verify:
  `grep -n "available_commands" apps/server/src/provider/acp/AcpRuntimeModel.ts`
  → no matches today). The parsed-event union `AcpParsedSessionEvent` (lines
  55-90) has tags: ModeChanged, AssistantItemStarted, AssistantItemCompleted,
  PlanUpdated, ToolCallUpdated, ContentDelta, UsageUpdated.

- `apps/server/src/provider/acp/AcpSessionRuntime.ts`:
  - `handleSessionUpdate` (lines 595-666) routes parsed events into the queue and
    maintains `modeStateRef` — commands need an analogous `commandsRef`.
  - The runtime shape (lines 78-118) exposes `getModeState` /
    `getConfigOptions`; a `getAvailableCommands` accessor belongs beside them.
  - The session-setup path (lines 453-454) seeds `modeStateRef`/`configOptionsRef`
    from the setup response. Check whether `NewSessionResponse`/`LoadSessionResponse`
    also carry `availableCommands` (grep `availableCommands` in `schema.gen.ts`
    near the session response types); if yes, seed the commands ref there too.

- `apps/server/src/provider/Layers/DevinAdapter.ts:833-844` — capability flags:

```ts
getComposerCapabilities: () =>
  Effect.succeed({
    provider: PROVIDER,
    supportsSkillMentions: false,
    supportsSkillDiscovery: false,
    supportsNativeSlashCommandDiscovery: false,
    ...
  } satisfies ProviderComposerCapabilities),
```

No `listCommands` is implemented (the adapter interface's optional
`listCommands` — `apps/server/src/provider/Services/ProviderAdapter.ts:209-211`).

- Contracts (`packages/contracts/src/providerDiscovery.ts:85-109`):
  `ProviderNativeCommandDescriptor = { name, description? }`;
  `ProviderListCommandsInput = { provider, cwd, threadId?, binaryPath?, ... }`;
  `ProviderListCommandsResult = { commands, source?, cached? }`.

- Exemplar `listCommands` consumer-side shape: `PiAdapter.ts:1734+` resolves the
  active session from `input.threadId` (`sessions.get(ThreadId.makeUnsafe(input.threadId))`)
  and returns `{ commands, source, cached }`.

- Routing: `ProviderDiscoveryService` dispatches `listCommands` only when the
  adapter defines it; the web composer gates on
  `supportsNativeSlashCommandDiscovery` (server truth → presentation-only UI,
  per the locked architecture).

## Commands you will need

| Purpose                | Command (repo root `/tmp/synara-pr`)                                   | Expected on success               |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| Install                | `bun install`                                                          | exit 0                            |
| Runtime model tests    | `bunx vitest run apps/server/src/provider/acp/AcpRuntimeModel.test.ts` | all pass                          |
| ACP runtime + adapters | `bunx vitest run apps/server/src/provider/**/*.test.ts`                | all pass (Cursor/Grok unaffected) |
| Final gate (once)      | `bun fmt && bun lint && bun typecheck`                                 | all exit 0                        |

NEVER run `bun test`; always `bun run test` / `bunx vitest run <file>`.

## Scope

**In scope** (only files to modify):

- `apps/server/src/provider/acp/AcpRuntimeModel.ts` (+ its test)
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `apps/server/src/provider/Layers/DevinAdapter.ts` (+ its test)

**Out of scope** (do NOT touch):

- `packages/effect-acp/**` — schema already supports the update.
- `packages/contracts/**` — existing command contracts suffice.
- CursorAdapter / GrokAdapter — they may adopt command discovery later; this plan
  must not change their behavior (the runtime change is purely additive).
- A curated Devin command catalog (`DevinCommandCatalog`) — per the locked
  decision it exists "only if needed"; full discovery is implemented here, so do
  NOT create a static command list. If discovery yields nothing, return an empty
  list — never invent commands.
- `apps/web/**`.

## Git workflow

- Branch: current PR branch `devin-acp-provider-v2`.
- Commits per step, imperative style.
- Do NOT push unless instructed.

## Steps

### Step 1: Parse `available_commands_update` in `AcpRuntimeModel.ts`

1. Add to the `AcpParsedSessionEvent` union (lines 55-90):

```ts
| {
    readonly _tag: "AvailableCommandsUpdated";
    readonly commands: ReadonlyArray<AcpAvailableCommand>;
    readonly rawPayload: unknown;
  }
```

with `export interface AcpAvailableCommand { readonly name: string; readonly description?: string; }`
(normalize: trim both; drop entries with empty `name`; omit `description` when
empty after trim — match how `parseSessionModeState` normalizes at lines 147-159). 2. Add a case to the switch in `parseSessionUpdateEvent` (after `plan`, line 612):

```ts
case "available_commands_update": {
  const commands = upd.availableCommands
    .map((command) => {
      const name = command.name.trim();
      if (!name) return undefined;
      const description = command.description.trim() || undefined;
      return description !== undefined ? { name, description } : { name };
    })
    .filter((c): c is AcpAvailableCommand => c !== undefined);
  events.push({ _tag: "AvailableCommandsUpdated", commands, rawPayload: params });
  break;
}
```

Confirm the exact field name `availableCommands` against
`schema.gen.ts:2854-2864` before writing.

**Verify**: add tests in `AcpRuntimeModel.test.ts` — model after the existing
`parseSessionUpdateEvent` tests in that file (open it; mirror the fixture style
used for the `plan` case). Cases: commands parsed + trimmed; empty-name entries
dropped; empty list yields event with `commands: []`.
`bunx vitest run apps/server/src/provider/acp/AcpRuntimeModel.test.ts` → all pass.

### Step 2: Track commands in `AcpSessionRuntime.ts`

1. Add `const availableCommandsRef = yield* Ref.make<ReadonlyArray<AcpAvailableCommand>>([]);`
   beside the other refs (lines 165-170).
2. In `handleSessionUpdate` (lines 595-666): when an event with
   `_tag === "AvailableCommandsUpdated"` flows through, `Ref.set` the ref before
   offering the event to the queue. Pass the ref into `handleSessionUpdate` the
   same way `modeStateRef` is passed (update the function parameter object and
   the call at lines 236-244).
3. If the session setup responses carry `availableCommands` (checked in recon
   step — see Current state), seed the ref at startup beside line 453-454.
4. Expose on the runtime shape (interface lines 78-118 + returned object at 497+):
   `readonly getAvailableCommands: Effect.Effect<ReadonlyArray<AcpAvailableCommand>>;`
   implemented as `Ref.get(availableCommandsRef)`.
5. Update every mock implementing `AcpSessionRuntimeShape`:
   `grep -rln "AcpSessionRuntimeShape" apps/server/src` — known mocks:
   `DevinAdapter.test.ts:19-70` (`makeMockRuntime`), and equivalents in
   `CursorAdapter`/`GrokAdapter` tests if they mock the shape (the Cursor/Grok
   tests may construct runtimes differently — check before editing). Add
   `getAvailableCommands: Effect.succeed(input?.availableCommands ?? [])`.

**Verify**: `bunx vitest run apps/server/src/provider/acp/**/*.test.ts` → all pass (no behavior
change for existing events).

### Step 3: Implement Devin `listCommands` + flip the capability

In `DevinAdapter.ts`:

1. Add to the adapter object (beside `listModels`):

```ts
listCommands: (input) =>
  Effect.gen(function* () {
    const ctx = input.threadId ? sessions.get(ThreadId.makeUnsafe(input.threadId)) : undefined;
    if (ctx && !ctx.stopped) {
      const commands = yield* ctx.acp.getAvailableCommands;
      return { commands, source: "devin.acp", cached: false };
    }
    for (const candidate of sessions.values()) {
      if (candidate.stopped) continue;
      const commands = yield* candidate.acp.getAvailableCommands;
      if (commands.length > 0) {
        return { commands, source: "devin.acp", cached: false };
      }
    }
    return { commands: [], source: "devin.acp", cached: false };
  }),
```

(`AcpAvailableCommand` is structurally compatible with
`ProviderNativeCommandDescriptor` — `{ name, description? }`. `ThreadId` is
already imported in this file.) 2. Update both capability surfaces:

- `capabilities` (lines 747-750): add `supportsNativeSlashCommandDiscovery: true`
  — first check what the `ProviderAdapterCapabilities` flag drives by reading
  how `ProviderAdapterRegistry`/`ProviderDiscoveryService` consume it; mirror
  how `PiAdapter` sets it (PiAdapter.ts:1804).
- `getComposerCapabilities` (line 838): `supportsNativeSlashCommandDiscovery: true`.

Honesty rule from the architecture review: the flag may be `true` because the
adapter genuinely implements discovery and returns an empty list when the
runtime hasn't advertised commands — the UI shows no commands rather than
erroring. Do not gate the flag on session state.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → existing tests pass.

### Step 4: Adapter tests

In `DevinAdapter.test.ts` add `it.effect` tests (extend `makeMockRuntime` with an
optional `availableCommands` input, per step 2.5):

1. "lists Devin slash commands from the live ACP session" — start session with
   mock `availableCommands: [{ name: "revert", description: "Revert changes" }, { name: "steps" }]`;
   call `adapter.listCommands!({ provider: "devin", cwd: "/tmp/project", threadId: String(threadId) })`;
   assert both commands and `source === "devin.acp"`.
   (Check `ProviderListCommandsInput.threadId` is a plain string — it is,
   `Schema.optional(TrimmedNonEmptyString)`.)
2. "returns empty commands when no session is live" — no session; assert
   `commands: []` (no invented fallback).
3. "composer capabilities advertise native slash-command discovery" — assert
   `supportsNativeSlashCommandDiscovery === true` from `getComposerCapabilities()`.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass, ≥3 new tests.

### Step 5: Final verification pass

Once each, as separate final verification passes:

- `bunx vitest run apps/server/src/provider/**/*.test.ts`
- `bun fmt && bun lint && bun typecheck`

**Verify**: all exit 0. Pay attention to Cursor/Grok adapter tests — they must be
untouched and green.

## Test plan

Steps 1, 2 (implicit via suite), and 4. Exemplars: `AcpRuntimeModel.test.ts`
fixture style; `DevinAdapter.test.ts` mock-runtime style.

## Done criteria

- [ ] `grep -n "available_commands_update" apps/server/src/provider/acp/AcpRuntimeModel.ts` → ≥1 match
- [ ] `grep -n "getAvailableCommands" apps/server/src/provider/acp/AcpSessionRuntime.ts` → interface + implementation
- [ ] `grep -n "supportsNativeSlashCommandDiscovery: true" apps/server/src/provider/Layers/DevinAdapter.ts` → 2 matches (capabilities + composer capabilities)
- [ ] `grep -rn "DevinCommandCatalog" apps/` → no matches (no invented static catalog)
- [ ] `bunx vitest run apps/server/src/provider/**/*.test.ts` → all pass including new tests
- [ ] `bun fmt && bun lint && bun typecheck` → exit 0 (single final pass)
- [ ] `git status` clean outside in-scope list; `plans/README.md` updated

## STOP conditions

- The effect-acp `SessionNotification` union does not contain
  `available_commands_update` (schema regenerated differently than excerpted).
- Adding the parsed-event tag breaks exhaustive switches in CursorAdapter or
  GrokAdapter event loops (check: Devin's loop at `DevinAdapter.ts:452-542`
  switches on `event._tag` — a new tag may make TypeScript demand a case in
  OTHER adapters' loops too; if Cursor/Grok loops are exhaustive and need a
  no-op case added, that's a 1-line addition each and acceptable, but if it
  requires behavioral decisions in those adapters, STOP).
- The composer UI errors when `supportsNativeSlashCommandDiscovery: true` but
  `listCommands` returns an empty list (verify by reading the web composer
  registry consumer if in doubt — read-only).
- `ProviderNativeCommandDescriptor` requires fields `AvailableCommand` can't supply.

## Maintenance notes

- Devin's command surface varies by account/team settings — discovery handles
  this automatically; never pin command names in tests of the live path.
- If Devin's `/revert` and `/fork` commands surface here, a follow-up can map
  them to Synara's rollback lane (see `rollbackThread`'s unsupported error at
  `DevinAdapter.ts:810-826`) — explicitly deferred out of this plan.
- Cursor/Grok can adopt `getAvailableCommands` later; the runtime support added
  here is provider-agnostic by design.
