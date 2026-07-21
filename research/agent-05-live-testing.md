# Agent 5: Live Compaction Testing Feasibility

Scope: what live end-to-end compaction testing of Synara's provider adapters is possible today, given the keys available in this session, and exact recipes for when keys become available.

Environment note: none of the provider CLIs (`grok`, `codex`, `opencode`, `claude`, `droid`, `pi`, `cursor-agent`, `agy`, `kilo`) were installed on this research box, so recipes below are derived from the adapter source (`apps/server/src/provider/Layers/*.ts`), `ProviderHealth.ts` install metadata, and upstream CLI docs. Each recipe includes the install command so it is directly runnable.

## 1. Current secrets (presence only)

| Secret | Present | Relevant to compaction testing |
| --- | --- | --- |
| `OPENCODE_GO_API_KEY` | yes | yes — OpenCode Zen endpoint (see §3) |
| `GITHUB_TOKEN` | yes | no (git operations only) |
| `CRATES_IO_TOKEN` | yes | no |
| `windsurf_api_key` | yes | no (Devin CLI only; must not be used elsewhere) |
| `XAI_API_KEY` | **no** | needed for Grok |
| `OPENAI_API_KEY` | **no** | needed for Codex (API-key mode; ChatGPT login is the alternative) |
| `ANTHROPIC_API_KEY` | **no** | needed for Claude Code (or `claude` subscription login) |
| `PI_API_KEY` | **no** | needed for Pi |
| `DROID_API_KEY` | **no** | needed for Droid (compaction unsupported via ACP anyway) |
| `CURSOR_API_KEY` | **no** | Cursor has no compaction support in Synara |

## 2. Provider-specific live test recipes

Compaction support in Synara (from adapter source):

- **Manual compaction RPC (`compactThread`, `supportsThreadCompaction: true`)**: Codex, Grok, OpenCode, Kilo (OpenCodeAdapter family), Pi.
- **Auto-compaction only**: Claude (`autoCompactEnabled: true` + `autoCompactWindow` budget; `supportsThreadCompaction: false`), Codex (`compactsAutomatically: true`).
- **No compaction**: Droid (ACP exposes no compaction RPC; TUI-only `/compact`), Cursor, Antigravity.

All recipes assume the isolated harness in §5 and that you drive Synara's server RPC `thread/compact` (or the equivalent adapter method) from the web UI or a WebSocket client.

### 2.1 Codex (`codex`)

- Install: `npm i -g @openai/codex` (binary `codex`).
- Auth: `OPENAI_API_KEY=<key>` env, or `codex login` (ChatGPT plan).
- Synara path: `CodexAdapter.compactThread` → `codexAppServerManager.compactThread` → app-server `thread/compact/start`. Progress arrives as `thread/compacting` (item `context_compaction`, detail "Compacting context") then `thread/compacted` → thread state `compacted`.
- Manual (standalone CLI sanity check): start `codex` TUI in a scratch repo and issue `/compact`; or via app-server:
  ```bash
  codex app-server   # then send JSON-RPC: {"method":"thread/compact/start","params":{"threadId":"..."}}
  ```
- Manual (through Synara): start a Codex thread in the isolated instance, send one short turn, then trigger compaction from the thread menu (calls `compactThread`). Expected signature: `item.updated` with `itemType: "context_compaction"` then `thread.state.changed` → `"compacted"` in the ACP/native event log.
- Auto: Codex reports `compactsAutomatically: true`. Force by filling context: paste a large file repeatedly (e.g. `find . -name '*.ts' | xargs cat` output split into prompts, or one prompt containing ~200k tokens of lorem text) until the app-server emits `thread/compacting` without a manual request.

### 2.2 Claude Code (`claude`)

- Install: `npm i -g @anthropic-ai/claude-code`.
- Auth: `ANTHROPIC_API_KEY=<key>` or `claude` interactive login.
- Synara path: no manual RPC. `ClaudeAdapter` passes `autoCompactEnabled: true` and an optional `autoCompactWindow` (token budget from model options, "Auto-compact" selector in Settings). Compaction shows as SDK `compact_boundary` message → thread state `compacted`; during compaction status `compacting` maps to a `waiting` turn state.
- Force auto-compaction cheaply: pick the smallest `autoCompactWindow` option for the model in the thread's model settings, then send a few prompts each containing a large pasted file (tens of thousands of tokens). Watch for `compact_boundary` in the transcript log.
- Standalone check: `claude` TUI supports `/compact` manually, but that path is not what Synara exercises; prefer the auto path above.

### 2.3 Grok (`grok`)

- Install: xAI Grok CLI (binary `grok`; Synara health check runs `grok models`).
- Auth: `XAI_API_KEY=<key>` env, or `grok` interactive login.
- Synara path: `GrokAdapter.compactThread` sends the literal prompt `"/compact"` (`GROK_COMPACT_PROMPT`) to the CLI child, guarded by `compactingThread` (rejects concurrent sends), a hard timeout (`GROK_COMPACT_TIMEOUT_MS`), and a post-timeout quiet window (`GROK_COMPACT_ABANDON_QUIET_MS = 5s`). A failed compaction tool-call is recorded (`compactionFailedToolDetail`) so a "successful" `/compact` response with a failed tool is not persisted as compacted.
- Manual: start a Grok thread, send 1–2 turns, trigger compaction. Expected: single `context_compaction` item then state `compacted`; failure surfaces as a failed tool detail rather than a compacted state.
- Auto: no auto-compaction path in the adapter; between-turn compaction updates from the CLI are attributed carefully but Synara does not force them — treat auto as untestable/deterministic-manual-only.

### 2.4 OpenCode / Kilo (`opencode`, `kilo`)

- Install: `npm i -g opencode-ai` (or `kilo` via `@kilocode/cli`; both use `OpenCodeAdapter`).
- Auth: `opencode auth login` or provider key env; for the hosted Zen endpoint, `OPENCODE_API_KEY` / the Go key (see §3).
- Synara path: `compactThread` calls SDK `session.summarize` with the current `provider/model` slug (errors if the thread has no `provider/model` selection). Events: `session.compacted` → state `compacted`; streamed message parts with `part.type === "compaction"` emit `context_compaction` progress, with `overflow: true` producing detail "Compacting context after provider context overflow" and `auto` flagging auto-compaction.
- Manual: start an OpenCode thread on e.g. `opencode/gpt-5.4`, send one turn, trigger compaction. Standalone: in the `opencode` TUI run `/compact` (alias `/summarize`).
- Auto: exceed the model's context (paste very large inputs) until a `compaction` part arrives with `auto: true` / `overflow: true` — this is the only adapter that distinguishes overflow-driven compaction, so it is the best target for auto-compaction verification.

### 2.5 Pi (`pi`)

- Install: `npm i -g @earendil-works/pi-coding-agent`.
- Auth: `PI_API_KEY`.
- Synara path: `PiAdapter.compactThread` → ACP `session.compact()`. Events `compaction_start` / `compaction_end` map to `context_compaction` items ("Compacting context" / "Context compacted").
- Manual: start a Pi thread, one short turn, trigger compaction; expect the start/end item pair. Auto: no adapter-forced auto path documented; test manual only.

### 2.6 Droid / Cursor / Antigravity

- `supportsThreadCompaction: false` for all three. Droid's TUI has `/compact` but the ACP bridge exposes no compaction RPC (comment at `DroidAdapter.ts:1941`); Cursor and Antigravity adapters contain no compaction handling at all. Nothing to live-test end-to-end through Synara.

## 3. What can be tested now with `OPENCODE_GO_API_KEY`

Tested against the OpenCode Zen OpenAI-compatible endpoint on 2026-07-21:

- `GET https://opencode.ai/zen/v1/models` — returns the model list (endpoint is public; returns 200 even without auth). `gpt-5.4`-family and `claude-*` models are listed.
- `POST /zen/v1/chat/completions` with `model: "gpt-5.4"` and the key — **fails with HTTP 401 `CreditsError: "Insufficient balance"`** (workspace `wrk_01KG0AV4VVG9H2CXDKQHAAZ29D`).

Conclusion: the rotated key **authenticates** (the API resolves it to a workspace) but the workspace has **no credit**, so no live completion — and therefore no live compaction run — is possible with it today, for `gpt-5.4` or any other model. Topping up the workspace balance would immediately unlock the full OpenCode recipe in §2.4, which is the highest-value live test (only adapter with explicit auto/overflow compaction signals).

## 4. What needs new keys

| Provider | Blocker |
| --- | --- |
| Codex | `OPENAI_API_KEY` or interactive `codex login` (ChatGPT plan) |
| Claude | `ANTHROPIC_API_KEY` or interactive `claude` login |
| Grok | `XAI_API_KEY` or interactive `grok` login |
| OpenCode/Kilo | credit top-up on the existing Zen workspace, or any provider key `opencode auth` accepts |
| Pi | `PI_API_KEY` |
| Droid | `DROID_API_KEY` — but compaction is unsupported via ACP regardless |
| Cursor | n/a — no compaction support |
| Antigravity | n/a — no compaction support |

## 5. Safe test harness

Follow the repo's Local Dev Instance Isolation rules (AGENTS.md):

```bash
# dry-run first to confirm no port collisions
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 bun run dev -- \
  --home-dir ./.synara-compaction-test --port 58090 --dry-run

# real run
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 SYNARA_NO_BROWSER=1 bun run dev -- \
  --home-dir ./.synara-compaction-test --port 58090
```

- Never start plain `bun run dev` while the user's instance is running.
- Unset `SYNARA_AUTH_TOKEN` so the dev browser WebSocket is not rejected.
- Verify ports with `lsof -nP -iTCP:58090 -sTCP:LISTEN` (check both IPv4 and IPv6 binds).
- Isolated state lives under `./.synara-compaction-test` (own `state.sqlite`), so test threads never touch the user's history.

Capturing transcripts/logs for post-hoc verification:

- The isolated home dir's `state.sqlite` records thread events; query the native event log for `item.updated` rows with `itemType = 'context_compaction'` and `thread.state.changed` rows with `state = 'compacted'`.
- Provider child-process traffic (Codex app-server JSON-RPC, ACP stdio for Grok/Pi/Droid) can be captured by pointing the provider `binaryPath` setting at a small wrapper script that tees stdin/stdout to a log file before exec'ing the real binary.
- If the UI shows no threads, probe `orchestration.getSnapshot` over the WebSocket before assuming state loss.

## 6. Test matrix

| Provider | Manual compaction | Auto compaction | Key status today | Live-testable today |
| --- | --- | --- | --- | --- |
| Codex | yes (`thread/compact/start`) | yes (`compactsAutomatically`) | missing (`OPENAI_API_KEY`) | no |
| Claude | no (auto-only) | yes (`autoCompactWindow` budget) | missing (`ANTHROPIC_API_KEY`) | no |
| Grok | yes (`/compact` prompt) | no | missing (`XAI_API_KEY`) | no |
| OpenCode | yes (`session.summarize`) | yes (`compaction` part, `overflow`) | key valid, **zero credit** | no (needs top-up) |
| Kilo | yes (same adapter) | yes (same adapter) | none | no |
| Pi | yes (`session.compact`) | no | missing (`PI_API_KEY`) | no |
| Droid | unsupported (ACP) | unsupported | missing (moot) | no |
| Cursor | unsupported | unsupported | missing (moot) | no |
| Antigravity | unsupported | unsupported | n/a | no |

**Bottom line:** no provider is live-testable today. The cheapest path to a first live compaction test is topping up the OpenCode Zen workspace (key already works); the next-best is providing `XAI_API_KEY` (Grok's manual `/compact` path is the most self-contained adapter flow) or `OPENAI_API_KEY` (Codex covers both manual and auto).
