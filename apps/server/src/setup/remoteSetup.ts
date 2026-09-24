// FILE: remoteSetup.ts
// Purpose: Effect-side orchestration for `synara setup` — executable and
//          service-manager detection, Tailscale serve configuration, env-file
//          and systemd-unit writes, background launch, health polling, and
//          owner pairing-link issuance.
// Layer: Server remote-setup orchestration

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { Data, DateTime, Duration, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "../privatePathPermissions";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite";
import { BootstrapCredentialServiceLive } from "../auth/Layers/BootstrapCredentialService";
import { BootstrapCredentialService } from "../auth/Services/BootstrapCredentialService";
import { deriveServerPaths } from "../config";
import { discoverServerRuntime } from "../externalMcp/bridge";
import { fetchSynaraServerStatus } from "../serverStatusCli";
import { makeEffectProcessCommand } from "../platform/effectProcessRuntime";
import {
  buildPairingUrl,
  environmentFilePath,
  isPermissionFailure,
  isUnknownFlagFailure,
  parseTailscaleServeStatus,
  parseTailscaleStatus,
  renderEnvironmentFile,
  renderSystemdUserService,
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

    // Inspect the existing mapping first: idempotent re-runs must not stack a
    // second route, and a / mount pointing at a different backend would leave
    // the pairing URL silently broken behind the wrong port.
    let status = yield* runCommand("tailscale", ["serve", "status", "--json"], {
      timeoutMs: 5_000,
    });
    if (!status.ok && isPermissionFailure(status)) {
      status = yield* runCommand("sudo", ["-n", "tailscale", "serve", "status", "--json"], {
        timeoutMs: 5_000,
      });
    }
    if (status.ok) {
      const parsed = parseTailscaleServeStatus(status.output);
      for (const proxy of parsed.rootProxies) {
        if (proxy === target || proxy === `http://localhost:${port}`) {
          return { configured: true, detail: `Already serving ${target} on the tailnet.` };
        }
      }
      if (parsed.serving && parsed.rootProxies.length > 0) {
        return {
          configured: false,
          conflict: parsed.rootProxies.join(", "),
          detail: `tailscale serve already forwards / to ${parsed.rootProxies.join(", ")}. Remove it with \`tailscale serve --https=443 off\` (or clear the stale route), then re-run setup.`,
        };
      }
      // serving with unparseable targets (text output) — proceed; a conflicted
      // serve command fails loudly below either way.
    }

    const run = (viaSudo: boolean, extra: ReadonlyArray<string>) =>
      viaSudo
        ? runCommand("sudo", ["-n", "tailscale", "serve", "--bg", ...extra, target], {
            timeoutMs: 15_000,
          })
        : runCommand("tailscale", ["serve", "--bg", ...extra, target], { timeoutMs: 15_000 });
    let result = yield* run(false, ["--yes"]);
    if (!result.ok && isUnknownFlagFailure(result, "--yes")) {
      result = yield* run(false, []);
    }
    if (!result.ok && isPermissionFailure(result)) {
      result = yield* run(true, ["--yes"]);
      if (!result.ok && isUnknownFlagFailure(result, "--yes")) {
        result = yield* run(true, []);
      }
    }
    return { configured: result.ok, detail: result.output };
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

export interface RunningInstance {
  readonly running: boolean;
  readonly origin?: string | undefined;
  readonly multiple?: boolean | undefined;
}

/** Reports whether a live Synara server already owns this home directory. */
export const detectRunningInstance = (baseDir: string): Effect.Effect<RunningInstance, never> =>
  Effect.sync(() => {
    try {
      return discoverServerRuntime(baseDir);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return message.includes("Multiple running") ? "multiple" : null;
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
        return status.reachable
          ? { running: true, origin: runtime.state.origin }
          : { running: false };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed<RunningInstance>({ running: true, origin: runtime.state.origin }),
        ),
      );
    }),
  );

/**
 * Writes the EnvironmentFile holding SYNARA_AUTH_TOKEN next to the home dir
 * with private file permissions, never through shell redirection.
 */
export const writeEnvironmentFile = (
  config: RemoteSetupConfig,
): Effect.Effect<string, RemoteSetupError> =>
  Effect.try({
    try: () => {
      ensurePrivateDirectorySync(config.baseDir);
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
    const unitDir = systemdUserUnitDirectory(process.env.HOME ?? "", process.env.XDG_CONFIG_HOME);
    const unitPath = path.join(unitDir, `${input.serviceName}.service`);
    const unitContents = renderSystemdUserService({
      serviceName: input.serviceName,
      envFilePath: input.envFilePath,
      executablePath: input.executablePath,
      entrypointPath: input.entrypointPath,
      workingDirectory: input.workingDirectory,
      logFilePath: input.logFilePath,
    });
    yield* Effect.try({
      try: () => fs.mkdirSync(unitDir, { recursive: true }),
      catch: (cause) => new RemoteSetupError({ message: `Failed to create ${unitDir}.`, cause }),
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
      return yield* new RemoteSetupError({
        message: `systemctl --user enable --now ${input.serviceName} failed: ${enable.output}`,
      });
    }
    return { unitPath, serviceName: input.serviceName };
  });

export const enableUserLinger = (): Effect.Effect<
  { readonly enabled: boolean; readonly detail: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const direct = yield* runCommand("loginctl", ["enable-linger"], { timeoutMs: 8_000 });
    if (direct.ok) return { enabled: true, detail: direct.output };
    if (isPermissionFailure(direct)) {
      const elevated = yield* runCommand("sudo", ["-n", "loginctl", "enable-linger"], {
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
    const shellCommand = `set -a; . ${input.envFilePath}; set +a; nohup ${input.executablePath} ${input.entrypointPath} --no-browser >>${input.logPath} 2>&1 </dev/null & echo $!`;
    const pidLine = yield* spawner
      .string(
        ChildProcess.make("sh", ["-c", shellCommand], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
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
        const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
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
        (cause) =>
          new RemoteSetupError({
            message:
              "Failed to mint a pairing link. A running Synara server holds the database lock for this home directory — stop it first.",
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
