# Plan 008: Devin Cloud provider with ACP-primary / REST-fallback transports

> **Executor instructions**: Follow this plan step by step. Run every focused
> verification command and confirm the expected result before moving on. Do not
> broaden this into a provider-framework rewrite.
>
> **Drift check (run first)**:
> `git diff --stat HEAD -- packages/contracts/src apps/server/src/provider apps/server/src/providerCredentials.ts apps/server/src/serverSettings.ts packages/shared/src/providerMetadata.ts packages/shared/src/model.ts apps/web/src/components/settings/ProvidersSettingsPanel.tsx apps/web/src/appSettings.ts apps/web/src/components/ProviderIcon.tsx`
> If an in-scope file changed, compare with the current-state evidence below
> before editing.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: none (both transports are additive; no existing behavior changes)
- **Category**: feature
- **Planned at**: 2026-09-22 (audited ×4 against contract source + live API)

## Why this matters

Cognition shipped "Devin Cloud in your terminal" (blog 2026-09-21). Synara
users should be able to run Devin Cloud sessions from the workspace. Two
programmatic surfaces exist:

- `devin acp --cloud` — ACP relay to Devin Cloud. Full streaming transcript via
  the existing ACP machinery, zero new credentials (reuses `devin auth login` /
  `WINDSURF_API_KEY` / `credentials.toml`). **Currently insiders-gated**: the
  flag is rejected by stable build 3000.10.31 (`devin acp --help` has no
  `--cloud` option; `devin acp --cloud` exits "unexpected argument").
  `devin --cloud`, `/cloud`, `/cloud-attach`, `/cloud-sessions` are likewise
  insiders. Only `/handoff` is GA (TUI-driven, not embeddable).
- Devin v3 REST API — GA, poll-based.

## Verified facts

### v3 REST API auth (live-verified on this machine)

The credential stored by `devin auth login`
(`~/.local/share/devin/credentials.toml`, `windsurf_api_key`) works as a v3
bearer for the logged-in user's org:

- `GET /v3/self` → 200 `{principal_type:"windsurf_session", user_id, user_name,
org_id}` — **org id is auto-discoverable, no manual entry**; `org_id` is
  required (non-null) on `WindsurfSessionUserSelf`.
- `GET /v3/organizations/{org}/sessions?first=3` → 200.
- `POST /v3/organizations/{org}/sessions` → 200 (probe `fdead757…`,
  `status:new`, `origin:"api"`).
- `GET …/messages` → 200 (saw user prompt + devin reply).
- `DELETE …/sessions/{devin_id}` → 200 (probe terminated).

Consequence: REST is **zero-config for any user logged into Devin CLI** — same
credential chain `DevinAcpSupport` already resolves (`WINDSURF_API_KEY` /
`DEVIN_API_KEY` env → `credentials.toml`; `providerUsage/providers/devin.ts`
does exactly this via `readDevinStoredCredentials`/`getDevinApiKeyEnv`).
Settings `apiKey`/`orgId` are **optional overrides** (headless servers, service
accounts, other orgs), not required setup.

### v3 endpoints (docs.devin.ai/v3-openapi.yaml, fetched in full)

- Base `https://api.devin.ai/v3`, `Authorization: Bearer <token>`. Principals:
  service-user `cog_` key (needs `ManageOrgSessions`), PAT, CLI session token.
- `GET /v3/self` → union incl. `WindsurfSessionUserSelf{org_id}` (required).
- `POST /v3/organizations/{org_id}/sessions` — `SessionCreateRequest`:
  `prompt` (required), `repos` (`["owner/repo"]`), `title`, `tags`,
  `attachment_urls`, `devin_mode` (`normal|fast|lite|ultra|fusion` only —
  **no `model` field**; live sessions report `swe-2-*` modes the schema
  doesn't document, so offer documented values or omit for org default),
  `max_acu_limit`, `platform`, `playbook_id`, `resumable` (default true —
  keep: preserves VM for resume), `bypass_approval`,
  `structured_output_required` (**default true — pass `false`** so chat
  sessions aren't forced into structured output), `structured_output_schema`,
  `secret_ids`, `knowledge_ids`, `session_links`, `session_secrets`,
  `create_as_user_id` (needs `ImpersonateOrgSessions` — skip),
  `security_profile`, `child_playbook_id`.
- `POST …/sessions/{devin_id}/messages` — `{message, attachment_urls?}`;
  auto-resumes suspended sessions.
- `GET …/sessions/{devin_id}` — `SessionResponse`: `session_id` (bare uuid —
  **path params take the `devin-` prefixed id**), `url`, `status`
  (`new|claimed|resuming` = queued, `running`, `suspended`, `exit`, `error`),
  `status_detail` (`working|waiting_for_user|waiting_for_approval|finished|
inactivity|…`), `pull_requests[{pr_url,pr_state}]`, `structured_output`,
  `title`, `acus_consumed`, `tags`, `child_session_ids`, `is_archived`,
  `devin_mode`.
- `GET …/messages` — `first`≤200 + opaque `after`/`end_cursor` (nullable!),
  chronological; `SessionMessage{event_id, source:devin|user, message,
created_at, origin?, user_id?, username?}`. **Text only — no tool-call
  stream, no SSE/webhook.**
- `POST /v3/organizations/{org}/attachments` — multipart field `file` →
  `AttachmentResponse{attachment_id, name, url}`; pass `url` in
  `attachment_urls`.
- `DELETE …/sessions/{devin_id}` — terminate; `POST …/archive` — sleeps.
  **No suspend endpoint.**
- `GET …/sessions?qs=` list (paginated) — not needed for v1.
- 429 on all endpoints → backoff; 4xx non-429 → never retry.

### Devin CLI cloud surface

- `devin acp` on stable = local ACP server over stdio. Flags today:
  `--model`, `--agent-type`, `--refusal-fallback`.
- Changelog records `devin acp --cloud` ("relays the ACP connection to Devin
  cloud") — marked **(insiders)**; absent in stable.
- `/handoff` is GA; `devin ssh`/`devin forward` reach cloud-session boxes.
- Detection: run `devin acp --help` once via `ChildProcessSpawner`, regex
  `/--cloud\b/` on stdout+stderr; cache per resolved binary path + mtime.

### Synara integration points (verified in-tree)

- `ProviderKind` (`orchestration.ts`) literals; `ProviderDiscoveryKind` is a
  separate literal in `providerDiscovery.ts` (also types
  `ProviderComposerCapabilities.provider`).
- `ProviderAdapterShape` (Services/ProviderAdapter.ts) — **required**:
  `provider`, `capabilities`, `startSession`, `sendTurn`, `interruptTurn`,
  `respondToRequest`, `respondToUserInput`, `stopSession` (idempotent cleanup
  barrier), `listSessions`, `hasSession`, `readThread`, `rollbackThread`,
  `stopAll`, `streamEvents`. **Optional**: `steerTurn`, `readExternalThread`,
  `didResumeSession`, `compactThread`, `forkThread` (omitting →
  conversation-history fork), `prepareSessionReplacement`,
  `getComposerCapabilities`, `list*`, `stopTask`, `backgroundTask`,
  `steerSubagent`, `startReview`, voice.
- `DevinAdapter` wraps `AcpSessionRuntime` + `DevinAcpSupport`
  (`buildDevinAcpSpawnInput` → `[binary,"acp","--model"?]`). Resume via
  `resumeCursor{schemaVersion, sessionId}` → ACP `session/load`. Events via
  `PubSub.bounded(PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY=2048)` →
  `Stream.fromPubSub`; `makeEventStamp` mints `eventId`/`createdAt`; item ids
  scoped per turn.
- Secret precedent: opencode `serverPassword` — write-only in
  `ServerSettingsPatch`, stripped by `omitProviderPasswords`, extracted by
  `readLegacyProviderPasswords`, stored via `ProviderCredentials` →
  `provider-{provider}-server-password`, view exposes `serverPasswordConfigured`.
  `EXTERNAL_SERVER_PROVIDERS=["opencode"]`; `ExternalProviderServer="opencode"`.
  **The field name `serverPassword` is hardcoded at every stage** — reuse it.
- `ProviderHealth.ts`: `makeCheckDevinProviderStatus` template;
  `getProviderBinaryPath` is an exhaustive `switch` (needs `devinCloud` case);
  `isProviderEnabledForSettings` reads `providers[p]?.enabled !== false`
  (works automatically once the settings key exists);
  `PACKAGE_MANAGED_PROVIDER_UPDATES` is `Partial<Record>` — no entry needed;
  `providerCommandEnv(provider)` is generic.
- Repo → `repos`: `pullRequests/repositoryResolution.ts`
  `resolveGitHubRepositories(git, cwd)` → `nameWithOwner`.
- `ServerConfig` service (`apps/server/src/config.ts`) provides
  `attachmentsDir`/`cwd`/`homeDir` — adapters pull via
  `Effect.service(ServerConfig)` (DevinAdapter/OpenCodeAdapter pattern).
- Attachment bytes: `resolveProviderAttachmentPath({attachmentsDir,
attachment})` from `providerAttachmentPaths.ts` (`ChatAttachment` is
  metadata only: `{type,id,name,mimeType,sizeBytes}`).
- Outbound HTTP: `@synara/shared/outboundHttp` `outboundHttp.request` —
  pinned SSRF-safe bounded transport (service, allowedOrigins, timeouts,
  byte caps, maxConcurrent). `fetchJson` in providerUsage only wraps
  GET/POST json|form with `maxRequestBytes:64KB` — too small for uploads;
  call `outboundHttp` directly.
- `importThreadRoute.ts` `resolveImportedProviderThreadContext` provider
  union hardcoded `"codex"|"droid"|"opencode"` — powers external-id import
  via `readExternalThread`.
- `DEFAULT_PROVIDER_ORDER` derives from `PROVIDER_DESCRIPTORS` — picker order
  automatic. `PROVIDER_ICON_COMPONENT_BY_PROVIDER: Record<ProviderKind>` —
  add `devinCloud: DevinIcon`.
- Settings UI `ProvidersSettingsPanel.tsx` field kinds:
  `text|password|boolean` only — `mode` needs a new `kind:"select"` variant
  (extend `ProviderInstallField`) or a validated text field; closed unions
  `ProviderInstallTextKey`/`PasswordKey`/`ConfiguredKey`/`BooleanKey` to
  extend.
- Event vocabulary (`providerRuntime.ts`): `session.started` `{message?,
resume?}`, `session.configured` `{config}`, `session.state.changed`
  `{state: RuntimeSessionState(starting|ready|running|waiting|stopped|error),
reason?}`, `session.exited` `{reason?, recoverable?, exitKind?}`,
  `thread.started` `{providerThreadId?}`, `turn.started|completed|aborted`,
  `item.started|updated|completed` `{itemType, detail?, data?, title?,
status?}` (`assistant_message` items carry text in `detail` — verified in
  OpenCodeAdapter tests), `content.delta` `{streamKind, delta}`,
  `request.opened|resolved`, `runtime.warning`, `runtime.error`,
  `config.warning`, `auth.status`. Event base: `eventId`, `provider`,
  `threadId`, `createdAt`, optional `turnId/itemId/requestId/
lifecycleGeneration/providerRefs/raw`.
- **Two status vocabularies**: `ProviderSession.status` =
  connecting|ready|running|error|closed; `session.state.changed` payload =
  RuntimeSessionState (starting|ready|running|waiting|stopped|error).
  Map: `new|claimed|resuming` → connecting/starting; `running` → running;
  `suspended` → ready/waiting; `exit` → closed/stopped; `error` → error.

## Architecture

One new provider kind `devinCloud` ("Devin Cloud" in the picker). One
`DevinCloudAdapter` implementing `ProviderAdapterShape`; per `startSession`
it delegates to a `DevinCloudTransport` selected by:

```
settings.providers.devinCloud.mode: "auto" | "acp" | "rest"  (default "auto")

auto:  probeAcpCloudSupport(resolvedBinary) ─yes→ AcpCloudTransport
          └no→ REST credential resolves (stored secret → env →
               credentials.toml) AND orgId resolvable (override or /v3/self)
               ─yes→ RestCloudTransport
                 └no→ fail with actionable ProviderAdapterRequestError
                      ("run `devin auth login` or set an API key")
```

`mode: acp|rest` forces one transport for debugging.

### Transport A — ACP (`devin acp --cloud`)

- `DevinAcpSupport.buildDevinAcpSpawnInput` gains `cloud?: boolean` →
  `args=["acp","--cloud","--model"?,...]`. All downstream code (auth,
  permission prompts, event projection, resumeCursor, wedge recovery)
  unchanged — the subprocess relays to the cloud.
- Capabilities: same as local Devin IF the cloud relay honors them —
  unverifiable today.
- **Defensive fallback**: if spawn/init fails with a usage/insiders-class
  error despite the probe (arg ordering, partial rollout), auto-fall-back to
  REST rather than surfacing the error verbatim.
- Open risks until the flag ships: `session/load` on cloud ids, `--model`
  semantics vs `devin_mode`, permission-prompt behavior.

### Transport B — REST

New files under `apps/server/src/provider/devinCloud/`:

- `DevinRestClient.ts` — typed client over `outboundHttp.request` (policy:
  `service:"devin-cloud"`, `allowedOrigins:["https://api.devin.ai"]`, per-call
  `timeoutMs`, larger `maxRequestBytes` for uploads). Methods:
  `createSession`, `sendMessage`, `getSession`, `listMessages`,
  `uploadAttachment`, `terminateSession` (explicit only), `getSelf`.
  Effect-Schema decoders; `ProblemDetail` → `ProviderAdapterRequestError`
  (never echo tokens); retry 429/5xx with backoff + `Retry-After`.
- `DevinCloudRestTransport.ts`:
  - `startSession`: if `resumeCursor.sessionId` validates → attach (no POST),
    hydrate, resume polling, `didResumeSession` true. Else resolve `repos`
    from `input.cwd` via `resolveGitHubRepositories` (best-effort; on a
    create error mentioning the repo retry once without `repos` — remote may
    not be connected to the org's git integration) → `POST sessions
{prompt, repos?, title, devin_mode: mode-or-omit, tags:["synara",
threadId], bypass_approval, structured_output_required:false,
resumable:true}` → `resumeCursor={schemaVersion:1, sessionId}`.
  - `sendTurn`/`steerTurn`: mint `TurnId`, POST `messages` (attachments →
    `POST /attachments` → `attachment_urls`), return
    `ProviderTurnStartResult` immediately. Mid-run POSTs steer Devin →
    `supportsTurnSteering:true`. On terminal session (exit/error) fail
    visibly — never silently create a replacement.
  - `interruptTurn`/`stopSession`/`stopAll`: **never DELETE implicitly** —
    close local turn/poller/scope only; the cloud session idles out.
    DELETE reserved for an explicit user terminate (v1 may omit it).
  - `respondToRequest`/`respondToUserInput` (required): fail with a link-out
    error (`waiting_for_approval` already surfaces a notice item + `url`).
  - `rollbackThread` (required): fail `ProviderAdapterRequestError` — no
    cloud-side rewind. `forkThread`/`compactThread` omitted.
  - `readThread`/`readExternalThread`: paginate ALL messages → synthesized
    turns (user + assistant items incl. `source:user`).
  - Poller fiber per live thread (session `Scope`): each tick `GET session`
    (status/status_detail/pull_requests/acus) + `GET messages`(`after`,
    pages until `has_next_page=false`). Adaptive: ~1.5 s while
    `status_detail=working`, up to ~15 s idle; persistent failures →
    `runtime.warning`, keep polling; 404 → `session.exited` + stop.
  - Dedup: bounded in-memory `event_id` seen-set (`end_cursor` nullable →
    don't trust it); live poll SKIPS `source:user` entirely (own echoes and
    webapp input); hydration includes them.

### Turn/state/event semantics (REST)

- One open turn per thread; poller attributes new `source:devin` messages to
  it. Turn completes when `status_detail` ∈ {waiting_for_user, finished,
  inactivity} or `status` ∈ {exit,error}; interrupt → `turn.aborted`.
- Per devin message → `item.completed` `{itemType:"assistant_message",
detail:<text>}` with `itemId=RuntimeItemId("devincloud:<event_id>")`.
  `pull_requests`/`session.url` → notice/link items; `providerRefs` carries
  `{sessionId, url}`.
- Emit minimum set: `session.started`(resume flag on attach),
  `session.configured`, `session.state.changed`, `session.exited`,
  `thread.started`(`providerThreadId`=session id), `turn.*`, `item.*`,
  `runtime.warning`/`error`, `config.warning`, `auth.status`.
- `bypass_approval` ← `runtimeMode`/`approvalPolicy`: full-access → true;
  approval-required → false + link-out when `waiting_for_approval` appears.
- `skills`/`mentions`/`assistant-selection` attachments flatten into prompt
  text (`attachmentProjection` helpers); `interactionMode:"plan"` →
  prompt-prefix emulation or `config.warning` (no cloud plan mode).
- `ProviderSession` echoes `runtimeMode` (required) + `resumeCursor`.

### Credentials & settings

REST auth precedence (all optional):

1. `serverPassword` stored secret (settings override — headless/service
   accounts; **field name must literally be `serverPassword`** — the whole
   pipeline is hardcoded to it; UI label says "API key")
2. `WINDSURF_API_KEY` / `DEVIN_API_KEY` env (`getDevinApiKeyEnv`)
3. `credentials.toml` via `readDevinStoredCredentials` — re-read per
   `startSession` (tokens rotate); 401 → `auth.status` + re-login guidance.

`orgId`: settings override → `GET /v3/self` once per token (cache).

- `contracts/settings.ts`: `DevinCloudServerProviderSettings` =
  `ProviderSettingsBase` + `binaryPath` default `"devin"` (probe only) +
  `mode` (`auto|acp|rest`, default auto) + `orgId` (optional) +
  `serverPasswordConfigured` (view-only bool). Patch: write-only
  `serverPassword` + `mode`/`orgId`/`binaryPath`.
- `serverSettings.ts`: `"devinCloud"` in `EXTERNAL_SERVER_PROVIDERS`;
  `omitProviderPasswords` + `readLegacyProviderPasswords` extended;
  `ExternalProviderServer` union +1 → `provider-devinCloud-server-password`;
  configured map + view field.
- `appSettings.ts`: `devinCloudMode`, `devinCloudOrgId`,
  `devinCloudServerPassword` + `devinCloudServerPasswordConfigured`,
  `devinCloudBinaryPath` (+ patch-key whitelist entries).
- `ProvidersSettingsPanel.tsx`: `devinCloud` entry — docs links,
  binaryPath text field, mode **select** (new field kind or validated text),
  orgId text, api-key password field; instructions: _"Optional — used only
  when `devin auth login` credentials are unavailable. Paste an API key
  (service-user keys start with cog\_, need ManageOrgSessions; CLI login
  tokens also work). Org id is auto-discovered via /v3/self; set only to
  override."_
- `providerMetadata.ts`: descriptor `kind:"devinCloud"`, displayName "Devin
  Cloud", `available:true`, `supportsNativeTurnSteering:false` (dynamic —
  safest), `usage{signInCommand:"devin auth login",
learnMoreHref:"https://app.devin.ai/usage"}`; `setupDocsHref` →
  docs.devin.ai (no trysynara page exists — do not invent one).

### Contracts surface

- `orchestration.ts`: `"devinCloud"` in `ProviderKind`; `providerDiscovery.ts`:
  same literal. `DevinCloudModelSelection` (`{provider:"devinCloud", model,
options?}`) in `ModelSelection`; `DevinCloudModelOptions{mode}` in
  `ProviderModelOptions`; `DevinCloudProviderStartOptions{binaryPath?}` in
  `ProviderStartOptions`.
- `model.ts` forced entries: `MODEL_OPTIONS_BY_PROVIDER.devinCloud` =
  devin_mode variants (org-default/normal/fast/lite/ultra/fusion),
  `MODEL_SLUG_ALIASES_BY_PROVIDER`, `PROVIDER_DISPLAY_NAMES` ("Devin Cloud"),
  `DEFAULT_MODEL_BY_PROVIDER` (ProviderWithDefaultModel excludes only `pi`);
  `packages/shared/model.ts` `MODEL_SLUG_SET_BY_PROVIDER`.
- No `LEGACY_PROVIDER_MIGRATIONS` entry (new kind, no history).
- Remaining `ProviderKind` switches surface via `bun run typecheck`:
  `ProviderHealth` (`makeCheckDevinCloudProviderStatus` — flag probe +
  credential resolution → authStatus/authLabel, local checks only),
  `getProviderBinaryPath` case, composer registry, usage registry (v1 skip;
  `acus_consumed` per-session is already surfaced).

## Edge-case register

- Terminal session (`exit`/`error`): `sendTurn` fails visibly; poller stops;
  `session.exited` emitted. 404 mid-poll → same.
- Cursor loss/restart: `resumeCursor.sessionId` → re-attach + full re-hydrate
  (idempotent via seen-set); no messageCursor persistence needed.
- `waiting_for_approval`: notice item + session URL; `respondToRequest`
  fails with link-out.
- External edits (webapp/Slack messages into the session): skipped live,
  included on hydration — transcript stays consistent.
- Concurrent Synara clients share the one adapter instance/poller; thread
  delete/archive closes the fiber only.
- `suspended` mid-flow: auto-resumes on next POST.
- ACU: org billing applies; `acus_consumed` shown per session; sessions keep
  running after Synara closes — the URL link-out is the kill-switch surface.

## Optional surfaces (v2 candidates)

- Import-by-id: extend `importThreadRoute` union + `supportsThreadImport:true`
  → attach any Devin Cloud session (webapp/Slack-started) as a thread.
- `startReview` → v3 review endpoints (`github:pull_request_review`).
- `GET sessions?qs=` → "attach existing session" picker.
- `max_acu_limit` guardrail setting; `prepareSessionReplacement` for
  mid-thread mode switch (restart-session).
- devinCloud usage fetcher reusing `providerUsage/providers/devin.ts` creds.

## Build order

1. Contracts: ProviderKind/discovery/model-selection/settings types →
   `bun run typecheck` to enumerate every forced touchpoint; minimal no-op
   entries (icon, descriptor, picker) to green.
2. `DevinRestClient` + REST transport + adapter (`mode:"rest"` first — works
   today). Unit tests: decoders, pagination/dedup, status→turn mapping,
   error mapping, resumeCursor round-trip.
3. Settings storage + UI fields + instructions.
4. ACP transport: probe + `cloud` arg + selection logic; tests for probe
   parsing/arg construction + spawn-failure fallback.
5. `ProviderHealth` devinCloud status.
6. Isolated verify per `.claude/skills/verify` — REST path verifiable today
   with this machine's `devin auth login` credentials (already probed
   end-to-end: create/messages/terminate all 200).

## Verification

- `bun run fmt:check && bun run lint && bun run typecheck`
- `bun run test` (provider discovery/health/settings are cross-cutting);
  scoped: `bun run --cwd apps/server test DevinCloud`
- `bun run windows-runtime:check` (probe spawns a process)
- Manual: settings UI fields + instructions; REST session creates, streams,
  steers, links out; ACP auto-selected only on an insiders build.

## Risks / open questions

- `devin acp --cloud` insiders gate — absent in stable 3000.10.31; probe +
  spawn-failure fallback handle it.
- CLI token lifetime unknown — re-read `credentials.toml` per `startSession`;
  `cog_` keys are the durable headless alternative.
- Cloud `session/load` semantics unknown → ACP resume may fail when the flag
  lands; REST-path resume already works via re-attach.
- REST transcript is message-level only — dispatch+monitor UX; the session
  URL link-out covers deep inspection/approvals.
- `repos` requires org git-provider connectivity — best-effort + retry
  without.
- REST serves org users via CLI token (verified); truly org-less personal
  tokens would be ACP-only — `org_id` is required on the self schema, so
  this edge is likely empty.
