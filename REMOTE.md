# Remote Access Setup

Use this when you want to open Synara from another device (phone, tablet, another laptop) — for example a headless Linux VPS you reach through Tailscale.

## One-command install (recommended)

On the machine that should host Synara:

```bash
curl -fsSL https://raw.githubusercontent.com/Emanuele-web04/synara/main/scripts/install-synara-server.sh | bash
```

The installer checks for Node.js ≥ 22.19 (installs a pinned runtime next to the app when missing), downloads the latest `synara-server-<version>.tar.gz`, installs production dependencies, then launches **`synara setup`** — an interactive wizard that finishes remote access for you:

- **Tailscale (recommended)** — detects `tailscaled`, finds your `https://<machine>.<tail>.ts.net` MagicDNS name, runs `tailscale serve` for you, and keeps the server bound to loopback. You get real HTTPS, private tailnet-only reachability, and zero firewall changes.
- **HTTPS reverse proxy / tunnel** — bring your own TLS terminator (Caddy, nginx, `cloudflared`, Tailscale Funnel). The wizard asks for the public `https://` origin and sets `--public-url` for you.
- **Trusted LAN (plaintext)** — binds on your LAN address with authentication still enforced. Requires an explicit `--allow-insecure-remote` acknowledgement; not for anything you wouldn't want readable on the wire.
- **Loopback only** — the safe baseline for SSH-tunnel or localhost-only use.

For each remote mode the wizard generates a random auth token, writes a private (`0600`) `synara.env` next to your data directory, installs a service it can (user-level `systemd` with linger, a `nohup` fallback, or printed manual instructions), starts the server, waits for `/health`, and prints a **one-time owner pairing URL**. Open that URL on your other device once — it mints the authenticated owner session.

Re-running the installer is safe: when the same version is already installed it skips the download and goes straight to `synara setup`, so it doubles as "reconfigure my remote access".

Non-interactive example (provisioning, SSH, CI):

```bash
curl -fsSL .../install-synara-server.sh | bash -s -- --yes --access tailscale --service systemd-user
```

Useful installer overrides: `SYNARA_VERSION` (pin a release), `SYNARA_TARBALL` (install a local tarball offline), `SYNARA_INSTALL_DIR`, `SYNARA_NO_SETUP=1` (install only, no wizard), `SYNARA_NODE_VERSION` (pinned fallback Node).

Run `synara setup --help` for all flags (`--access`, `--service`, `--port`, `--host`, `--public-url`, `--pair-url`, `--pair-ttl`, `--yes`).

### Re-minting a pairing URL

Pairing URLs expire and are single-use. To mint a fresh owner link while the server is **stopped**:

```bash
synara server pair [--ttl 30m] [--url http://127.0.0.1:3773]
```

While the server is running, mint from the UI instead (Settings → pairing), since the data directory is locked to the live process.

## CLI ↔ Env option map

The Synara CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `SYNARA_MODE`         | Runtime mode.                      |
| `--port <number>`       | `SYNARA_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `SYNARA_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `SYNARA_HOME`         | Base directory.                    |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `SYNARA_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `SYNARA_AUTH_TOKEN`   | WebSocket auth token.              |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
- Treat the token like a password.
- Prefer `tailscale serve` (HTTPS on your tailnet name) over binding a Tailnet IP directly.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## Manual setup (no wizard)

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.123:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.

## Manual Tailnet / Tailscale access

Preferred: keep the server on loopback and let `tailscale serve` terminate HTTPS on your tailnet name:

```bash
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 127.0.0.1 --port 3773 \
  --auth-token "$TOKEN" --public-url "https://<machine>.<tail>.ts.net" --no-browser
tailscale serve --bg http://127.0.0.1:3773
```

Open `https://<machine>.<tail>.ts.net` from any device in your tailnet.

Alternative without `tailscale serve` (plaintext HTTP over WireGuard — authenticated, but unencrypted):

```bash
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 \
  --auth-token "$TOKEN" --allow-insecure-remote --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`
