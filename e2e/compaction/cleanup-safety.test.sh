#!/usr/bin/env bash
# Regression test: run.sh must never delete a pre-existing workspace directory,
# and its trapped cleanup must only remove paths created by the run itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAKE_HOME="$(mktemp -d)"
BROWSERS_DIR="$(mktemp -d)"
trap 'rm -rf "$FAKE_HOME" "$BROWSERS_DIR"' EXIT

PASS=0
FAIL=0
check() {
  local name=$1 ok=$2
  if [[ "$ok" == "0" ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

run_harness() {
  env -i \
    HOME="$FAKE_HOME" \
    PATH="$PATH" \
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
    "$@" \
    bash "$HERE/run.sh"
}

# Case 1: a pre-existing directory with the requested workspace name must make
# the harness fail closed and leave the directory (and its contents) intact.
mkdir -p "$FAKE_HOME/Home/precious"
echo "user data" > "$FAKE_HOME/Home/precious/data.txt"
echo "user readme" > "$FAKE_HOME/Home/README.md"

set +e
run_harness SYNARA_E2E_WORKSPACE_NAME=Home >/dev/null 2>&1
STATUS=$?
set -e
check "refuses to reuse an existing workspace directory (exit != 0)" "$([[ $STATUS -ne 0 ]] && echo 0 || echo 1)"
check "pre-existing directory survives" "$([[ -d "$FAKE_HOME/Home" ]] && echo 0 || echo 1)"
check "pre-existing file contents survive" "$([[ "$(cat "$FAKE_HOME/Home/precious/data.txt")" == "user data" ]] && echo 0 || echo 1)"
check "pre-existing README untouched" "$([[ "$(cat "$FAKE_HOME/Home/README.md")" == "user readme" ]] && echo 0 || echo 1)"

# Case 2: trapped cleanup after a failure removes only the run-owned scratch
# workspace and leaves unrelated sibling directories intact.
set +e
run_harness SYNARA_E2E_WORKSPACE_NAME=scratch-e2e SYNARA_E2E_FAIL_AFTER_WORKSPACE=1 >/dev/null 2>&1
STATUS=$?
set -e
check "simulated failure exits non-zero" "$([[ $STATUS -ne 0 ]] && echo 0 || echo 1)"
check "run-owned scratch workspace is cleaned up" "$([[ ! -e "$FAKE_HOME/scratch-e2e" ]] && echo 0 || echo 1)"
check "unrelated pre-existing directory still survives" "$([[ -f "$FAKE_HOME/Home/precious/data.txt" ]] && echo 0 || echo 1)"

# Case 3: an explicitly requested port that is already in use must fail with
# diagnostics instead of killing the listener.
bun -e 'const s = Bun.listen({hostname: "127.0.0.1", port: 0, socket: {data(){}}}); console.log(s.port); setTimeout(() => s.stop(), 30_000);' > "$FAKE_HOME/port.txt" &
LISTENER_PID=$!
sleep 1
BUSY_PORT="$(cat "$FAKE_HOME/port.txt")"

set +e
run_harness SYNARA_E2E_WORKSPACE_NAME=scratch-e2e-port SYNARA_E2E_PORT="$BUSY_PORT" >/dev/null 2>&1
STATUS=$?
set -e
check "busy explicit port fails closed (exit != 0)" "$([[ $STATUS -ne 0 ]] && echo 0 || echo 1)"
check "existing listener is not killed" "$(kill -0 "$LISTENER_PID" 2>/dev/null && echo 0 || echo 1)"
kill "$LISTENER_PID" 2>/dev/null || true

echo
echo "cleanup-safety: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
