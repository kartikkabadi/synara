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

port_in_use() {
  local port=$1
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && { exec 3>&-; return 0; } || return 1
  fi
}

free_port() {
  bun -e 'const s = Bun.listen({hostname: "127.0.0.1", port: 0, socket: {data(){}}}); console.log(s.port); s.stop();'
}

# Ports: honor explicit env overrides but never kill an unknown listener —
# fail with diagnostics instead. Without overrides, allocate free ports.
if [[ -n "${SYNARA_E2E_PORT:-}" ]]; then
  SERVER_PORT="$SYNARA_E2E_PORT"
  if port_in_use "$SERVER_PORT"; then
    echo "error: SYNARA_E2E_PORT=$SERVER_PORT is already in use; refusing to kill the listener. Free the port or unset SYNARA_E2E_PORT." >&2
    exit 1
  fi
else
  SERVER_PORT="$(free_port)"
fi
if [[ -n "${SYNARA_E2E_WEB_PORT:-}" ]]; then
  WEB_PORT="$SYNARA_E2E_WEB_PORT"
  if port_in_use "$WEB_PORT"; then
    echo "error: SYNARA_E2E_WEB_PORT=$WEB_PORT is already in use; refusing to kill the listener. Free the port or unset SYNARA_E2E_WEB_PORT." >&2
    exit 1
  fi
else
  WEB_PORT="$(free_port)"
fi

SYNARA_HOME_DIR="$HERE/.synara-home-$$"
ARTIFACT_DIR="$HERE/artifacts/$(date +%Y%m%d-%H%M%S)"
SERVER_LOG="$HERE/server.log"
WEB_LOG="$HERE/web.log"

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

# Fail closed: never adopt a pre-existing path. Ownership is established only
# by creating the path ourselves in this run (WORKSPACE_OWNED), never inferred
# from markers inside an existing directory — cleanup does rm -rf.
WORKSPACE_OWNED=""
if [[ -e "$WORKSPACE_LINK" || -L "$WORKSPACE_LINK" ]]; then
  echo "error: workspace path $WORKSPACE_LINK already exists; refusing to reuse or overwrite it. Choose an unused SYNARA_E2E_WORKSPACE_NAME." >&2
  exit 1
fi
if [[ -n "${SYNARA_E2E_WORKSPACE:-}" ]]; then
  ln -s "$SYNARA_E2E_WORKSPACE" "$WORKSPACE_LINK"
  WORKSPACE_OWNED="link"
else
  mkdir "$WORKSPACE_LINK"
  WORKSPACE_OWNED="dir"
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
  if [[ "$WORKSPACE_OWNED" == "link" ]]; then
    rm -f "$WORKSPACE_LINK"
  elif [[ "$WORKSPACE_OWNED" == "dir" ]]; then
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

# Test hook: simulate a failure after workspace creation so the cleanup-safety
# regression test can prove trapped cleanup only removes run-owned paths.
if [[ -n "${SYNARA_E2E_FAIL_AFTER_WORKSPACE:-}" ]]; then
  echo "==> SYNARA_E2E_FAIL_AFTER_WORKSPACE set; simulating failure" >&2
  exit 1
fi

# Seed a project.created event before the server starts so the projection
# pipeline picks it up on boot and creates the "Home" project.
echo "==> seeding project.created event"
SYNARA_HOME="$SYNARA_HOME_DIR" bun "$HERE/seed-project.ts"

echo "==> starting server on :$SERVER_PORT (SYNARA_HOME=$SYNARA_HOME_DIR)"
(
  unset SYNARA_AUTH_TOKEN
  export SYNARA_HOME="$SYNARA_HOME_DIR"
  export SYNARA_PORT="$SERVER_PORT"
  export SYNARA_MODE=web
  export SYNARA_NO_BROWSER=1
  export SYNARA_LOG_PROVIDER_EVENTS=1
  export SYNARA_LOG_WS_EVENTS=1
  export VITE_DEV_SERVER_URL="http://localhost:$WEB_PORT"
  exec bun "$REPO_ROOT/apps/server/src/index.ts"
) >"$SERVER_LOG" 2>&1 &
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
