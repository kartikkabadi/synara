# Compaction e2e harness

One-command, real-provider end-to-end tests for context compaction. Boots an
isolated Synara instance (own `SYNARA_HOME`, non-default ports) and drives the
web UI with Playwright to verify compaction per provider.

## Prerequisites

- `bun` installed (repo toolchain).
- Provider API keys exported in your shell (see below). Providers without a
  key are skipped automatically and reported as skipped.
- Chromium for Playwright (the runner installs it on first run via
  `bunx playwright install chromium`).

## Run

```bash
./e2e/compaction/run.sh
```

That's it. The script:

1. Creates an isolated home dir at `e2e/compaction/.synara-home-<pid>`.
2. Picks non-default ports (server `3899`, web `5899`; override with
   `SYNARA_E2E_PORT` / `SYNARA_E2E_WEB_PORT`).
3. Runs `bun install --ignore-scripts` at the repo root if needed, and
   installs the harness deps (`@playwright/test`) in this directory.
4. Starts `apps/server` (`SYNARA_NO_BROWSER=1 SYNARA_MODE=web`) and the
   `apps/web` vite dev server, and waits for both to be ready.
5. Runs the Playwright suite in `tests/`.
6. On exit, kills both servers and archives logs, screenshots, traces, and
   the `SYNARA_HOME` into `e2e/compaction/artifacts/<timestamp>/`.

## Env vars

Copy `.env.example` and export what you have:

| Var                                           | Provider        |
| --------------------------------------------- | --------------- |
| `OPENAI_API_KEY` (or `CODEX_API_KEY`)         | Codex           |
| `ANTHROPIC_API_KEY`                           | Claude          |
| `XAI_API_KEY` (or `GROK_CODE_XAI_API_KEY`)    | Grok            |
| `OPENCODE_API_KEY` (or `OPENCODE_GO_API_KEY`) | OpenCode / Kilo |
| `PI_API_KEY`                                  | Pi              |

Options:

- `SYNARA_E2E_PROVIDERS` — comma-separated subset to test, e.g.
  `codex,grok`. Default: all known providers (missing keys skip).
- `SYNARA_E2E_HEADLESS` — `0` to watch the browser. Default headless.
- `SYNARA_E2E_WORKSPACE` — absolute path to use as the project workspace.
  Must be (or will be symlinked as) a top-level folder in the isolated
  `$HOME` so the project picker can see it. Default: a scratch git repo the
  runner creates.
- `SYNARA_E2E_PORT` / `SYNARA_E2E_WEB_PORT` — override ports.

## Adding a provider key

Export the env var before running (`export XAI_API_KEY=...`), or put it in a
local `.env` file next to this README (`run.sh` sources it if present — the
file is gitignored).

## What each test asserts

For every configured provider with a key present:

1. A project can be created/selected and a thread started with that provider
   (smallest-context model preferred where available).
2. Context is grown toward the compaction threshold (long pasted text), or
   `/compact` is sent from the composer for providers with manual compaction
   (Codex, Grok, OpenCode/Kilo, Pi).
3. The context window meter reflects a compaction state (provider-auto,
   synara-auto, or manual) with no error.
4. A `context_compaction` item (or compaction runtime-status activity)
   appears in the timeline.
5. The composer still works after compaction (a follow-up message round-trips).

Providers without compaction support (Cursor, Droid, Antigravity) instead
assert that `/compact` is not offered and the meter shows
"Compaction unavailable".

Claude has no manual compaction: its test asserts `/compact` is not offered
and relies on native auto-compaction.

## Expected outputs

- Console: per-provider pass/skip/fail summary from Playwright.
- `e2e/compaction/test-results/` — screenshots, traces, videos on failure.
- `e2e/compaction/artifacts/<timestamp>/` — `server.log`, `web.log`, the
  archived `SYNARA_HOME`, and the test-results copy.

## Safety notes

- Uses its own `SYNARA_HOME`; never touches `~/.synara`.
- Uses ports 3899/5899 (Synara's defaults are 3773/5733 plus a per-checkout
  offset), so it won't collide with a running dev instance.
- Real provider calls cost money; keep prompts small for expensive providers
  (the suite prefers `/compact` over context-stuffing where supported).
