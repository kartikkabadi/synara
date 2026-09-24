#!/usr/bin/env bash
# install-synara-server.sh — install the Synara headless server on a remote
# machine, then launch `synara setup` to configure remote access (Tailscale
# first, HTTPS proxy, or trusted LAN).
#
#   curl -fsSL https://raw.githubusercontent.com/Emanuele-web04/synara/main/scripts/install-synara-server.sh | bash
#   curl -fsSL ... | bash -s -- --yes --mode tailscale
#
# Environment overrides:
#   SYNARA_REPO         GitHub repo to pull releases from (default: Emanuele-web04/synara)
#   SYNARA_VERSION      Server version to install (default: latest release tag)
#   SYNARA_INSTALL_DIR  Install root (default: ~/.synara-server)
#   SYNARA_NODE_VERSION Pinned Node fallback when system node is missing/old
#                       (default: 24.13.1; Synara needs >= 22.19)
#   SYNARA_TARBALL      Install from a local synara-server-<ver>.tar.gz instead
#                       of downloading (offline installs, testing).
#   SYNARA_NO_SETUP=1   Install only — don't run the setup wizard.

set -euo pipefail

SYNARA_REPO="${SYNARA_REPO:-Emanuele-web04/synara}"
INSTALL_DIR="${SYNARA_INSTALL_DIR:-$HOME/.synara-server}"
NODE_VERSION="${SYNARA_NODE_VERSION:-24.13.1}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

log() { printf '%s\n' "$*" >&2; }
die() { log "install-synara-server: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

need tar
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "need curl or wget to download artifacts"
fi

fetch() { # fetch URL OUTFILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

fetch_stdout() { # fetch_stdout URL
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$1"
  else
    wget -q -O - "$1"
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

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  local major minor
  major="${ver%%.*}"
  minor="$(printf '%s' "${ver#*.}" | cut -d. -f1)"
  [ "$major" -gt "$MIN_NODE_MAJOR" ] ||
    { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }
}

# --- Node ------------------------------------------------------------------
NODE_BIN=""
if node_ok; then
  NODE_BIN="$(command -v node)"
else
  log "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} not found; installing Node v${NODE_VERSION} for ${NODE_OS}-${NODE_ARCH}…"
  node_pkg="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz"
  node_base="https://nodejs.org/dist/v${NODE_VERSION}"
  mkdir -p "$INSTALL_DIR/.node"
  fetch "$node_base/$node_pkg" "$INSTALL_DIR/.node/$node_pkg"
  fetch "$node_base/SHASUMS256.txt" "$INSTALL_DIR/.node/SHASUMS256.txt"
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
    latest_url="$(wget -q --server-response --spider --max-redirect=20 "https://github.com/${SYNARA_REPO}/releases/latest" 2>&1 | sed -n 's/^ *Location: *//p' | tail -1 | tr -d '\r')"
  fi
  SYNARA_VERSION="${latest_url##*/}"
  SYNARA_VERSION="${SYNARA_VERSION#v}"
fi

# Re-running the installer on an existing install of the same version skips
# the download+deps entirely and goes straight to setup.
if [ -x "$INSTALL_DIR/bin/synara" ] && [ -f "$APP_DIR/package.json" ] \
  && [ -z "${SYNARA_TARBALL:-}" ] && [ -n "${SYNARA_VERSION:-}" ]; then
  installed_version="$("$NODE_BIN" -p 'require("'"$APP_DIR"'/package.json").version' 2>/dev/null || true)"
  if [ "$installed_version" = "$SYNARA_VERSION" ]; then
    log "Synara server v${SYNARA_VERSION} already installed at $INSTALL_DIR — skipping install."
    if [ "${SYNARA_NO_SETUP:-0}" = "1" ]; then exit 0; fi
    if [ -e /dev/tty ]; then
      exec "$INSTALL_DIR/bin/synara" setup "$@" < /dev/tty
    else
      exec "$INSTALL_DIR/bin/synara" setup "$@"
    fi
  fi
fi

if [ -z "${SYNARA_TARBALL:-}" ]; then
  [ -n "${SYNARA_VERSION:-}" ] || die "could not resolve the latest Synara release — set SYNARA_VERSION explicitly (e.g. SYNARA_VERSION=0.9.1)"
fi
if [ -n "${SYNARA_TARBALL:-}" ]; then
  log "Installing Synara server from local tarball ${SYNARA_TARBALL}…"
else
  log "Installing Synara server v${SYNARA_VERSION} from ${SYNARA_REPO}…"
fi
mkdir -p "$APP_DIR"
tmp_pkg="$(mktemp)"
trap 'rm -f "$tmp_pkg"' EXIT
if [ -n "${SYNARA_TARBALL:-}" ]; then
  cp "$SYNARA_TARBALL" "$tmp_pkg"
else
  ASSET_URL="https://github.com/${SYNARA_REPO}/releases/download/v${SYNARA_VERSION}/synara-server-${SYNARA_VERSION}.tar.gz"
  fetch "$ASSET_URL" "$tmp_pkg" || die "download failed: $ASSET_URL (does release v${SYNARA_VERSION} ship a server tarball?)"
fi
tar -xzf "$tmp_pkg" -C "$APP_DIR"
[ -f "$APP_DIR/dist/index.mjs" ] || die "server tarball did not contain dist/index.mjs"
[ -f "$APP_DIR/package.json" ] || die "server tarball did not contain package.json"

NPM_CLI="$(cd "$(dirname "$NODE_BIN")/.." && pwd)/lib/node_modules/npm/bin/npm-cli.js"
if [ -f "$NPM_CLI" ]; then
  npm_cli() { "$NODE_BIN" "$NPM_CLI" "$@"; }
elif command -v npm >/dev/null 2>&1; then
  npm_cli() { npm "$@"; }
else
  die "npm not found next to node — install Node.js with npm bundled"
fi
log "Installing server dependencies (npm install --omit=dev)…"
(cd "$APP_DIR" && npm_cli install --omit=dev --no-audit --no-fund)

# Convenience launcher so the service + users have a stable entrypoint.
mkdir -p "$INSTALL_DIR/bin"
cat > "$INSTALL_DIR/bin/synara" <<EOF
#!/usr/bin/env sh
exec "$NODE_BIN" "$APP_DIR/dist/index.mjs" "\$@"
EOF
chmod +x "$INSTALL_DIR/bin/synara"
log "Installed $INSTALL_DIR/bin/synara"

if [ "${SYNARA_NO_SETUP:-0}" = "1" ]; then
  log "Skipping setup (SYNARA_NO_SETUP=1). Run: $INSTALL_DIR/bin/synara setup"
  exit 0
fi

# curl|bash leaves stdin on the pipe — reattach prompts to the terminal.
if [ -e /dev/tty ]; then
  exec "$INSTALL_DIR/bin/synara" setup "$@" < /dev/tty
else
  exec "$INSTALL_DIR/bin/synara" setup "$@"
fi
