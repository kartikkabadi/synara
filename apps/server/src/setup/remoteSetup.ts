// FILE: remoteSetup.ts
// Purpose: Effect-side orchestration for `synara setup` — executable and
//          service-manager detection, Tailscale serve configuration, env-file
//          and systemd-unit writes, background launch, health polling, and
//          owner pairing-link issuance.
// Layer: Server remote-setup orchestration

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Data, DateTime, Duration, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "../privatePathPermissions";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite";
import { BootstrapCredentialServiceLive } from "../auth/Layers/BootstrapCredentialService";
import { BootstrapCredentialService } from "../auth/Services/BootstrapCredentialService";
import { deriveServerPaths } from "../config";
import { discoverServerRuntime, ExternalMcpBridgeError } from "../externalMcp/bridge";
import { DatabaseLifecycleLockedError } from "../persistence/DatabaseLifecycleLock";
import { fetchSynaraServerStatus } from "../serverStatusCli";
import { isWildcardHost } from "../startupAccess";
import { makeEffectProcessCommand } from "../platform/effectProcessRuntime";
import {
  buildPairingUrl,
  environmentFilePath,
  isPermissionFailure,
  isUnknownFlagFailure,
  parseEnvironmentValue,
  parseTailscaleServeStatus,
  parseTailscaleStatus,
  renderEnvironmentFile,
  renderSystemdUserService,
  shellQuotePath,
  systemdUserUnitDirectory,
  type CommandResultSummary,
  type RemoteSetupConfig,
  SETUP_HEALTH_INTERVAL_MS,
  SETUP_HEALTH_TIMEOUT_MS,
} from "./remoteSetupPlan";

export class RemoteSetupError extends Data.TaggedError("RemoteSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) =>
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    ),
  );

/**
 * Runs a command to completion, capturing stdout+stderr+exit code. Spawn
 * failures (missing executable) degrade to a non-ok result so callers can
 * branch on detection without exception plumbing.
 */
const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly cwd?: string | undefined;
    readonly timeoutMs?: number | undefined;
  } = {},
): Effect.Effect<CommandResultSummary, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      makeEffectProcessCommand(command, args, {
        stdin: "ignore",
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env, extendEnv: false } : {}),
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return {
      ok: exitCode === 0,
      exitCode,
      output: `${stdout}\n${stderr}`.trim(),
    } satisfies CommandResultSummary;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(options.timeoutMs ?? 30_000),
    Effect.map((result) =>
      result._tag === "Some"
        ? result.value
        : ({
            ok: false,
            exitCode: -1,
            output: `timed out after ${options.timeoutMs ?? 30_000}ms`,
          } satisfies CommandResultSummary),
    ),
    // Spawn can fail as a defect (a non-directory PATH entry makes node throw
    // ENOTDIR synchronously) — degrade it to a non-ok result like any other
    // detection failure instead of crashing the wizard.
    Effect.catchDefect((cause) =>
      Effect.succeed({
        ok: false,
        exitCode: -1,
        output: cause instanceof Error ? cause.message : String(cause),
      } satisfies CommandResultSummary),
    ),
    Effect.catch((cause) =>
      Effect.succeed({
        ok: false,
        exitCode: -1,
        output: cause instanceof Error ? cause.message : String(cause),
      } satisfies CommandResultSummary),
    ),
  );

const commandExists = (
  command: string,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runCommand(command, ["--version"]).pipe(Effect.map((result) => result.ok));

export interface TailscaleDetection {
  readonly installed: boolean;
  readonly running: boolean;
  readonly dnsName: string | undefined;
  readonly ipv4: string | undefined;
  readonly backendState: string | undefined;
  /** Self.Online — false means the node is registered but not reachable. */
  readonly online: boolean;
  /** The node's DNSName is present in CertDomains — required for serve HTTPS. */
  readonly httpsCerts: boolean;
  readonly detail?: string | undefined;
}

/** Probes tailscaled state and the node's MagicDNS name via `tailscale status --json`. */
export const detectTailscale: Effect.Effect<
  TailscaleDetection,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const notInstalled: TailscaleDetection = {
    installed: false,
    running: false,
    dnsName: undefined,
    ipv4: undefined,
    backendState: undefined,
    online: false,
    httpsCerts: false,
  };
  if (!(yield* commandExists("tailscale"))) return notInstalled;
  const status = yield* runCommand("tailscale", ["status", "--json"], { timeoutMs: 5_000 });
  let parsed = status.ok ? parseTailscaleStatus(status.output) : null;
  if (!parsed && isPermissionFailure(status)) {
    const elevated = yield* runCommand("sudo", ["-n", "tailscale", "status", "--json"], {
      timeoutMs: 5_000,
    });
    if (elevated.ok) parsed = parseTailscaleStatus(elevated.output);
  }
  if (!parsed) {
    return {
      installed: true,
      running: false,
      dnsName: undefined,
      ipv4: undefined,
      backendState: undefined,
      online: false,
      httpsCerts: false,
      detail: status.output,
    };
  }
  return {
    installed: true,
    running: parsed.backendState === "Running" && parsed.online,
    dnsName: parsed.dnsName,
    ipv4: parsed.ipv4,
    backendState: parsed.backendState,
    online: parsed.online,
    httpsCerts: parsed.httpsCerts,
  };
});

export interface TailscaleServeResult {
  readonly configured: boolean;
  readonly detail: string;
  /** The existing `/` proxy target found in serve config, when it blocks us. */
  readonly conflict?: string | undefined;
  /** The tailnet HTTPS port actually serving us (defaults to 443). */
  readonly servePort?: number | undefined;
}

/**
 * Points `tailscale serve` at the loopback server. Serve config is daemon-side
 * and survives process exit and reboots, so first inspect the current mapping:
 * a `/` mount already pointing at our port is reused as-is; a `/` mount
 * pointing elsewhere is a conflict we refuse to stack behind. Retries without
 * `--yes` on older CLIs that lack the flag, and through sudo -n on permission
 * failures.
 */
export const configureTailscaleServe = (
  port: number,
): Effect.Effect<TailscaleServeResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const target = `http://127.0.0.1:${port}`;

    const readStatus = () =>
      Effect.gen(function* () {
        let status = yield* runCommand("tailscale", ["serve", "status", "--json"], {
          timeoutMs: 5_000,
        });
        if (!status.ok && isPermissionFailure(status)) {
          status = yield* runCommand("sudo", ["-n", "tailscale", "serve", "status", "--json"], {
            timeoutMs: 5_000,
          });
        }
        return status;
      });

    const matchesTarget = (mount: { proxy: string }) =>
      mount.proxy === target || mount.proxy === `http://localhost:${port}`;

    // Inspect the existing mapping first: `serve --bg` silently REPLACES a `/`
    // handler of the same type on the same port, so applying blindly could
    // clobber someone else's service. Refuse on any unreadable or conflicting
    // mount rather than stack a broken route.
    const status = yield* readStatus();
    if (!status.ok) {
      return {
        configured: false,
        detail: `could not read \`tailscale serve status\` (${status.output.trim() || "command failed"}). Inspect it manually — applying blindly could overwrite an existing / route — then re-run setup.`,
      };
    }
    const parsed = parseTailscaleServeStatus(status.output);
    for (const mount of parsed.rootMounts) {
      if (matchesTarget(mount)) {
        return {
          configured: true,
          servePort: mount.port,
          detail: `Already serving ${target} on the tailnet.`,
        };
      }
    }
    const claimed = parsed.rootMounts.filter((m) => m.port === 443);
    if (claimed.length > 0) {
      const list = claimed.map((m) => m.proxy).join(", ");
      return {
        configured: false,
        conflict: list,
        detail: `tailscale serve already claims / on the tailnet (${list}). Remove it with \`tailscale serve --https=443 off\` (or clear the stale route), then re-run setup.`,
      };
    }
    if (parsed.targetsUnknown) {
      return {
        configured: false,
        detail: `tailscale serve is active but its routes could not be decoded — inspect \`tailscale serve status\` manually (applying blindly could overwrite an existing / route), then re-run setup.`,
      };
    }

    const run = (viaSudo: boolean, extra: ReadonlyArray<string>) =>
      viaSudo
        ? runCommand("sudo", ["-n", "tailscale", "serve", ...extra, target], {
            timeoutMs: 15_000,
          })
        : runCommand("tailscale", ["serve", ...extra, target], { timeoutMs: 15_000 });
    // Older CLIs reject --bg and/or --yes; start full-featured and degrade
    // flag-by-flag, remembering whether persistence (--bg) survived.
    const variants: ReadonlyArray<ReadonlyArray<string>> = [
      ["--bg", "--yes"],
      ["--bg"],
      ["--yes"],
      [],
    ];
    const apply = (viaSudo: boolean) =>
      Effect.gen(function* () {
        let result = yield* run(viaSudo, variants[0]!);
        let used: ReadonlyArray<string> = variants[0]!;
        for (const extra of variants.slice(1)) {
          if (result.ok || !isUnknownFlagFailure(result)) break;
          result = yield* run(viaSudo, extra);
          used = extra;
        }
        return { result, persistent: used.includes("--bg") };
      });
    let { result, persistent } = yield* apply(false);
    if (!result.ok && isPermissionFailure(result)) {
      ({ result, persistent } = yield* apply(true));
    }

    // Verify the daemon-side mapping regardless of the command's exit: a
    // silently stale apply shows up here, and so does a config an older CLI
    // wrote before dying on an unknown flag.
    const verify = yield* readStatus();
    if (verify.ok) {
      const verified = parseTailscaleServeStatus(verify.output).rootMounts.find(matchesTarget);
      if (verified) {
        const detail = persistent
          ? result.output
          : `${result.output}\nNote: this Tailscale CLI doesn't support --bg — the serve mapping works now but won't survive a tailscaled restart. Upgrade Tailscale, then re-run \`tailscale serve --bg http://127.0.0.1:${port}\`.`;
        return { configured: true, servePort: verified.port, detail };
      }
    }
    return { configured: false, detail: result.output };
  });

/**
 * Finds an existing `tailscale serve` `/` mount proxying to our port, for the
 * warn-when-leaving-stale-routes check on non-tailscale re-runs.
 */
export const findTailscaleServeRoute = (
  port: number,
): Effect.Effect<number | undefined, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const status = yield* runCommand("tailscale", ["serve", "status", "--json"], {
      timeoutMs: 5_000,
    });
    if (!status.ok) return undefined;
    const parsed = parseTailscaleServeStatus(status.output);
    const match = parsed.rootMounts.find(
      (m) => m.proxy === `http://127.0.0.1:${port}` || m.proxy === `http://localhost:${port}`,
    );
    return match?.port;
  });

export const detectSystemdUser: Effect.Effect<
  boolean,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  if (process.platform !== "linux") return false;
  if (!(yield* commandExists("systemctl"))) return false;
  const probe = yield* runCommand("systemctl", ["--user", "is-system-running"], {
    timeoutMs: 8_000,
  });
  // Exit 0 on "running"; non-zero on degraded/starting still means a live manager.
  return probe.ok || /^(degraded|starting|maintenance|initializing|stopping)/.test(probe.output);
});

/**
 * firewalld (Fedora/RHEL defaults) drops tailnet HTTPS on `tailscale0` unless
 * the interface sits in a trusted/custom zone — serve configures fine and the
 * local health probe passes while remote clients can't connect.
 */
export const checkFirewalldTailscaleAccess = (): Effect.Effect<
  { readonly ok: boolean; readonly detail: string | undefined },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    if (process.platform !== "linux") return { ok: true, detail: undefined };
    if (!(yield* commandExists("firewall-cmd"))) return { ok: true, detail: undefined };
    const state = yield* runCommand("firewall-cmd", ["--state"], { timeoutMs: 5_000 });
    if (!state.ok || !/^running/.test(state.output.trim())) {
      return { ok: true, detail: undefined };
    }
    const zones = yield* runCommand("firewall-cmd", ["--get-active-zones"], {
      timeoutMs: 5_000,
    });
    if (!zones.ok) return { ok: true, detail: undefined };
    // Tailscale creates `tailscale0` (or tailscaleNN); any zone owning it
    // means the admin already placed it deliberately.
    if (/tailscale\d*/.test(zones.output)) return { ok: true, detail: undefined };
    return {
      ok: false,
      detail:
        "firewalld is running and no zone claims tailscale0 — tailnet HTTPS may be dropped. Allow it with `sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 && sudo firewall-cmd --reload`.",
    };
  });

export interface RunningInstance {
  readonly running: boolean;
  readonly origin?: string | undefined;
  readonly multiple?: boolean | undefined;
  readonly pid?: number | undefined;
}

/** Reports whether a live Synara server already owns this home directory. */
export const detectRunningInstance = (baseDir: string): Effect.Effect<RunningInstance, never> =>
  Effect.sync(() => {
    try {
      return discoverServerRuntime(baseDir);
    } catch (cause) {
      const multiple =
        cause instanceof ExternalMcpBridgeError
          ? cause.code === "multiple_running_instances"
          : cause instanceof Error && cause.message.includes("Multiple running");
      return multiple ? "multiple" : null;
    }
  }).pipe(
    Effect.flatMap((runtime) => {
      if (runtime === "multiple") {
        return Effect.succeed<RunningInstance>({ running: true, multiple: true });
      }
      if (!runtime) return Effect.succeed<RunningInstance>({ running: false });
      return Effect.promise(async () => {
        const status = await fetchSynaraServerStatus({
          url: runtime.state.origin,
          timeoutMs: 2_000,
        });
        if (status.reachable) {
          return { running: true, origin: runtime.state.origin, pid: runtime.state.pid };
        }
        // HTTP unreachable (broken listener, wedged accept loop) but a live
        // pid still owns the lifecycle lock — treating it as "not running"
        // lets setup rewrite the env file and fail the mint at the lock.
        try {
          process.kill(runtime.state.pid, 0);
          return { running: true, origin: runtime.state.origin, pid: runtime.state.pid };
        } catch {
          return { running: false };
        }
      }).pipe(
        Effect.catch(() =>
          Effect.succeed<RunningInstance>({
            running: true,
            origin: runtime.state.origin,
            pid: runtime.state.pid,
          }),
        ),
      );
    }),
  );

/** Reads one KEY from the setup env file; undefined when absent/unreadable. */
export const readSetupEnvironmentValue = (baseDir: string, key: string): string | undefined => {
  try {
    const contents = fs.readFileSync(environmentFilePath(baseDir), "utf8");
    return parseEnvironmentValue(contents, key);
  } catch {
    return undefined;
  }
};

/**
 * Writes the EnvironmentFile holding SYNARA_AUTH_TOKEN next to the home dir
 * with private file permissions, never through shell redirection.
 */
export const writeEnvironmentFile = (
  config: RemoteSetupConfig,
): Effect.Effect<string, RemoteSetupError> =>
  Effect.try({
    try: () => {
      // Only tighten permissions on a directory this process created — a
      // pre-existing baseDir (--home-dir /shared/dir, or even ~) may be
      // shared or intentionally group-accessible, and silently chmod'ing it
      // would lock other users out. The env file itself is always 0600.
      const baseDirExisted = fs.existsSync(config.baseDir);
      if (baseDirExisted) {
        fs.mkdirSync(config.baseDir, { recursive: true });
      } else {
        ensurePrivateDirectorySync(config.baseDir);
      }
      const envFilePath = environmentFilePath(config.baseDir);
      // Temp+rename so an interrupted write never leaves a truncated env file.
      const tmpPath = `${envFilePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmpPath, renderEnvironmentFile(config), { mode: 0o600 });
      fs.renameSync(tmpPath, envFilePath);
      ensurePrivateFileSync(envFilePath);
      return envFilePath;
    },
    catch: (cause) =>
      new RemoteSetupError({
        message: `Failed to write ${environmentFilePath(config.baseDir)}.`,
        cause,
      }),
  });

/** The packaged server entrypoint; undefined when running from a source .ts entry. */
export const resolvePackagedEntrypoint = (): string | undefined => {
  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;
  const resolved = path.resolve(entrypoint);
  return resolved.endsWith(".ts") ? undefined : resolved;
};

export interface ServiceInstallResult {
  readonly unitPath: string;
  readonly serviceName: string;
  /** True when an existing unit was replaced. */
  readonly replaced: boolean;
}

export const installSystemdUserService = (input: {
  readonly serviceName: string;
  readonly envFilePath: string;
  readonly executablePath: string;
  readonly entrypointPath: string;
  readonly workingDirectory?: string | undefined;
  readonly logFilePath?: string | undefined;
}): Effect.Effect<
  ServiceInstallResult,
  RemoteSetupError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const home = process.env.HOME;
    if (!home) {
      return yield* new RemoteSetupError({
        message:
          "HOME is not set — can't locate the systemd user unit directory (common under cron/sudo). Export HOME or use --service nohup.",
      });
    }
    const unitDir = systemdUserUnitDirectory(home, process.env.XDG_CONFIG_HOME);
    const unitPath = path.join(unitDir, `${input.serviceName}.service`);
    // `systemctl --version` prints "systemd 245 (245.4-4ubuntu3)" — the
    // `append:` output target needs ≥240 (breaks CentOS 7 / Ubuntu 18.04).
    const versionOut = yield* runCommand("systemctl", ["--version"], { timeoutMs: 5_000 });
    const versionMatch = /systemd (\d+)/.exec(versionOut.output);
    const systemdVersion = versionMatch ? Number(versionMatch[1]) : undefined;
    const unitContents = renderSystemdUserService({
      serviceName: input.serviceName,
      envFilePath: input.envFilePath,
      executablePath: input.executablePath,
      entrypointPath: input.entrypointPath,
      workingDirectory: input.workingDirectory,
      logFilePath: input.logFilePath,
      systemdVersion,
    });
    yield* Effect.try({
      try: () => fs.mkdirSync(unitDir, { recursive: true }),
      catch: (cause) => new RemoteSetupError({ message: `Failed to create ${unitDir}.`, cause }),
    });
    const replaced = yield* Effect.try({
      try: () => fs.existsSync(unitPath),
      catch: () => new RemoteSetupError({ message: `Failed to stat ${unitPath}.` }),
    });
    yield* Effect.try({
      try: () => {
        // Temp+rename so a crash mid-write can't leave a half unit systemd loads.
        const tmpPath = `${unitPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, unitContents);
        fs.renameSync(tmpPath, unitPath);
      },
      catch: (cause) => new RemoteSetupError({ message: `Failed to write ${unitPath}.`, cause }),
    });

    const reload = yield* runCommand("systemctl", ["--user", "daemon-reload"], {
      timeoutMs: 10_000,
    });
    if (!reload.ok) {
      return yield* new RemoteSetupError({
        message: `systemctl --user daemon-reload failed: ${reload.output}. A user systemd session needs XDG_RUNTIME_DIR set (it is missing when sudoing into the machine).`,
      });
    }
    const enable = yield* runCommand(
      "systemctl",
      ["--user", "enable", "--now", `${input.serviceName}.service`],
      { timeoutMs: 15_000 },
    );
    if (!enable.ok) {
      // Don't leave an enabled unit that retry-loops at the next login —
      // disable best-effort and tell the user the unit file still exists.
      yield* runCommand("systemctl", ["--user", "disable", `${input.serviceName}.service`], {
        timeoutMs: 10_000,
      });
      return yield* new RemoteSetupError({
        message: `systemctl --user enable --now ${input.serviceName} failed: ${enable.output}. The unit at ${unitPath} was disabled again — remove it manually or fix the error and \`systemctl --user enable --now ${input.serviceName}\` yourself.`,
      });
    }
    return { unitPath, serviceName: input.serviceName, replaced };
  });

export const enableUserLinger = (): Effect.Effect<
  { readonly enabled: boolean; readonly detail: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    // enable-linger resolves against the calling uid when no USER is given —
    // under sudo that's root, so pass the invoking user explicitly. Minimal
    // containers can lack a passwd entry for the uid; fall back to it.
    let user = process.env.SUDO_USER ?? "";
    if (!user) {
      try {
        user = os.userInfo().username;
      } catch {
        user = String(process.getuid?.() ?? "");
      }
    }
    const args = user ? ["enable-linger", user] : ["enable-linger"];
    const direct = yield* runCommand("loginctl", args, { timeoutMs: 8_000 });
    if (direct.ok) return { enabled: true, detail: direct.output };
    if (isPermissionFailure(direct)) {
      if (!user) return { enabled: false, detail: direct.output };
      const elevated = yield* runCommand("sudo", ["-n", "loginctl", ...args], {
        timeoutMs: 8_000,
      });
      if (elevated.ok) return { enabled: true, detail: elevated.output };
      return { enabled: false, detail: elevated.output || direct.output };
    }
    return { enabled: false, detail: direct.output };
  });

/**
 * Background launch for hosts without a user systemd session: `nohup` under a
 * shell so the server survives the wizard exiting. The pid is echoed back.
 */
export const startDetachedServer = (input: {
  readonly envFilePath: string;
  readonly executablePath: string;
  readonly entrypointPath: string;
  readonly logPath: string;
}): Effect.Effect<number, RemoteSetupError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const shellCommand = `set -a; . ${shellQuotePath(input.envFilePath)}; set +a; nohup ${shellQuotePath(input.executablePath)} ${shellQuotePath(input.entrypointPath)} --no-browser >>${shellQuotePath(input.logPath)} 2>&1 </dev/null & echo $!`;
    // detached:false is load-bearing: with the default detached:true, `sh`
    // gets its own process group that the `&`-launched server shares, and the
    // spawner's scope finalizer SIGTERMs the whole group when stdout closes
    // before `sh` exits — killing the fresh server ~half the time.
    // Ambient SYNARA_*/VITE_* vars are scrubbed so the env file is the sole
    // config source; an inherited VITE_DEV_SERVER_URL would flip the server
    // into dev mode and fail the remote-access policy check.
    const spawnEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("SYNARA_") && !key.startsWith("VITE_")) {
        spawnEnv[key] = value;
      }
    }
    const pidLine = yield* spawner
      .string(
        ChildProcess.make("sh", ["-c", shellCommand], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: false,
          env: spawnEnv,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoteSetupError({
              message: "Failed to launch the background Synara server.",
              cause,
            }),
        ),
      );
    const pid = Number.parseInt(pidLine.trim(), 10);
    if (!Number.isFinite(pid)) {
      return yield* new RemoteSetupError({
        message: `Background launch did not report a pid (got ${JSON.stringify(pidLine)}).`,
      });
    }
    // The subshell reports $! before nohup even runs — a spawn that dies
    // instantly (missing log dir, bad entrypoint) would otherwise look
    // successful until the readiness poll times out 30s later.
    yield* Effect.sleep(400);
    const alive = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) {
      return yield* new RemoteSetupError({
        message: `The background Synara server (pid ${pid}) exited immediately — check ${input.logPath} for the error.`,
      });
    }
    return pid;
  });

/**
 * Probes whether something already listens on the port the server will bind.
 * A refused connection means free; a successful connect or a timeout means
 * taken (or filtered — treat as busy so the wizard warns early).
 */
export const checkPortAvailable = (
  host: string,
  port: number,
): Effect.Effect<{ readonly available: boolean }, never> =>
  Effect.promise(
    () =>
      new Promise<{ available: boolean }>((resolve) => {
        const probeHost = isWildcardHost(host) ? "127.0.0.1" : host;
        const socket = net.createConnection({ host: probeHost, port });
        socket.setTimeout(1_500);
        socket.once("connect", () => {
          socket.destroy();
          resolve({ available: false });
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve({ available: false });
        });
        socket.once("error", (error) => {
          socket.destroy();
          // ECONNREFUSED means nothing listens; other errors are treated
          // conservatively as busy so the wizard warns early.
          resolve({
            available: (error as NodeJS.ErrnoException).code === "ECONNREFUSED",
          });
        });
      }),
  ).pipe(Effect.catch(() => Effect.succeed({ available: true })));

export const waitForServerReady = (
  probeOrigin: string,
): Effect.Effect<{ readonly ready: boolean; readonly origin: string }, never> =>
  Effect.gen(function* () {
    const deadline = Date.now() + SETUP_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = yield* Effect.promise(() =>
        fetchSynaraServerStatus({ url: probeOrigin, timeoutMs: SETUP_HEALTH_INTERVAL_MS }),
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      if (status?.reachable && status.ready) {
        return { ready: true, origin: status.url };
      }
      yield* Effect.sleep(Duration.millis(SETUP_HEALTH_INTERVAL_MS));
    }
    return { ready: false, origin: probeOrigin };
  });

/**
 * Mints an owner pairing credential against the home directory's database.
 * The database lifecycle lock means this only succeeds while no server owns
 * the home directory — mint before starting, or while stopped.
 */
export const issueOwnerPairingUrl = (input: {
  readonly baseDir: string;
  readonly baseUrl: string;
  readonly ttl: Duration.Duration;
  readonly label?: string | undefined;
}): Effect.Effect<
  { readonly url: string; readonly expiresAt: Date },
  RemoteSetupError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    // A dev-mode home keeps its database under dev/, not userdata/ — minting
    // there would land the credential in a database no server reads.
    if (
      fs.existsSync(path.join(input.baseDir, "dev", "state.sqlite")) &&
      !fs.existsSync(path.join(input.baseDir, "userdata", "state.sqlite"))
    ) {
      return yield* new RemoteSetupError({
        message: `${input.baseDir} belongs to a dev-mode Synara (dev/ database, not userdata/) — pairing here mints into the wrong database. Use a separate --home-dir for a fresh install, or pair from the running dev server's Settings UI.`,
      });
    }
    const derivedPaths = yield* deriveServerPaths(input.baseDir, undefined);
    const mint = Effect.gen(function* () {
      const credentials = yield* BootstrapCredentialService;
      return yield* credentials.issueOneTimeToken({
        role: "owner",
        subject: "owner-bootstrap",
        ttl: input.ttl,
        ...(input.label ? { label: input.label } : {}),
      });
    }).pipe(
      Effect.provide(
        BootstrapCredentialServiceLive.pipe(
          Layer.provideMerge(makeSqlitePersistenceLive(derivedPaths.dbPath)),
        ),
      ),
      Effect.scoped,
      Effect.mapError(
        // Only the lifecycle lock means "stop the running server" — migrations,
        // FS permission, or corrupt-DB failures need their real cause shown.
        (cause) =>
          new RemoteSetupError({
            message:
              cause instanceof DatabaseLifecycleLockedError
                ? "Failed to mint a pairing link. A running Synara server holds the database lock for this home directory — stop it first."
                : `Failed to mint a pairing link: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      ),
    );
    const issued = yield* mint;
    return {
      url: buildPairingUrl(input.baseUrl, issued.credential),
      expiresAt: DateTime.toDate(issued.expiresAt),
    };
  });
