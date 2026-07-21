#!/usr/bin/env bash
# One-command real-provider compaction e2e harness.
# Boots an isolated Synara instance (own SYNARA_HOME, non-default ports),
# runs the Playwright suite in ./tests, and archives evidence on exit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# Local, gitignored overrides (provider keys etc.).
if [[ -f "$HERE/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HERE/.env"
  set +a
fi

SERVER_PORT="${SYNARA_E2E_PORT:-3899}"
WEB_PORT="${SYNARA_E2E_WEB_PORT:-5899}"
SYNARA_HOME_DIR="$HERE/.synara-home-$$"
ARTIFACT_DIR="$HERE/artifacts/$(date +%Y%m%d-%H%M%S)"
SERVER_LOG="$HERE/server.log"
WEB_LOG="$HERE/web.log"

# Free ports before starting — kill any process listening on them.
for port in "$SERVER_PORT" "$WEB_PORT"; do
  fuser -k "$port/tcp" 2>/dev/null || true
done

# OpenCode/Kilo accept both OPENCODE_API_KEY and OPENCODE_GO_API_KEY. Map
# the newest available key to both variables.
if [[ -n "${NEW_OPENCODE_GO_API_KEY:-}" ]]; then
  export OPENCODE_API_KEY="$NEW_OPENCODE_GO_API_KEY"
  export OPENCODE_GO_API_KEY="$NEW_OPENCODE_GO_API_KEY"
elif [[ -n "${OPENCODE_GO_API_KEY:-}" ]]; then
  export OPENCODE_API_KEY="$OPENCODE_GO_API_KEY"
fi
if [[ -z "${OPENAI_API_KEY:-}" && -n "${CODEX_API_KEY:-}" ]]; then
  export OPENAI_API_KEY="$CODEX_API_KEY"
fi

# Provider CLIs installed under ~/clis (e.g. opencode) must be visible to the
# server's health probes, which resolve binaries via PATH.
CLI_BIN_DIR="${SYNARA_E2E_CLI_BIN_DIR:-$HOME/clis/node_modules/.bin}"
if [[ -d "$CLI_BIN_DIR" ]]; then
  export PATH="$CLI_BIN_DIR:$PATH"
fi
# Dependencies.
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "==> bun install (repo root)"
  (cd "$REPO_ROOT" && bun install --ignore-scripts)
fi
if [[ ! -d "$HERE/node_modules" ]]; then
  echo "==> bun install (e2e/compaction)"
  (cd "$HERE" && bun install --ignore-scripts)
fi
if [[ ! -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" ]]; then
  echo "==> installing Playwright chromium"
  (cd "$HERE" && bunx playwright install chromium)
fi

# Workspace the tests open via the project picker. The picker lists top-level
# folders of $HOME (the isolated SYNARA_HOME's HOME stays the real one), so we
# create a scratch workspace at ~/<name> and seed the project with the same path.
WORKSPACE_NAME="${SYNARA_E2E_WORKSPACE_NAME:-synara-e2e-compaction-$$}"
WORKSPACE_LINK="$HOME/$WORKSPACE_NAME"
WORKSPACE_SENTINEL="$WORKSPACE_LINK/.synara-e2e-workspace"

if [[ -n "${SYNARA_E2E_WORKSPACE:-}" ]]; then
  ln -s "$SYNARA_E2E_WORKSPACE" "$WORKSPACE_LINK"
else
  mkdir -p "$WORKSPACE_LINK"
  if [[ ! -f "$WORKSPACE_SENTINEL" ]]; then
    touch "$WORKSPACE_SENTINEL"
  fi
  (cd "$WORKSPACE_LINK" && git init -q && echo "# scratch" > README.md && git add README.md && git -c user.email=e2e@synara.dev -c user.name=e2e commit -qm init || true)
fi

export SYNARA_E2E_WORKSPACE_ROOT="$WORKSPACE_LINK"

mkdir -p "$SYNARA_HOME_DIR/dev" "$ARTIFACT_DIR"

SERVER_PID=""
WEB_PID=""
cleanup() {
  local code=$?
  echo "==> cleaning up"
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [[ -n "$WORKSPACE_LINK" && -f "$WORKSPACE_LINK/.synara-e2e-workspace" ]]; then
    rm -rf "$WORKSPACE_LINK"
  fi
  mv "$SERVER_LOG" "$WEB_LOG" "$ARTIFACT_DIR/" 2>/dev/null || true
  [[ -d "$HERE/test-results" ]] && cp -R "$HERE/test-results" "$ARTIFACT_DIR/" 2>/dev/null || true
  if [[ -d "$SYNARA_HOME_DIR" ]]; then
    tar -czf "$ARTIFACT_DIR/synara-home.tar.gz" -C "$(dirname "$SYNARA_HOME_DIR")" "$(basename "$SYNARA_HOME_DIR")" 2>/dev/null || true
    rm -rf "$SYNARA_HOME_DIR"
  fi
  echo "==> artifacts: $ARTIFACT_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

# Seed a project.created event before the server starts so the projection
# pipeline picks it up on boot and creates the "Home" project.
echo "==> seeding project.created event"
SYNARA_HOME="$SYNARA_HOME_DIR" bun "$HERE/seed-project.ts"

echo "==> starting server on :$SERVER_PORT (SYNARA_HOME=$SYNARA_HOME_DIR)"
env -u SYNARA_AUTH_TOKEN \
  SYNARA_HOME="$SYNARA_HOME_DIR" \
  SYNARA_PORT="$SERVER_PORT" \
  SYNARA_MODE=web \
  SYNARA_NO_BROWSER=1 \
  VITE_DEV_SERVER_URL="http://localhost:$WEB_PORT" \
  bun "$REPO_ROOT/apps/server/src/index.ts" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

wait_for() {
  local url=$1 name=$2 tries=${3:-60}
  for _ in $(seq 1 "$tries"); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  echo "error: $name did not become ready at $url" >&2
  return 1
}

# The server may not expose /health; any HTTP response means it is up.
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$SERVER_PORT/health" || curl -s -o /dev/null "http://localhost:$SERVER_PORT/"; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "error: server exited early; see $SERVER_LOG" >&2
    exit 1
  fi
  sleep 1
done
echo "==> server ready"

echo "==> starting web dev server on :$WEB_PORT"
(cd "$REPO_ROOT/apps/web" && env PORT="$WEB_PORT" VITE_WS_URL="ws://localhost:$SERVER_PORT" bun run dev >"$WEB_LOG" 2>&1) &
WEB_PID=$!
wait_for "http://localhost:$WEB_PORT/" "web dev server" 90
echo "==> web ready"

echo "==> running Playwright suite"
set +e
(cd "$HERE" && env \
  SYNARA_E2E_WEB_PORT="$WEB_PORT" \
  SYNARA_E2E_PORT="$SERVER_PORT" \
  SYNARA_E2E_WORKSPACE_NAME="$WORKSPACE_NAME" \
  bunx playwright test)
STATUS=$?
set -e
exit "$STATUS"
