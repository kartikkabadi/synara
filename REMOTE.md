# Remote Access Setup

Use this when you want to open Synara from another device (phone, tablet, another laptop) — for example a headless Linux VPS you reach through Tailscale.

## Pick your access mode

- **The other device is on your tailnet** → Tailscale mode (recommended). Real HTTPS on `https://<machine>.<tail>.ts.net`, nothing exposed to the public internet.
- **You have a domain / TLS-terminating proxy or tunnel** (nginx, Caddy, `cloudflared`, Funnel) → public-URL mode. The wizard configures `--public-url` and keeps the server on loopback.
- **Trusted LAN, no TLS available** → insecure-LAN mode. Authenticated, but plaintext on the wire — last resort.
- **You only need SSH port-forwarding** (`ssh -L`) or localhost use → loopback mode.

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

Re-running the installer is safe: when the same version is already installed it skips the download and goes straight to `synara setup`. To reconfigure remote access, stop the running server first (`systemctl --user stop synara` or kill the process) — the wizard refuses to mint credentials against a live data directory.

Non-interactive example (provisioning, SSH, CI):

```bash
curl -fsSL .../install-synara-server.sh | bash -s -- --yes --access tailscale --service systemd-user
```

Useful installer overrides: `SYNARA_VERSION` (pin a release), `SYNARA_TARBALL` (install a local tarball offline), `SYNARA_INSTALL_DIR`, `SYNARA_NO_SETUP=1` (install only, no wizard), `SYNARA_NODE_VERSION` (pinned fallback Node).

Run `synara setup --help` for all flags. Setup-level flags (`--access`, `--service`, `--yes`) go after `setup`; server flags (`--port`, `--host`, `--public-url`, `--auth-token`, `--home-dir`, `--allow-insecure-remote`) are parent flags and go before it, e.g. `synara --port 4001 --public-url https://synara.example.com setup --access public-url --yes`.

> NOTE: The one-line installer URL goes live when this lands on `main`. Until then, test it with `curl -fsSL <raw-url-of-this-branch>/scripts/install-synara-server.sh | bash` or copy the script file to the host directly.

## Troubleshooting

| Symptom / message                                     | What it means                                      | Fix                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `Failed to download … (404)` from the installer       | Pinned `SYNARA_VERSION` doesn't exist              | Unset `SYNARA_VERSION` (uses latest) or correct the tag (`v0.9.1`, not `0.9.1`)                                                                                 |
| `synara: command not found` after install             | `~/.synara/bin` isn't on PATH                      | Re-open the shell or `export PATH="$HOME/.synara/bin:$PATH"` (also printed by the installer)                                                                    |
| `synara setup` exits immediately, no prompts          | Non-interactive stdin (piped/SSH without TTY)      | Pass all flags + `--yes` (e.g. `synara setup --access tailscale --yes`), or run in a real terminal                                                              |
| `Tailscale is not installed`                          | No `tailscaled` found                              | `curl -fsSL https://tailscale.com/install.sh                                                                                                                    | sh && sudo tailscale up`, then re-run setup |
| `tailscaled is installed but not running`             | Daemon stopped                                     | `sudo systemctl enable --now tailscaled && tailscale up`                                                                                                        |
| `HTTPS certificates aren't enabled for this tailnet`  | `tailscale serve` needs MagicDNS + HTTPS certs on  | Tailscale admin console → DNS → enable **MagicDNS** and **HTTPS Certificates**, then re-run                                                                     |
| `tailscale serve` warning: permission denied          | Serve needs the tailscale operator/permissions     | `sudo tailscale serve --bg http://127.0.0.1:<port>` (drop `--bg` on Tailscale older than ~v1.46) or add yourself as operator (`tailscale set --operator=$USER`) |
| `a different tailscale serve mapping already exists`  | Root path is mapped to another port                | `tailscale serve --bg http://127.0.0.1:<port>` to replace it, or use `--port` to match the existing                                                             |
| `Port 3773 is already in use`                         | Something else holds the port                      | `synara --port <free-port> setup` (the flag sits on the parent command) or stop the other process                                                               |
| `a Synara server is already running`                  | An existing instance holds the data dir            | `synara server status` to inspect; `systemctl --user stop synara` / kill it, then re-run                                                                        |
| `systemd --user not found` and service install fails  | Headless box without user systemd / linger         | Pick `nohup` service mode, or `sudo loginctl enable-linger $USER` + relog for user units                                                                        |
| Server failed the health check after start            | Crash at boot (bad env, locked DB, port race)      | `journalctl --user -u synara -n 50` or read `~/.synara/userdata/logs/server.log` for the real error                                                             |
| Pairing URL expired / already used                    | One-time link, 30 min TTL                          | `synara server pair` (server stopped) or mint from Settings → pairing while running                                                                             |
| Browser can't reach `https://<machine>.<tail>.ts.net` | Device isn't on the tailnet                        | Install Tailscale on that device and join the same tailnet; check `tailscale ping <machine>`                                                                    |
| `npm install` fails compiling `node-pty`              | No prebuilt binary for this libc/arch (musl, etc.) | Install build tools first — Debian/Ubuntu: `sudo apt install build-essential python3`; Alpine: `apk add build-base python3`                                     |

### Re-minting a pairing URL

Pairing URLs expire and are single-use. To mint a fresh owner link while the server is **stopped**:

```bash
synara server pair [--ttl-minutes 30] [--url http://127.0.0.1:3773]
```

While the server is running, mint from the UI instead (Settings → pairing), since the data directory is locked to the live process.

> **One host per data dir.** The database lock relies on pid liveness on the
> same machine — sharing a `SYNARA_HOME` over NFS or between two hosts lets
> both treat the other as dead and write to the same SQLite file. Keep each
> `--home-dir` local to one host.

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
