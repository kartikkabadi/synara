// FILE: remoteSetupCommands.ts
// Purpose: `synara setup` interactive wizard and `synara server pair`
//          credential minter — walks a headless host through remote access
//          (Tailscale serve first, generic HTTPS proxy or trusted LAN as
//          alternatives), persists config as a private env file, installs a
//          service (systemd --user → nohup → manual fallback), and prints the
//          one-time owner pairing URL. Command wiring lives in main.ts.
// Layer: Server CLI program

import * as path from "node:path";

import { Duration, Effect, FileSystem, Option, Path } from "effect";
import { Flag, Prompt } from "effect/unstable/cli";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { getBooleanFlagValue } from "@synara/shared/cli";

import { resolveExternalMcpBaseDir } from "../externalMcp/bridge";
import { DEFAULT_PORT, deriveServerPaths } from "../config";
import {
  checkPortAvailable,
  configureTailscaleServe,
  detectRunningInstance,
  detectSystemdUser,
  detectTailscale,
  enableUserLinger,
  installSystemdUserService,
  issueOwnerPairingUrl,
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
  renderManualStartInstructions,
  SETUP_HEALTH_TIMEOUT_MS,
  SETUP_PAIRING_TTL,
  SETUP_SERVICE_NAME,
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
    "Base URL the browser uses to reach Synara. Defaults to --public-url, then the discovered server origin.",
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
    const authToken = Option.getOrUndefined(parent.authToken) ?? process.env.SYNARA_AUTH_TOKEN;

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
              "This mode needs the HTTPS origin your proxy exposes — pass --public-url https://… or set SYNARA_PUBLIC_URL.",
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
              "insecure-lan mode needs --allow-insecure-remote. It binds plaintext HTTP on your LAN — prefer tailscale or public-url mode.",
          });
        }
        const host = Option.getOrUndefined(parent.host) ?? "0.0.0.0";
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
          // Loopback needs no auth token — setting one would force pairing on
          // same-machine browsers.
          authToken: authToken ?? "",
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
        message: `A Synara server is already running for ${baseDir}${running.origin ? ` at ${running.origin}` : ""}. Stop it first (e.g. \`systemctl --user stop synara\`), then re-run setup — a running server holds the database lock, so pairing credentials can't be minted.`,
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
        message: `Port ${config.port} is already in use on this machine. Pass --port to pick another.`,
      });
    }

    yield* writeLine(`Writing configuration to ${config.baseDir} …`);
    const envFilePath = yield* writeEnvironmentFile(config);

    if (mode === "tailscale") {
      const serve = yield* configureTailscaleServe(config.port);
      if (serve.configured) {
        yield* writeLine(`tailscale serve → ${config.publicUrl}`);
      } else {
        const hint =
          tailscaleDiagnostic(serve.detail) === "permission-denied"
            ? `Try: sudo tailscale serve --bg http://127.0.0.1:${config.port}`
            : tailscaleDiagnostic(serve.detail) === "not-logged-in"
              ? "Run `tailscale up` to join a tailnet, then re-run setup."
              : `Fix with:\n  sudo tailscale serve --bg http://127.0.0.1:${config.port}`;
        yield* writeLine(
          `Warning: could not configure tailscale serve${serve.detail ? ` (${serve.detail})` : ""}. ${hint}`,
        );
      }
    }

    const pairing =
      config.mode === "loopback"
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
    if (serviceMode === "systemd-user") {
      const installed = yield* installSystemdUserService({
        serviceName: SETUP_SERVICE_NAME,
        envFilePath,
        executablePath,
        entrypointPath: entrypoint!,
        workingDirectory: config.baseDir,
        logFilePath: path.join(derivedPaths.logsDir, "server.log"),
      });
      const linger = yield* enableUserLinger();
      serviceSummary = `systemd --user unit ${installed.unitPath}${linger.enabled ? "; linger enabled (survives logout)" : ""}`;
    } else if (serviceMode === "nohup") {
      const pid = yield* startDetachedServer({
        envFilePath,
        executablePath,
        entrypointPath: entrypoint!,
        logPath: path.join(derivedPaths.logsDir, "server.log"),
      });
      serviceSummary = `nohup background process (pid ${pid}, log ${path.join(derivedPaths.logsDir, "server.log")})`;
    } else {
      serviceSummary = "manual start — commands below";
    }

    if (serviceMode !== "manual") {
      const probe = yield* waitForServerReady(localProbeOrigin(config));
      ready = probe.ready;
    }

    const lines: Array<string> = ["", "Synara remote setup complete.", ""];
    if (config.publicUrl) lines.push(`  Public URL:   ${config.publicUrl}`);
    lines.push(`  Bind:         http://${config.host}:${config.port}`);
    lines.push(`  Data dir:     ${config.baseDir}`);
    lines.push(`  Env file:     ${envFilePath} (mode 600 — holds SYNARA_AUTH_TOKEN)`);
    lines.push(`  Service:      ${serviceSummary}`);
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
        "  WARNING: plaintext HTTP on your LAN. Prefer the tailscale or public-url mode when you can.",
      );
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
    }
    if (serviceMode === "systemd-user") {
      lines.push("");
      lines.push("Manage:  systemctl --user status synara | restart | stop");
      lines.push("Logs:    journalctl --user -u synara -f");
    }
    if (!ready && serviceMode !== "manual") {
      lines.push("");
      lines.push(
        `Note: the server did not report ready within ${SETUP_HEALTH_TIMEOUT_MS / 1000}s — check ${path.join(derivedPaths.logsDir, "server.log")}${serviceMode === "systemd-user" ? " or journalctl --user -u synara" : ""}.`,
      );
    }
    lines.push("");
    yield* writeOutput(lines);
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
        message: `A Synara server is already running for ${baseDir}${running.origin ? ` at ${running.origin}` : ""}. Stop it first — a running server holds the database lock, so a pairing credential can't be minted.`,
      });
    }
    let baseUrl: string | undefined = Option.getOrUndefined(flags.url);
    if (!baseUrl && Option.isSome(parent.publicUrl)) {
      baseUrl = parent.publicUrl.value.toString();
    }
    if (!baseUrl) {
      baseUrl = process.env.SYNARA_PUBLIC_URL;
    }
    if (!baseUrl) {
      const port = Option.isSome(parent.port) ? parent.port.value : DEFAULT_PORT;
      baseUrl = `http://127.0.0.1:${port}`;
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
