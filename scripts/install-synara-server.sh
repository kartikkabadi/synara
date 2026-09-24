#!/usr/bin/env bash
# install-synara-server.sh — install the Synara headless server on a remote
# machine, then launch `synara setup` to configure remote access (Tailscale
# first, HTTPS proxy, or trusted LAN).
#
#   curl -fsSL https://raw.githubusercontent.com/Emanuele-web04/synara/main/scripts/install-synara-server.sh | bash
#   curl -fsSL ... | bash -s -- --yes --access tailscale
#
# Environment overrides:
#   SYNARA_REPO         GitHub repo to pull releases from (default: Emanuele-web04/synara)
#   SYNARA_VERSION      Server version to install (default: latest release tag)
#   SYNARA_INSTALL_DIR  Install root (default: ~/.synara-server)
#   SYNARA_NODE_VERSION Pinned Node fallback when system node is missing/old
#                       (default: 24.13.1; Synara needs ^22.19 || ^23.11 || >=24.10)
#   SYNARA_TARBALL      Install from a local synara-server-<ver>.tar.gz instead
#                       of downloading (offline installs, testing).
#   SYNARA_NO_SETUP=1   Install only — don't run the setup wizard.
#   SYNARA_ALLOW_ROOT=1 Allow running via sudo/as root (installs under root's
#                       home; the invoking user then can't manage it).

# POSIX-portable on purpose: this script is commonly run as `curl | sh` or
# `curl | bash`, where re-exec'ing `bash "$0"` breaks ($0 is the shell name,
# not a file, and the non-bash shell may already have buffered the stream).
# The only non-POSIX builtin used is pipefail — degrade gracefully on sh/dash.
set -eu
set -o pipefail 2>/dev/null || true

SYNARA_REPO="${SYNARA_REPO:-Emanuele-web04/synara}"
INSTALL_DIR="${SYNARA_INSTALL_DIR:-$HOME/.synara-server}"
NODE_VERSION="${SYNARA_NODE_VERSION:-24.13.1}"
# Required Node ranges (apps/server engines): ^22.19 || ^23.11 || >=24.10
MIN_NODE_REQ="^22.19 || ^23.11 || >=24.10"

log() { printf '%s\n' "$*" >&2; }
die() { log "install-synara-server: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

for tool in tar grep sed tail tr uname mktemp mkdir cp chmod rm mv id; do
  need "$tool"
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "need curl or wget to download artifacts"
fi

# `curl | sudo bash` resolves HOME to the calling user's ~ (or /var/root on
# macOS) — root-owned files then land in a home the real user can't write,
# and every later non-root `synara` invocation fails.
if [ "$(id -u)" = "0" ] && [ -z "${SYNARA_ALLOW_ROOT:-}" ]; then
  die "running as root installs under root's home — run without sudo as the user who will own the server (SYNARA_ALLOW_ROOT=1 to override)"
fi

# /dev/tty exists as a node even with no controlling terminal (ssh -T, cron,
# CI); test that it actually opens before redirecting prompts to it.
have_tty() { (exec 3</dev/tty) 2>/dev/null; }

fetch() { # fetch URL OUTFILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Linux) NODE_OS=linux ;;
  Darwin) NODE_OS=darwin ;;
  *) die "unsupported OS: $uname_s (the server tarball runs on Linux and macOS)" ;;
esac
case "$uname_m" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) die "unsupported architecture: $uname_m" ;;
esac

# Mirrors apps/server engines: ^22.19 || ^23.11 || >=24.10
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  local major minor
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  case "$major" in
    *[!0-9]*|"") return 1 ;;
  esac
  [ "$major" -gt 24 ] ||
    { [ "$major" -eq 24 ] && [ "$minor" -ge 10 ]; } ||
    { [ "$major" -eq 23 ] && [ "$minor" -ge 11 ]; } ||
    { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; }
}

# Debian/Ubuntu's `apt install nodejs` ships node without npm; npm is also
# absent from minimal distros and stripped toolchains. npm is required for
# deps, so node without npm doesn't count as usable.
npm_ok() {
  command -v npm >/dev/null 2>&1 || return 1
  npm --version >/dev/null 2>&1 || return 1
}

# --- Node ------------------------------------------------------------------
NODE_BIN=""
if node_ok && npm_ok; then
  NODE_BIN="$(command -v node)"
else
  if node_ok; then
    log "System node is new enough but npm is missing; installing pinned Node v${NODE_VERSION} (bundles npm)…"
  else
    log "Node.js ${MIN_NODE_REQ} not found; installing Node v${NODE_VERSION} for ${NODE_OS}-${NODE_ARCH}…"
  fi
  # musl (Alpine) can't exec the glibc tarball — fail clearly, not with
  # "No such file or directory" on a present binary.
  if [ "$NODE_OS" = "linux" ] && { [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }; then
    die "musl libc detected (Alpine) — install a musl Node build (apk add nodejs npm) or glibc-compat, then re-run"
  fi
  node_pkg="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz"
  node_base="https://nodejs.org/dist/v${NODE_VERSION}"
  mkdir -p "$INSTALL_DIR/.node"
  fetch "$node_base/$node_pkg" "$INSTALL_DIR/.node/$node_pkg" || die "Node.js download failed: $node_base/$node_pkg"
  fetch "$node_base/SHASUMS256.txt" "$INSTALL_DIR/.node/SHASUMS256.txt" || die "Node.js checksum list download failed: $node_base/SHASUMS256.txt"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$INSTALL_DIR/.node" && grep " $node_pkg\$" SHASUMS256.txt | shasum -a 256 -c -) ||
      die "Node.js checksum verification failed"
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$INSTALL_DIR/.node" && grep " $node_pkg\$" SHASUMS256.txt | sha256sum -c -) ||
      die "Node.js checksum verification failed"
  else
    log "warning: no sha256 tool found — skipping Node.js checksum verification"
  fi
  tar -xzf "$INSTALL_DIR/.node/$node_pkg" -C "$INSTALL_DIR/.node"
  rm -f "$INSTALL_DIR/.node/$node_pkg" "$INSTALL_DIR/.node/SHASUMS256.txt"
  NODE_BIN="$INSTALL_DIR/.node/node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}/bin/node"
  PATH="$(dirname "$NODE_BIN"):$PATH"
fi
log "Using node: $NODE_BIN ($("$NODE_BIN" -p 'process.version'))"

APP_DIR="$INSTALL_DIR/app"

if [ -n "${SYNARA_TARBALL:-}" ]; then
  [ -f "$SYNARA_TARBALL" ] || die "SYNARA_TARBALL does not exist: $SYNARA_TARBALL"
elif [ -z "${SYNARA_VERSION:-}" ]; then
  # releases/latest redirects to /releases/tag/<tag>; avoids the rate-limited API.
  if command -v curl >/dev/null 2>&1; then
    latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${SYNARA_REPO}/releases/latest" 2>/dev/null || true)"
  else
    latest_url="$(wget -q --server-response --spider --max-redirect=20 "https://github.com/${SYNARA_REPO}/releases/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | sed 's/ *\[following\].*$//' | tail -1 | tr -d '\r' || true)"
  fi
  SYNARA_VERSION="${latest_url##*/}"
fi
# Accept both `SYNARA_VERSION=1.2.3` and `=v1.2.3` — release tags carry the v,
# the tarball name doesn't.
SYNARA_VERSION="${SYNARA_VERSION:-}"
SYNARA_VERSION="${SYNARA_VERSION#v}"

# Re-running the installer on an existing install of the same version skips
# the download+deps entirely and goes straight to setup. The .install-complete
# marker (written last, below) plus a real dist/node_modules keeps a killed
# install from masquerading as complete.
if [ -x "$INSTALL_DIR/bin/synara" ] && [ -f "$APP_DIR/package.json" ] \
  && [ -f "$APP_DIR/.install-complete" ] && [ -f "$APP_DIR/dist/index.mjs" ] \
  && [ -d "$APP_DIR/node_modules" ] \
  && [ -z "${SYNARA_TARBALL:-}" ] && [ -n "${SYNARA_VERSION:-}" ]; then
  installed_version="$("$NODE_BIN" -p 'require("'"$APP_DIR"'/package.json").version' 2>/dev/null || true)"
  if [ "$installed_version" = "$SYNARA_VERSION" ]; then
    log "Synara server v${SYNARA_VERSION} already installed at $INSTALL_DIR — skipping install."
    if [ "${SYNARA_NO_SETUP:-0}" = "1" ]; then exit 0; fi
    if have_tty; then
      exec "$INSTALL_DIR/bin/synara" setup "$@" < /dev/tty
    else
      exec "$INSTALL_DIR/bin/synara" setup "$@"
    fi
  fi
fi

if [ -z "${SYNARA_TARBALL:-}" ]; then
  [ -n "${SYNARA_VERSION:-}" ] || die "could not resolve the latest Synara release — set SYNARA_VERSION explicitly (e.g. SYNARA_VERSION=0.9.1)"
  # Preflight: fail early with a clear message when a pinned release doesn't exist.
  if [ -n "${SYNARA_VERSION:-}" ] && command -v curl >/dev/null 2>&1; then
    http_code="$(curl -sS -o /dev/null -w '%{http_code}' "https://github.com/${SYNARA_REPO}/releases/tag/v${SYNARA_VERSION}" 2>/dev/null || true)"
    if [ "$http_code" = "404" ]; then
      die "release v${SYNARA_VERSION} not found on ${SYNARA_REPO} — see https://github.com/${SYNARA_REPO}/releases"
    fi
  fi
fi
if [ -n "${SYNARA_TARBALL:-}" ]; then
  log "Installing Synara server from local tarball ${SYNARA_TARBALL}…"
else
  log "Installing Synara server v${SYNARA_VERSION} from ${SYNARA_REPO}…"
fi
mkdir -p "$INSTALL_DIR"
# Portable install mutex (flock isn't universal) — two racing installers in
# the same dir would interleave extraction and npm's non-atomic writes.
install_lock="$INSTALL_DIR/.install.lock"
if ! mkdir "$install_lock" 2>/dev/null; then
  die "another install is already running at $INSTALL_DIR (remove $install_lock if it's stale)"
fi
tmp_pkg="$(mktemp "${TMPDIR:-/tmp}/synara-server-XXXXXX")"
# Stage inside INSTALL_DIR: mv is only atomic within one filesystem, and
# TMPDIR may live on a different one than the install root.
stage_dir="$INSTALL_DIR/.app-stage.$$"
old_dir="$INSTALL_DIR/.app-old.$$"
rm -rf "$stage_dir" "$old_dir"
mkdir "$stage_dir"
trap 'rm -f "$tmp_pkg" "$tmp_pkg.sha256"; rm -rf "$stage_dir" "$old_dir"; rmdir "$install_lock" 2>/dev/null || true' EXIT
if [ -n "${SYNARA_TARBALL:-}" ]; then
  cp "$SYNARA_TARBALL" "$tmp_pkg"
else
  ASSET_URL="https://github.com/${SYNARA_REPO}/releases/download/v${SYNARA_VERSION}/synara-server-${SYNARA_VERSION}.tar.gz"
  fetch "$ASSET_URL" "$tmp_pkg" || die "download failed: $ASSET_URL (does release v${SYNARA_VERSION} ship a server tarball?)"
  # Opportunistic integrity check: releases that ship a <name>.sha256 asset are
  # verified; older releases without one still install.
  sum_file="${tmp_pkg}.sha256"
  if fetch "${ASSET_URL}.sha256" "$sum_file" 2>/dev/null; then
    expected="$(cat "$sum_file")"
    expected="${expected%% *}"
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$tmp_pkg")"
      actual="${actual%% *}"
    elif command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$tmp_pkg")"
      actual="${actual%% *}"
    else
      actual=""
      log "warning: no sha256 tool found — skipping Synara tarball verification"
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      die "sha256 mismatch on synara-server tarball (expected $expected, got $actual) — refusing to install"
    fi
    [ -z "$actual" ] || log "Verified sha256 of synara-server-${SYNARA_VERSION}.tar.gz"
  fi
fi
# Extract to a staging dir, then swap into place: a second install or
# downgrade must not leave files from the previous version behind.
tar -xzf "$tmp_pkg" -C "$stage_dir"
[ -f "$stage_dir/dist/index.mjs" ] || die "server tarball did not contain dist/index.mjs"
[ -f "$stage_dir/package.json" ] || die "server tarball did not contain package.json"
if [ -d "$APP_DIR" ]; then
  mv "$APP_DIR" "$old_dir"
fi
mv "$stage_dir" "$APP_DIR"
rm -rf "$old_dir"

NPM_CLI="$(cd "$(dirname "$NODE_BIN")/.." && pwd)/lib/node_modules/npm/bin/npm-cli.js"
if [ -f "$NPM_CLI" ]; then
  npm_cli() { "$NODE_BIN" "$NPM_CLI" "$@"; }
elif command -v npm >/dev/null 2>&1; then
  npm_cli() { npm "$@"; }
else
  die "npm not found next to node — install Node.js with npm bundled"
fi
if [ -f "$APP_DIR/package-lock.json" ]; then
  log "Installing server dependencies (npm ci, lockfile-pinned)…"
  (cd "$APP_DIR" && npm_cli ci --omit=dev --no-audit --no-fund)
else
  log "Installing server dependencies (npm install --omit=dev)…"
  (cd "$APP_DIR" && npm_cli install --omit=dev --no-audit --no-fund)
fi
# Mark the tree complete only after deps install — a killed run must not pass
# the same-version shortcut next time.
touch "$APP_DIR/.install-complete"

# Convenience launcher so the service + users have a stable entrypoint.
# Values escape for the double-quoted context — an INSTALL_DIR containing
# `$( )`, backticks, quotes, or backslashes must not inject into the wrapper.
esc_dq() { printf '%s' "$1" | sed 's/[\\"`$]/\\&/g'; }
mkdir -p "$INSTALL_DIR/bin"
cat > "$INSTALL_DIR/bin/synara" <<EOF
#!/usr/bin/env sh
exec "$(esc_dq "$NODE_BIN")" "$(esc_dq "$APP_DIR")/dist/index.mjs" "\$@"
EOF
chmod +x "$INSTALL_DIR/bin/synara"
log "Installed $INSTALL_DIR/bin/synara"
case ":${PATH}:" in
  *":$INSTALL_DIR/bin:"*) ;;
  *) log "Note: $INSTALL_DIR/bin is not on PATH — add it with: export PATH=\"$INSTALL_DIR/bin:\$PATH\"" ;;
esac

if [ "${SYNARA_NO_SETUP:-0}" = "1" ]; then
  log "Skipping setup (SYNARA_NO_SETUP=1). Run: $INSTALL_DIR/bin/synara setup"
  exit 0
fi

# curl|bash leaves stdin on the pipe — reattach prompts to the terminal when
# a real controlling terminal exists (ssh -T/CI/cron have none even though
# /dev/tty the node is always present). exec skips the EXIT trap, so clean
# the tarball and release the install lock first.
rm -f "$tmp_pkg" "$tmp_pkg.sha256"
rmdir "$install_lock" 2>/dev/null || true
if have_tty; then
  exec "$INSTALL_DIR/bin/synara" setup "$@" < /dev/tty
else
  exec "$INSTALL_DIR/bin/synara" setup "$@"
fi
