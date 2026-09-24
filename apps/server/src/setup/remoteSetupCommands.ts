// FILE: remoteSetupCommands.ts
// Purpose: `synara setup` interactive wizard and `synara server pair`
//          credential minter — walks a headless host through remote access
//          (Tailscale serve first, generic HTTPS proxy or trusted LAN as
//          alternatives), persists config as a private env file, installs a
//          service (systemd --user → nohup → manual fallback), and prints the
//          one-time owner pairing URL. Command wiring lives in main.ts.
// Layer: Server CLI program

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Duration, Effect, FileSystem, Option, Path } from "effect";
import { Flag, Prompt } from "effect/unstable/cli";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { getBooleanFlagValue } from "@synara/shared/cli";

import { resolveExternalMcpBaseDir } from "../externalMcp/bridge";
import { DEFAULT_PORT, deriveServerPaths } from "../config";
import { ensurePrivateDirectorySync } from "../privatePathPermissions";
import { isLoopbackHost } from "../startupAccess";
import {
  checkFirewalldTailscaleAccess,
  checkPortAvailable,
  configureTailscaleServe,
  detectRunningInstance,
  detectSystemdUser,
  detectTailscale,
  enableUserLinger,
  findTailscaleServeRoute,
  installSystemdUserService,
  issueOwnerPairingUrl,
  readSetupEnvironmentValue,
  RemoteSetupError,
  resolvePackagedEntrypoint,
  startDetachedServer,
  waitForServerReady,
  writeEnvironmentFile,
  type TailscaleDetection,
} from "./remoteSetup";
import {
  detectPrimaryLanIpv4,
  generateRemoteAuthToken,
  isWildcardHost,
  localProbeOrigin,
  redactTailscaleSecrets,
  renderManualStartInstructions,
  SETUP_HEALTH_TIMEOUT_MS,
  SETUP_PAIRING_TTL,
  SETUP_SERVICE_NAME,
  systemdUserUnitDirectory,
  tailscaleDiagnostic,
  type RemoteServiceMode,
  type RemoteSetupConfig,
  type RemoteSetupMode,
  validatePublicOrigin,
} from "./remoteSetupPlan";

const TAILSCALE_INSTALL_URL = "https://tailscale.com/download/linux";

export const setupAccessFlag = Flag.choice("access", [
  "tailscale",
  "public-url",
  "insecure-lan",
  "loopback",
]).pipe(Flag.withDescription("Remote access mode to configure."), Flag.optional);

export const setupServiceFlag = Flag.choice("service", ["systemd-user", "nohup", "manual"]).pipe(
  Flag.withDescription(
    "How to run the server: systemd user unit, detached nohup process, or manual.",
  ),
  Flag.optional,
);

export const setupYesFlag = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Non-interactive: accept detected defaults."),
  Flag.withDefault(false),
);

export const pairUrlFlag = Flag.string("url").pipe(
  Flag.withDescription(
    "Base URL the browser uses to reach Synara. Defaults to --public-url, then SYNARA_PUBLIC_URL, then the setup env file's value.",
  ),
  Flag.optional,
);

export const pairTtlFlag = Flag.integer("ttl-minutes").pipe(
  Flag.withDescription("Minutes until the minted pairing link expires."),
  Flag.withDefault(30),
);

export interface SetupFlags {
  readonly access: Option.Option<RemoteSetupMode>;
  readonly service: Option.Option<RemoteServiceMode>;
  readonly yes: boolean;
}

/** The parent's parsed input, as delivered by `yield* baseServerCommand`. */
export interface SetupParentInput {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly synaraHome: Option.Option<string>;
  readonly publicUrl: Option.Option<URL>;
  readonly authToken: Option.Option<string>;
  readonly allowInsecureRemote: {
    readonly positive: boolean | undefined;
    readonly negative: boolean | undefined;
  };
}

const writeLine = (text: string) => Effect.sync(() => process.stdout.write(`${text}\n`));

const ask = <Output>(prompt: Prompt.Prompt<Output>) =>
  Prompt.run(prompt).pipe(
    Effect.mapError(() => new RemoteSetupError({ message: "Setup aborted." })),
  );

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const resolveMode = (input: {
  readonly requested: RemoteSetupMode | undefined;
  readonly tailscaleReady: boolean;
  readonly interactive: boolean;
}): Effect.Effect<RemoteSetupMode, RemoteSetupError, Prompt.Environment> => {
  if (input.requested) return Effect.succeed(input.requested);
  if (!input.interactive) {
    return Effect.fail(
      new RemoteSetupError({
        message:
          "Non-interactive setup needs --access (tailscale | public-url | insecure-lan | loopback), e.g. `synara setup --yes --access tailscale`.",
      }),
    );
  }
  return ask(
    Prompt.select<RemoteSetupMode>({
      message: "How should this Synara server be reachable?",
      choices: [
        {
          title: input.tailscaleReady
            ? "Tailscale serve — recommended (Tailscale is connected)"
            : "Tailscale serve — private HTTPS over your tailnet (recommended)",
          value: "tailscale",
          description:
            "Serves Synara as https://<machine>.<tailnet>.ts.net, reachable only inside your tailnet. Configures `tailscale serve` for you.",
        },
        {
          title: "HTTPS reverse proxy or tunnel",
          value: "public-url",
          description:
            "You run a TLS-terminating proxy or tunnel in front (Caddy, nginx, cloudflared, Tailscale Funnel, …) and give Synara its public https origin.",
        },
        {
          title: "Trusted LAN, no TLS",
          value: "insecure-lan",
          description:
            "Binds a non-loopback interface with plaintext HTTP. Only for networks you trust end to end.",
        },
        {
          title: "This machine only",
          value: "loopback",
          description:
            "Loopback-only (127.0.0.1). No remote access — reach it through SSH port forwarding or a desktop app.",
        },
      ],
    }),
  );
};

const resolvePort = (
  parent: SetupParentInput,
  interactive: boolean,
): Effect.Effect<number, RemoteSetupError, Prompt.Environment> =>
  Option.isSome(parent.port)
    ? Effect.succeed(parent.port.value)
    : interactive
      ? ask(
          Prompt.text({
            message: "Server port",
            default: String(DEFAULT_PORT),
            validate: (value) => {
              const trimmed = value.trim();
              const parsed = Number(trimmed);
              return /^\d+$/.test(trimmed) && parsed >= 1 && parsed <= 65535
                ? Effect.succeed(trimmed)
                : Effect.fail("Enter a port between 1 and 65535.");
            },
          }).pipe(Prompt.map((value) => Number(value.trim()))),
        )
      : Effect.succeed(DEFAULT_PORT);

const resolveConfig = (
  parent: SetupParentInput,
  input: {
    readonly mode: RemoteSetupMode;
    readonly interactive: boolean;
    readonly tailscale: TailscaleDetection;
  },
): Effect.Effect<RemoteSetupConfig, RemoteSetupError, Prompt.Environment> =>
  Effect.gen(function* () {
    const baseDir = resolveExternalMcpBaseDir(Option.getOrUndefined(parent.synaraHome));
    const port = yield* resolvePort(parent, input.interactive);
    // A blank --auth-token/env value is unset, not "no auth": remote binds
    // without a token are refused by the server at boot.
    const rawToken = Option.getOrUndefined(parent.authToken) ?? process.env.SYNARA_AUTH_TOKEN;
    // Re-running setup rotates the WS token unless the operator asks for one,
    // which bricks already-paired clients — reuse the env-file token written
    // by a previous run when present. Rotate by passing --auth-token.
    const persistedToken = readSetupEnvironmentValue(baseDir, "SYNARA_AUTH_TOKEN");
    const authToken = (rawToken?.trim() ? rawToken : undefined) ?? persistedToken;
    const explicitToken = Option.getOrUndefined(parent.authToken)?.trim()
      ? Option.getOrUndefined(parent.authToken)
      : undefined;

    // The remote modes own their bind host — an explicit --host that
    // contradicts the mode means a misread of the flags, not an override.
    const explicitHost = Option.getOrUndefined(parent.host);
    const modeBindsLoopback = input.mode === "tailscale" || input.mode === "public-url";
    if (explicitHost !== undefined) {
      if (modeBindsLoopback && explicitHost !== "127.0.0.1" && explicitHost !== "localhost") {
        return yield* new RemoteSetupError({
          message: `--host ${explicitHost} contradicts --access ${input.mode} (the proxy/front-end terminates TLS; Synara must stay on loopback). Drop --host.`,
        });
      }
      if (input.mode === "loopback" && !isLoopbackHost(explicitHost)) {
        return yield* new RemoteSetupError({
          message: `--access loopback can't bind ${explicitHost} — that's a remote bind, which needs tailscale, public-url, or insecure-lan mode.`,
        });
      }
      if (input.mode === "insecure-lan" && isLoopbackHost(explicitHost)) {
        return yield* new RemoteSetupError({
          message: `--access insecure-lan with --host ${explicitHost} exposes nothing remotely — drop insecure-lan (use loopback) or pass a LAN interface.`,
        });
      }
    }

    switch (input.mode) {
      case "tailscale": {
        const dnsName = input.tailscale.dnsName;
        if (!dnsName) {
          return yield* new RemoteSetupError({
            message:
              "Tailscale is installed but this machine is not connected. Run `sudo tailscale up`, then re-run `synara setup`.",
          });
        }
        return {
          mode: "tailscale",
          baseDir,
          port,
          host: "127.0.0.1",
          publicUrl: `https://${dnsName}`,
          authToken: authToken ?? generateRemoteAuthToken(),
          allowInsecureRemote: false,
        };
      }
      case "public-url": {
        let raw: string | undefined = Option.isSome(parent.publicUrl)
          ? parent.publicUrl.value.toString()
          : process.env.SYNARA_PUBLIC_URL;
        if (!raw && input.interactive) {
          raw = yield* ask(
            Prompt.text({
              message: "Public HTTPS origin (e.g. https://synara.example.com)",
              validate: (value) => {
                const checked = validatePublicOrigin(value.trim());
                return checked.ok
                  ? Effect.succeed(value)
                  : Effect.fail(checked.reason ?? "Invalid URL.");
              },
            }),
          );
        }
        if (!raw) {
          return yield* new RemoteSetupError({
            message:
              "This mode needs the HTTPS origin your proxy exposes — run `synara --public-url https://… setup` or set SYNARA_PUBLIC_URL.",
          });
        }
        const validated = validatePublicOrigin(raw);
        if (!validated.ok) {
          return yield* new RemoteSetupError({
            message: validated.reason ?? `Invalid public URL ${raw}.`,
          });
        }
        return {
          mode: "public-url",
          baseDir,
          port,
          host: "127.0.0.1",
          publicUrl: validated.origin,
          authToken: authToken ?? generateRemoteAuthToken(),
          allowInsecureRemote: false,
        };
      }
      case "insecure-lan": {
        const flagValue = getBooleanFlagValue({
          positive: parent.allowInsecureRemote.positive,
          negative: parent.allowInsecureRemote.negative,
        });
        if (flagValue === false) {
          return yield* new RemoteSetupError({
            message:
              "insecure-lan binds plaintext HTTP on your LAN — run `synara --allow-insecure-remote --access insecure-lan setup` to confirm, or prefer tailscale/public-url mode.",
          });
        }
        if (flagValue !== true) {
          // Three-state flag: absent means not acknowledged, not refused.
          const confirmed = input.interactive
            ? yield* ask(
                Prompt.confirm({
                  message:
                    "insecure-lan exposes Synara over plaintext HTTP to anyone on your network. Continue?",
                  initial: false,
                }),
              )
            : false;
          if (!confirmed) {
            return yield* new RemoteSetupError({
              message:
                "insecure-lan declined — rerun with `synara --allow-insecure-remote --access insecure-lan setup`, or pick tailscale/public-url mode.",
            });
          }
        }
        // Bind the detected LAN interface, not 0.0.0.0: on a VPS the wildcard
        // reaches the PUBLIC NIC, exposing plaintext HTTP + bearer token to
        // the internet. Explicit --host always wins.
        const host = Option.getOrUndefined(parent.host) ?? detectPrimaryLanIpv4() ?? "0.0.0.0";
        return {
          mode: "insecure-lan",
          baseDir,
          port,
          host,
          publicUrl: undefined,
          authToken: authToken ?? generateRemoteAuthToken(),
          allowInsecureRemote: true,
        };
      }
      case "loopback": {
        const host = Option.getOrUndefined(parent.host) ?? "127.0.0.1";
        return {
          mode: "loopback",
          baseDir,
          port,
          host,
          publicUrl: undefined,
          // Loopback needs no auth token. Only an explicit --auth-token is
          // honored here — an ambient SYNARA_AUTH_TOKEN in this shell would
          // silently lock same-machine browsers out with no pairing link.
          authToken: explicitToken ?? "",
          allowInsecureRemote: false,
        };
      }
    }
  });

const resolveServiceMode = (input: {
  readonly requested: RemoteServiceMode | undefined;
  readonly interactive: boolean;
  readonly systemdUser: boolean;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
}): Effect.Effect<RemoteServiceMode, RemoteSetupError, Prompt.Environment> => {
  if (input.requested === "systemd-user" && !input.systemdUser) {
    return Effect.fail(
      new RemoteSetupError({
        message:
          "--service systemd-user needs a systemd user session, but `systemctl --user` is unavailable here. Use --service nohup or manual.",
      }),
    );
  }
  if (input.requested === "nohup" && input.platform === "win32") {
    return Effect.fail(
      new RemoteSetupError({
        message:
          "--service nohup needs a POSIX shell (sh, nohup, /dev/null) — not available on Windows. Use --service manual.",
      }),
    );
  }
  if ((input.requested === "systemd-user" || input.requested === "nohup") && !input.packaged) {
    return Effect.fail(
      new RemoteSetupError({
        message:
          "Service modes need the packaged server (dist/index.mjs). This CLI is running from source; use --service manual.",
      }),
    );
  }
  if (input.requested) return Effect.succeed(input.requested);

  const auto: RemoteServiceMode = !input.packaged
    ? "manual"
    : input.systemdUser
      ? "systemd-user"
      : input.platform === "linux" || input.platform === "darwin" || input.platform === "freebsd"
        ? "nohup"
        : "manual";

  if (!input.interactive) return Effect.succeed(auto);

  const choices: Array<{
    title: string;
    value: RemoteServiceMode;
    description: string;
  }> = [];
  if (input.systemdUser && input.packaged) {
    choices.push({
      title: "systemd user service — recommended",
      value: "systemd-user",
      description:
        "Installs ~/.config/systemd/user/synara.service: auto-starts on login, restarts on crash, logs to journalctl.",
    });
  }
  if (input.packaged && input.platform !== "win32") {
    choices.push({
      title: "Background process (nohup)",
      value: "nohup",
      description: "Starts now via nohup and survives this shell. No restart on crash or reboot.",
    });
  }
  choices.push({
    title: "Manual — I'll run it myself",
    value: "manual",
    description: "Writes config and prints the exact start commands; you supervise it.",
  });
  return ask(
    Prompt.select<RemoteServiceMode>({
      message: "How should the server be run?",
      choices,
    }),
  );
};

const pairingBaseFor = (config: RemoteSetupConfig): string => {
  if (config.publicUrl) return config.publicUrl;
  if (config.mode === "insecure-lan") {
    const lanHost = isWildcardHost(config.host) ? detectPrimaryLanIpv4() : config.host;
    if (lanHost) return `http://${lanHost}:${config.port}`;
    return `http://${config.host}:${config.port}`;
  }
  return localProbeOrigin(config);
};

const writeOutput = (lines: ReadonlyArray<string>) =>
  Effect.sync(() => process.stdout.write(`${lines.join("\n")}\n`));

export const runRemoteSetup = (
  flags: SetupFlags,
  parent: SetupParentInput,
): Effect.Effect<
  void,
  RemoteSetupError,
  Prompt.Environment | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const interactive = !flags.yes && isInteractive();
    const baseDir = resolveExternalMcpBaseDir(Option.getOrUndefined(parent.synaraHome));

    const running = yield* detectRunningInstance(baseDir);
    if (running.running) {
      return yield* new RemoteSetupError({
        message: `A Synara server is already running for ${baseDir}${running.origin ? ` at ${running.origin}` : ""}. Stop it first (e.g. \`systemctl --user stop synara\`${running.pid ? ` or \`kill ${running.pid}\`` : ""}), then re-run setup — a running server holds the database lock, so pairing credentials can't be minted.`,
      });
    }

    const tailscale = yield* detectTailscale;
    const systemdUser = yield* detectSystemdUser;
    const entrypoint = resolvePackagedEntrypoint();

    const mode = yield* resolveMode({
      requested: Option.getOrUndefined(flags.access),
      tailscaleReady: tailscale.running && tailscale.httpsCerts,
      interactive,
    });

    if (mode === "tailscale") {
      if (!tailscale.installed) {
        return yield* new RemoteSetupError({
          message: `Tailscale isn't installed. Install it (${TAILSCALE_INSTALL_URL}), run \`sudo tailscale up\`, then re-run \`synara setup\` — or pick another mode.`,
        });
      }
      if (!tailscale.running || !tailscale.dnsName) {
        return yield* new RemoteSetupError({
          message:
            "Tailscale is installed but not connected. Run `sudo tailscale up`, log in, then re-run `synara setup`.",
        });
      }
      if (!tailscale.httpsCerts) {
        return yield* new RemoteSetupError({
          message:
            "Tailscale is connected but HTTPS certificates aren't enabled for this tailnet (MagicDNS/CertDomains). Enable HTTPS certificates in the Tailscale admin console, or pick another access mode.",
        });
      }
    }

    const config = yield* resolveConfig(parent, { mode, interactive, tailscale });

    const serviceMode = yield* resolveServiceMode({
      requested: Option.getOrUndefined(flags.service),
      interactive,
      systemdUser,
      packaged: Boolean(entrypoint),
      platform: process.platform,
    });

    const bindProbe = yield* checkPortAvailable(config.host, config.port);
    if (!bindProbe.available) {
      return yield* new RemoteSetupError({
        message: `Port ${config.port} is already in use on this machine. Pick another with \`synara --port <free-port> setup\`.`,
      });
    }

    let tailscaleAccessBroken = false;
    if (mode === "tailscale") {
      const serve = yield* configureTailscaleServe(config.port);
      if (serve.configured) {
        // A reused mapping may live on a non-443 tailnet port — reflect it in
        // the public URL and the pairing link.
        if (serve.servePort && serve.servePort !== 443 && config.publicUrl) {
          config.publicUrl = `https://${tailscale.dnsName}:${serve.servePort}`;
        }
        yield* writeLine(`tailscale serve → ${config.publicUrl}`);
        const firewalld = yield* checkFirewalldTailscaleAccess();
        if (!firewalld.ok && firewalld.detail) {
          yield* writeLine(`Warning: ${firewalld.detail}`);
        }
      } else {
        tailscaleAccessBroken = true;
        const hint =
          tailscaleDiagnostic(serve.detail) === "permission-denied"
            ? `Try: sudo tailscale serve --bg http://127.0.0.1:${config.port}`
            : tailscaleDiagnostic(serve.detail) === "not-logged-in"
              ? "Run `tailscale up` to join a tailnet, then re-run setup."
              : `Fix with:\n  sudo tailscale serve --bg http://127.0.0.1:${config.port}`;
        yield* writeLine(
          `Warning: could not configure tailscale serve${serve.detail ? ` (${redactTailscaleSecrets(serve.detail)})` : ""}. ${hint}`,
        );
      }
    } else if (tailscale.installed && tailscale.running) {
      // Switching away from tailscale mode leaves the old `/` route live —
      // serve mappings persist in tailscaled across reboots.
      const staleRoute = yield* findTailscaleServeRoute(config.port);
      if (staleRoute !== undefined) {
        yield* writeLine(
          `Note: a tailscale serve route for / → :${config.port} from a previous run is still active on tailnet port ${staleRoute}. Remove it with \`tailscale serve --https=${staleRoute} off\` if this install shouldn't be reachable on the tailnet.`,
        );
      }
    }

    yield* writeLine(`Writing configuration to ${config.baseDir} …`);
    const envFilePath = yield* writeEnvironmentFile(config);

    const pairing =
      // Loopback skips the mint unless a token is actually in effect —
      // otherwise the owner link is the only way in to a locked browser.
      // When the tailnet route never got configured, skip the mint too: the
      // link would be dead the moment it printed (and likely expired by the
      // time serve is fixed), so the summary points at `server pair` instead.
      (config.mode === "loopback" && !config.authToken) || tailscaleAccessBroken
        ? undefined
        : yield* issueOwnerPairingUrl({
            baseDir: config.baseDir,
            baseUrl: pairingBaseFor(config),
            ttl: SETUP_PAIRING_TTL,
            label: "synara setup",
          });

    const executablePath = process.execPath;
    const derivedPaths = yield* deriveServerPaths(config.baseDir, undefined);
    let serviceSummary = "";
    let ready = false;
    // The server creates logsDir itself at boot, but nohup's `>>` redirect and
    // systemd's `append:` sink need the directory to exist beforehand.
    if (serviceMode !== "manual") {
      yield* Effect.try({
        try: () => ensurePrivateDirectorySync(derivedPaths.logsDir),
        catch: (cause) =>
          new RemoteSetupError({ message: `Failed to create ${derivedPaths.logsDir}.`, cause }),
      });
    }
    // A fixed synara.service name would silently stomp a second install's
    // unit (canary vs stable, different --home-dir). If an existing unit
    // points at a different env file, derive a per-home suffix instead.
    const serviceName = yield* Effect.sync((): string => {
      if (serviceMode !== "systemd-user") return SETUP_SERVICE_NAME;
      const home = process.env.HOME;
      if (!home) return SETUP_SERVICE_NAME;
      const unitPath = path.join(
        systemdUserUnitDirectory(home, process.env.XDG_CONFIG_HOME),
        `${SETUP_SERVICE_NAME}.service`,
      );
      try {
        const contents = fs.readFileSync(unitPath, "utf8");
        const envLine = contents.split("\n").find((line) => line.startsWith("EnvironmentFile="));
        const ref = envLine
          ?.slice("EnvironmentFile=".length)
          .trim()
          .replace(/^"|"$/g, "")
          .replace(/%%/g, "%")
          .replace(/\\"/g, '"');
        if (ref && ref !== envFilePath) {
          const hash = createHash("sha256").update(config.baseDir).digest("hex").slice(0, 6);
          return `${SETUP_SERVICE_NAME}-${hash}`;
        }
      } catch {
        // Missing or unreadable unit → the default name is safe.
      }
      return SETUP_SERVICE_NAME;
    });
    const installService =
      serviceMode === "systemd-user"
        ? Effect.gen(function* () {
            const installed = yield* installSystemdUserService({
              serviceName,
              envFilePath,
              executablePath,
              entrypointPath: entrypoint!,
              workingDirectory: config.baseDir,
              logFilePath: path.join(derivedPaths.logsDir, "server.log"),
            });
            const linger = yield* enableUserLinger();
            return `systemd --user unit ${installed.unitPath}${installed.replaced ? " (replaced existing unit)" : ""}${linger.enabled ? "; linger enabled (survives logout)" : "; linger not enabled — service stops at logout"}`;
          })
        : serviceMode === "nohup"
          ? Effect.map(
              startDetachedServer({
                envFilePath,
                executablePath,
                entrypointPath: entrypoint!,
                logPath: path.join(derivedPaths.logsDir, "server.log"),
              }),
              (pid) =>
                `nohup background process (pid ${pid}, log ${path.join(derivedPaths.logsDir, "server.log")})`,
            )
          : Effect.succeed("manual start — commands below");
    // A minted credential survives a failed install — print it before
    // propagating so the owner link isn't orphaned silently.
    serviceSummary = yield* installService.pipe(
      Effect.tapError(() =>
        pairing === undefined
          ? Effect.void
          : writeOutput([
              "",
              `Service setup failed — but a pairing link WAS minted (one-time, expires ${pairing.expiresAt.toISOString()}):`,
              `  ${pairing.url}`,
              "",
            ]),
      ),
    );

    if (serviceMode !== "manual") {
      const probe = yield* waitForServerReady(localProbeOrigin(config));
      ready = probe.ready;
    }

    const lines: Array<string> = [
      "",
      tailscaleAccessBroken
        ? "Synara remote setup finished — tailscale serve is NOT configured."
        : "Synara remote setup complete.",
      "",
    ];
    if (config.publicUrl) lines.push(`  Public URL:   ${config.publicUrl}`);
    lines.push(`  Bind:         http://${config.host}:${config.port}`);
    lines.push(`  Data dir:     ${config.baseDir}`);
    lines.push(`  Env file:     ${envFilePath} (mode 600 — holds SYNARA_AUTH_TOKEN)`);
    lines.push(`  Service:      ${serviceSummary}`);
    if (tailscaleAccessBroken) {
      lines.push("");
      lines.push("  The server is running on loopback but unreachable from your tailnet.");
      lines.push("  After `tailscale serve` works, mint a fresh link:");
      lines.push("    synara server pair --ttl-minutes 30");
    }
    if (pairing) {
      lines.push("");
      lines.push(`  Pairing URL — one-time, expires ${pairing.expiresAt.toISOString()}:`);
      lines.push(`  ${pairing.url}`);
      lines.push("");
      lines.push("Open the pairing URL once in your browser to claim the owner session.");
    }
    if (mode === "insecure-lan") {
      lines.push("");
      lines.push(
        isWildcardHost(config.host)
          ? "  WARNING: plaintext HTTP bound to ALL interfaces — on a public-facing machine that includes the internet. Prefer tailscale/public-url, or pass --host <lan-ip>."
          : "  WARNING: plaintext HTTP on your LAN. Prefer the tailscale or public-url mode when you can.",
      );
      if (process.platform === "linux" && /microsoft|wsl/i.test(os.release())) {
        lines.push(
          "  NOTE: WSL detected — the printed address is WSL's NAT IP, unreachable from your LAN. Use loopback mode + `ssh -L`, or enable mirrored networking in .wslconfig.",
        );
      }
    }
    if (serviceMode === "manual") {
      lines.push("");
      lines.push("Start it yourself with:");
      for (const line of renderManualStartInstructions({
        envFilePath,
        executablePath,
        ...(entrypoint !== undefined ? { entrypointPath: entrypoint } : {}),
      })) {
        lines.push(`    ${line}`);
      }
      if (pairing) {
        lines.push("");
        lines.push(
          `  The pairing URL above expires ${pairing.expiresAt.toISOString()} — start the server and open it before then, or run \`synara server pair\` later for a fresh one.`,
        );
      }
    }
    if (serviceMode === "systemd-user") {
      lines.push("");
      lines.push(`Manage:  systemctl --user status ${serviceName} | restart | stop`);
      lines.push(`Logs:    journalctl --user -u ${serviceName} -f`);
    }
    lines.push("");
    yield* writeOutput(lines);

    if (!ready && serviceMode !== "manual") {
      // The service was started but never answered /health — for --yes
      // provisioning this must fail loudly, not exit 0 on a dead server.
      return yield* new RemoteSetupError({
        message: `The Synara server did not report ready within ${SETUP_HEALTH_TIMEOUT_MS / 1000}s. Check ${path.join(derivedPaths.logsDir, "server.log")}${serviceMode === "systemd-user" ? ` or \`journalctl --user -u ${serviceName}\`` : ""} for the crash, then re-run \`synara server status\`.`,
      });
    }
  });

export const runServerPair = (
  flags: { readonly url: Option.Option<string>; readonly ttlMinutes: number },
  parent: SetupParentInput,
): Effect.Effect<void, RemoteSetupError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const baseDir = resolveExternalMcpBaseDir(Option.getOrUndefined(parent.synaraHome));
    const running = yield* detectRunningInstance(baseDir);
    if (running.running) {
      return yield* new RemoteSetupError({
        message: `A Synara server is already running for ${baseDir}${running.origin ? ` at ${running.origin}` : ""}. Stop it first (\`systemctl --user stop synara\`${running.pid ? ` or \`kill ${running.pid}\`` : ""}) — a running server holds the database lock, so a pairing credential can't be minted.`,
      });
    }
    let baseUrl: string | undefined = Option.getOrUndefined(flags.url);
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (parsed.origin === "null") throw new Error("no origin");
        baseUrl = parsed.origin;
      } catch {
        return yield* new RemoteSetupError({
          message: `--url ${baseUrl} is not a valid URL — pass a full origin like https://vps.tail123.ts.net or http://127.0.0.1:3773.`,
        });
      }
    }
    if (!baseUrl && Option.isSome(parent.publicUrl)) {
      baseUrl = parent.publicUrl.value.toString();
    }
    if (!baseUrl) {
      baseUrl = process.env.SYNARA_PUBLIC_URL;
    }
    if (!baseUrl) {
      // Remote installs keep their public origin in <base>/synara.env, not in
      // this shell's environment — fall back to it before guessing loopback.
      baseUrl = readSetupEnvironmentValue(baseDir, "SYNARA_PUBLIC_URL");
    }
    if (!baseUrl) {
      const port = Option.isSome(parent.port)
        ? parent.port.value
        : Number(readSetupEnvironmentValue(baseDir, "SYNARA_PORT")) || DEFAULT_PORT;
      baseUrl = `http://127.0.0.1:${port}`;
    }

    if (!Number.isFinite(flags.ttlMinutes) || flags.ttlMinutes < 1 || flags.ttlMinutes > 1440) {
      return yield* new RemoteSetupError({
        message: `--ttl-minutes must be between 1 and 1440 minutes (got ${flags.ttlMinutes}).`,
      });
    }
    const issued = yield* issueOwnerPairingUrl({
      baseDir,
      baseUrl,
      ttl: Duration.minutes(flags.ttlMinutes),
      label: "synara server pair",
    });
    yield* writeOutput([
      "",
      "Pairing URL — one-time use:",
      `  ${issued.url}`,
      `  Expires ${issued.expiresAt.toISOString()}`,
      "",
      "Open it once in the browser you want to authorize.",
      "",
    ]);
  });
