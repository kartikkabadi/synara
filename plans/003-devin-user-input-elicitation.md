# Plan 003: Wire Devin into Synara's structured user-input lane via ACP form elicitation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat f572445..HEAD -- apps/server/src/provider/Layers/DevinAdapter.ts apps/server/src/provider/acp/DevinAcpSupport.ts apps/server/src/provider/acp/AcpSessionRuntime.ts`
> If in-scope files changed, compare the "Current state" excerpts against live
> code before proceeding; on a mismatch, STOP. Expected benign drift: Plans 001
> and 002 remove model/mode helpers from DevinAdapter.ts — that's fine.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (rebase over 001/002 if they landed)
- **Category**: bug (capability gap vs locked architecture)
- **Planned at**: commit `f572445`, 2026-06-10

## Why this matters

Locked decision for PR #145: "Devin participates in Synara's structured
user-input lane if ACP/runtime supports it." The runtime DOES support it: the
vendored `effect-acp` client exposes `handleElicitation` (`session/elicitation`,
form mode), and `AcpSessionRuntime` already forwards it. But the Devin adapter's
`respondToUserInput` is a stub that always fails, and the adapter never registers
an elicitation handler — so if Devin asks a structured question, the request is
unanswered and the turn hangs or errors. This plan implements the lane end to
end on the server, mirroring the proven CursorAdapter user-input pattern.

## Current state

- `apps/server/src/provider/Layers/DevinAdapter.ts:782-789` — the stub to replace:

```ts
respondToUserInput: (_threadId, requestId) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session/elicitation",
      detail: `Unknown pending user-input request: ${requestId}`,
    }),
  ),
```

- `apps/server/src/provider/Layers/DevinAdapter.ts:94-111` — session context has
  `pendingApprovals: Map<ApprovalRequestId, PendingApproval>` but no
  `pendingUserInputs`. `startSession` registers `acp.handleRequestPermission(...)`
  (lines 335-395) before `acp.start()` (line 396) — the elicitation handler must
  be registered in the same block.

- `apps/server/src/provider/acp/AcpSessionRuntime.ts:78-93` — the runtime shape
  re-exports `handleElicitation` from the effect-acp client. Handler signature
  (from `packages/effect-acp/src/client.ts:145-149`):

```ts
readonly handleElicitation: (
  handler: (request: AcpSchema.ElicitationRequest) =>
    Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>,
) => Effect.Effect<void>;
```

- `ElicitationRequest` (from `packages/effect-acp/src/_generated/schema.gen.ts:5965-5986`)
  is a union of `mode: "form"` (with `message: string` and `requestedSchema:
{ title?, description?, properties?: Record<string, ElicitationPropertySchema>, required? }`)
  and `mode: "url"` (out of scope per the locked auth/out-of-band decision).
  `ElicitationPropertySchema` variants: `string` (may carry `enum?: string[]` or
  `oneOf?: EnumOption[]`), `number`, `integer`, `boolean`, `array` (items can be
  string enum). `ElicitationResponse` (schema.gen.ts:6076-6085):

```ts
{ action: { action: "accept"; content?: Record<string, ElicitationContentValue> | null }
        | { action: "decline" }
        | { action: "cancel" } }
```

`ElicitationContentValue = string | number | boolean | ReadonlyArray<string>`.

- Synara's user-input contracts (`packages/contracts/src/providerRuntime.ts:453-478`):

```ts
UserInputQuestion = { id, header, question, options: UserInputQuestionOption[], multiSelect? }
UserInputQuestionOption = { label, description }   // both TrimmedNonEmptyString
UserInputRequestedPayload = { questions: UserInputQuestion[] }
UserInputResolvedPayload = { answers: Record<string, string | string[] | null> }
```

`ProviderUserInputAnswers` (`packages/contracts/src/orchestration.ts:247-252`)
= `Record<string, string | string[] | null>`.

- **The exemplar to mirror** — `apps/server/src/provider/Layers/CursorAdapter.ts`:
  - `PendingUserInput` interface (lines 127-129): `{ answers: Deferred<ProviderUserInputAnswers> }`.
  - Handler wiring inside startSession (lines 649-688): create `requestId` +
    `runtimeRequestId`, store the deferred in `pendingUserInputs`, publish
    `user-input.requested` with `payload: { questions }` and a `raw` block, await
    the deferred, delete the entry, publish `user-input.resolved` with
    `payload: { answers }`, return the provider-shaped response.
  - `respondToUserInput` (lines 1271-1288): look up `pendingUserInputs`, fail with
    `ProviderAdapterRequestError` if unknown, else `Deferred.succeed(pending.answers, answers)`.
  - Question normalization helper `extractAskQuestions`
    (`apps/server/src/provider/acp/CursorAcpExtension.ts:56-72`) — note the
    fallback `[{ label: "OK", description: "Continue" }]` when no options exist,
    because `UserInputQuestionOption` fields are non-empty strings.
  - Cleanup on stop/interrupt: Cursor calls `settlePendingUserInputsAsEmptyAnswers`
    (defined near line 247, used at 556 and 1239). Devin currently only settles
    approvals (`settlePendingApprovalsAsCancelled`, `DevinAdapter.ts:145-153`,
    used in `stopSessionInternal` line 280 and `interruptTurn` line 756).

- `apps/server/src/provider/acp/DevinAcpSupport.ts:83-100` — `makeDevinAcpRuntime`
  builds `AcpSessionRuntime.layer({ ...input, spawn, resolveAuthMethodId,
authenticateMeta: { headless: true } })`. It does NOT pass `clientCapabilities`,
  and `AcpSessionRuntime.ts:246-258` only includes `elicitation` in the initialize
  payload when the caller provides it. Without advertising
  `clientCapabilities.elicitation.form`, the agent will never send form
  elicitations — this is the activation switch.

- Devin event publishing pattern: the adapter `publish`es `ProviderRuntimeEvent`s
  to a PubSub (`DevinAdapter.ts:262-263`); Cursor uses `offerRuntimeEvent` —
  same role, different name. Use Devin's `publish`.

## Commands you will need

| Purpose           | Command (repo root `/tmp/synara-pr`)                                            | Expected on success |
| ----------------- | ------------------------------------------------------------------------------- | ------------------- |
| Install           | `bun install`                                                                   | exit 0              |
| Adapter tests     | `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts`          | all pass            |
| Support tests     | `bunx vitest run apps/server/src/provider/acp/DevinAcpSupport.test.ts` (create) | all pass            |
| Final gate (once) | `bun fmt && bun lint && bun typecheck`                                          | all exit 0          |

NEVER run `bun test`; always `bun run test` / `bunx vitest run <file>`.

## Scope

**In scope** (only files to modify/create):

- `apps/server/src/provider/Layers/DevinAdapter.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts`
- `apps/server/src/provider/acp/DevinAcpSupport.ts`
- `apps/server/src/provider/acp/DevinElicitation.ts` (create — pure mapping helpers)
- `apps/server/src/provider/acp/DevinElicitation.test.ts` (create)

**Out of scope** (do NOT touch):

- `AcpSessionRuntime.ts` / `effect-acp` — they already support everything needed.
- URL-mode elicitation — explicitly out of scope per locked decision 11
  (browser/out-of-band auth excluded). It must be **declined**, not implemented.
- `apps/web/**` and orchestration layers — the `user-input.requested/resolved`
  events already flow through the generic lane (Cursor proves it).
- CursorAdapter/GrokAdapter — read-only exemplars.

## Git workflow

- Branch: current PR branch `devin-acp-provider-v2`.
- Commits per step, imperative style (e.g. `Add Devin ACP form elicitation mapping helpers`).
- Do NOT push unless instructed.

## Steps

### Step 1: Create `apps/server/src/provider/acp/DevinElicitation.ts`

Pure helpers (no Effect needed) with `@module DevinElicitation` doc header:

1. `elicitationFormToUserInputQuestions(request): ReadonlyArray<UserInputQuestion>`
   — input: the `mode: "form"` member of `ElicitationRequest`. Mapping rules:
   - One `UserInputQuestion` per entry in `requestedSchema.properties`
     (insertion order). `id` = property key. `header` = property `title`
     (trimmed) or the property key. `question` = property `description`
     (trimmed) or `request.message`.
   - `string` with non-empty `enum` → options `enum.map(v => ({ label: v, description: v }))`, `multiSelect: false`.
   - `string` with non-empty `oneOf` → options from `EnumOption` entries (inspect
     `EnumOption` in `schema.gen.ts` — use its value for `label` and its
     name/description field, falling back to the value, for `description`).
   - `boolean` → options `[{ label: "Yes", description: "Yes" }, { label: "No", description: "No" }]`.
   - `array` with string-enum items → options from the enum, `multiSelect: true`.
   - Anything else (free string, number, integer) → options
     `[{ label: "OK", description: "Continue" }]` (matches the Cursor fallback at
     `CursorAcpExtension.ts:70`) — Synara's user-input lane is option-based; the
     UI's free-text "Other" path still carries arbitrary text back in answers.
   - If `properties` is empty/missing, return a single question:
     `{ id: "response", header: "Devin", question: request.message, options: [{ label: "OK", description: "Continue" }] }`.
2. `userInputAnswersToElicitationContent(request, answers): Record<string, ElicitationContentValue>`
   — for each property key present in `answers` with a non-null value:
   - `boolean` property: `"Yes"`/`"No"` (and `"true"`/`"false"`, case-insensitive) → boolean.
   - `number`/`integer` property: `Number(value)` when finite, else skip the key.
   - `array` property: wrap a lone string into `[value]`; pass arrays through.
   - `string` property: arrays are joined with `", "`; strings pass through.
   - Keys not in `requestedSchema.properties` are passed through as strings
     (covers the synthetic `"response"` question — but only include `"response"`
     when properties was empty; otherwise drop unknown keys).

Keep these functions total — never throw; skip unmappable values.

**Verify**: step 2 test run.

### Step 2: Create `DevinElicitation.test.ts`

Plain `describe`/`it`/`assert` (`@effect/vitest`). Minimum cases:

- enum string → options + ids/headers correct.
- boolean → Yes/No options; answers round-trip `"Yes"` → `true`.
- array-of-enum → `multiSelect: true`; answers `["a","b"]` pass through.
- free string → OK fallback option; answer string passes through.
- number property: `"42"` → `42`; `"abc"` → key skipped.
- empty properties → single synthetic `"response"` question; answer included.
- null answers are skipped.

**Verify**: `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts` → all pass.

### Step 3: Advertise form-elicitation capability in `DevinAcpSupport.ts`

In `makeDevinAcpRuntime` (`DevinAcpSupport.ts:83-100`), pass client capabilities
into `AcpSessionRuntime.layer`:

```ts
AcpSessionRuntime.layer({
  ...input,
  spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd),
  resolveAuthMethodId: resolveDevinAcpAuthMethodId,
  authenticateMeta: { headless: true },
  clientCapabilities: {
    ...input.clientCapabilities,
    elicitation: { form: {} },
  },
});
```

First confirm the exact shape `ElicitationCapabilities` expects
(`schema.gen.ts:959-986`: `{ form?: ElicitationFormCapabilities | null, url?: ... }`,
and check whether `ElicitationFormCapabilities` (schema.gen.ts:97-113) requires
any fields — if it's an empty/optional struct, `{}` is right; if it has flags,
set the minimal truthy form). Note `DevinAcpRuntimeInput` (DevinAcpSupport.ts:23-29)
omits only `authMethodId | resolveAuthMethodId | spawn` from the runtime options,
so `clientCapabilities` is already accepted on input — the spread+override above
keeps caller-supplied fs/terminal capabilities intact. Do NOT advertise `url`.

**Verify**: covered by typecheck + step 6 tests.

### Step 4: Wire the elicitation handler and pending map in `DevinAdapter.ts`

1. Add `interface PendingUserInput { readonly answers: Deferred.Deferred<ProviderUserInputAnswers>; }`
   next to `PendingApproval` (line 94-97) and a
   `readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>` field on
   `DevinSessionContext` (lines 99-111); initialize it in `startSession` beside
   `pendingApprovals` (line 314) and in the `ctx = {...}` literal (lines 438-450).
   Import `ProviderUserInputAnswers` (type) from `@t3tools/contracts` and reuse
   the existing `UserInputQuestion` type import if needed.
2. In the `Effect.gen` block that registers `acp.handleRequestPermission`
   (before `acp.start()`, lines 334-396), also register:

```ts
yield *
  acp.handleElicitation((request) =>
    Effect.gen(function* () {
      if (request.mode !== "form") {
        return { action: { action: "decline" as const } };
      }
      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      pendingUserInputs.set(requestId, { answers });
      yield* publish({
        type: "user-input.requested",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        turnId: ctx?.activeTurnId,
        requestId: runtimeRequestId,
        payload: { questions: elicitationFormToUserInputQuestions(request) },
        raw: { source: "acp.jsonrpc", method: "session/elicitation", payload: request },
      });
      const resolved = yield* Deferred.await(answers);
      pendingUserInputs.delete(requestId);
      yield* publish({
        type: "user-input.resolved",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        turnId: ctx?.activeTurnId,
        requestId: runtimeRequestId,
        payload: { answers: resolved },
      });
      const content = userInputAnswersToElicitationContent(request, resolved);
      return Object.keys(content).length > 0
        ? { action: { action: "accept" as const, content } }
        : { action: { action: "cancel" as const } };
    }),
  );
```

Match the exact event field names against the Cursor wiring
(`CursorAdapter.ts:661-685`) and the `ProviderRuntimeEvent` schema — if the
Devin `publish` events elsewhere in this file don't use a `raw` field
(compare `session.started` at lines 548-554), check whether
`user-input.requested` in `packages/contracts/src/providerRuntime.ts`
(around lines 818-830) requires/permits `raw`, and conform to the schema.
Note the handler's error channel is `AcpError`; the body above never fails,
which is fine. 3. Replace the `respondToUserInput` stub (lines 782-789) with the Cursor-shaped
implementation:

```ts
respondToUserInput: (threadId, requestId, answers) =>
  Effect.gen(function* () {
    const ctx = yield* requireSession(threadId);
    const pending = ctx.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/elicitation",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }
    yield* Deferred.succeed(pending.answers, answers);
  }),
```

4. Settle pending user inputs on shutdown/interrupt: add

```ts
function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    [...pendingUserInputs.values()],
    (pending) => Deferred.succeed(pending.answers, {}),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => pendingUserInputs.clear())));
}
```

(compare Cursor's version near `CursorAdapter.ts:247` and copy its exact
empty-answer semantics if they differ) and call it in `stopSessionInternal`
(beside line 280) and `interruptTurn` (beside line 756).

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → existing tests pass (the mock runtime at test line 31 already stubs `handleElicitation: () => Effect.void`).

### Step 5: Adapter tests for the lane

In `DevinAdapter.test.ts`, extend `makeMockRuntime` so the test can capture the
registered elicitation handler (mirror how a handler-capturing mock would work:
store the handler passed to `handleElicitation` in a local, expose a
`triggerElicitation(request)` helper from the test). Add `it.effect` tests:

1. "publishes user-input.requested for a Devin form elicitation and resolves with accepted answers" —
   start session; fire a form elicitation
   `{ mode: "form", sessionId: "s", message: "Pick one", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["a", "b"] } } } }`
   via the captured handler (fork it); take the `user-input.requested` event from
   `adapter.streamEvents` (see how existing code consumes streams — use
   `Stream.take(...)`/`Stream.runCollect` and fork before triggering); call
   `adapter.respondToUserInput(threadId, requestId, { choice: "a" })` with the
   requestId from the event; assert the handler's Effect resolves to
   `{ action: { action: "accept", content: { choice: "a" } } }` and a
   `user-input.resolved` event followed.
2. "declines URL-mode elicitation" — fire `{ mode: "url", ... }`; assert result
   `{ action: { action: "decline" } }` and no `user-input.requested` event published.
3. "respondToUserInput fails for unknown request id" — assert
   `ProviderAdapterRequestError` (keeps stub-era behavior for unknown ids).
4. "stopSession settles pending user input with empty answers" — fire a form
   elicitation, then `stopSession`; assert the handler resolves with
   `{ action: { action: "cancel" } }` (empty answers → cancel per step 4.2 logic).

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass, ≥4 new tests.

### Step 6: Final verification pass

Once each, as separate final verification passes:

- `bunx vitest run apps/server/src/provider/**/*.test.ts`
- `bun fmt && bun lint && bun typecheck`

**Verify**: all exit 0.

## Test plan

Steps 2 and 5. Pattern exemplars: `DevinAdapter.test.ts` mock-runtime tests;
for event-stream assertions, look at how `CursorAdapter`'s tests (if present) or
`GrokAdapter.test.ts` consume `streamEvents` and copy that structure.

## Done criteria

- [ ] `grep -n "handleElicitation" apps/server/src/provider/Layers/DevinAdapter.ts` → ≥1 match (handler registered)
- [ ] `respondToUserInput` in DevinAdapter no longer unconditionally fails (resolves a pending deferred)
- [ ] `grep -n "elicitation" apps/server/src/provider/acp/DevinAcpSupport.ts` → capability advertised
- [ ] `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass (≥11 new tests total)
- [ ] URL-mode elicitation is declined, with a test proving it
- [ ] `bun fmt && bun lint && bun typecheck` → exit 0 (single final pass)
- [ ] `git status` clean outside in-scope list; `plans/README.md` updated

## STOP conditions

- The `user-input.requested` event schema in `packages/contracts/src/providerRuntime.ts`
  cannot represent what the handler needs to publish (e.g. `raw` required but
  unbuildable, or requestId type mismatch) — report; do not modify contracts.
- `ElicitationRequest`/`ElicitationResponse` shapes in `schema.gen.ts` differ
  from the excerpts above (effect-acp regenerated).
- The handler registration point conflicts with Plans 001/002 changes in a way
  that's not a trivial rebase.
- You find yourself wanting to implement URL elicitation "while you're in there" — don't.

## Maintenance notes

- The ACP elicitation surface is marked **UNSTABLE** in the protocol — when
  effect-acp regenerates, `DevinElicitation.ts` is the single seam to update;
  its tests will catch shape drift.
- The option-based fallback (`OK / Continue`) for free-text properties is a UX
  compromise; if Synara's user-input lane later grows a native free-text question
  type, upgrade the mapping here.
- Reviewer should scrutinize: deferred cleanup on interrupt/stop (no leaked
  pending entries), and that decline/cancel responses can't wedge an active turn.
