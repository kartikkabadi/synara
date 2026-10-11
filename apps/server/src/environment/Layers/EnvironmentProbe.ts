import { sshProcessEnv } from "../sshProcessEnv";
// FILE: EnvironmentProbe.ts
// Purpose: Layer implementing EnvironmentProbe. Resolves the profile into an
//          ssh spawn plan, verifies the remote workspace root, runs
//          `codex --version` over ssh, applies the same minimum-version gate
//          as local sessions, and records the outcome on the descriptor's
//          connection in the registry.

import type {
  ExecutionEnvironmentConnection,
  ExecutionEnvironmentDescriptor,
  ExecutionProfile,
  ProviderSessionStartInput,
} from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import {
  compareCodexCliVersions,
  MINIMUM_CODEX_CLI_VERSION,
  parseCodexCliVersion,
} from "../../provider/codexCliVersion";
import { DEFAULT_REMOTE_BINARY, posixQuote, REMOTE_PID_SENTINEL_PREFIX } from "../sshCommand";
import {
  EnvironmentProbe,
  type EnvironmentProbeShape,
  RemoteEnvironmentUnsupportedVersionError,
} from "../Services/EnvironmentProbe";
import { ProviderSpawnError } from "../Services/ProviderProcessSpawner";
import { RemoteEnvironmentRegistry } from "../Services/RemoteEnvironmentRegistry";
import {
  RemoteEnvironmentNotFoundError,
  RemoteEnvironmentResolver,
  type RemoteAgentSpawnPlan,
  type SshSpawnPlan,
} from "../Services/RemoteEnvironmentResolver";
import { SshProcessProvider, type SshProcessExit } from "../Services/SshProcessProvider";

/** Keeps an unreachable host from hanging the probe RPC indefinitely. */
const PROBE_SSH_CONNECT_TIMEOUT_SECONDS = 10;

/** Probes never belong to a thread; the resolver only reads the profile. */
const PROBE_SESSION_START_INPUT_BASE = {
  threadId: ThreadId.makeUnsafe("__environment_probe__"),
  runtimeMode: "approval-required",
} as const satisfies Omit<ProviderSessionStartInput, "executionProfile">;

const nowIso = () => new Date().toISOString();

const passedConnection = (message: string): ExecutionEnvironmentConnection => {
  const checkedAt = nowIso();
  return {
    connectionStatus: "connected",
    lastSeenAt: checkedAt,
    healthCheckResult: { status: "passed", checkedAt, message },
  };
};

const failedConnection = (message: string): ExecutionEnvironmentConnection => ({
  connectionStatus: "error",
  healthCheckResult: { status: "failed", checkedAt: nowIso(), message },
});

/**
 * Swaps the plan's remote command (its last argv element) for a probe
 * command. Works for both ssh and remote-agent plans: the probe checks host
 * reachability and the provider binary, not the agent transport.
 */
const probePlan = (
  plan: SshSpawnPlan | RemoteAgentSpawnPlan,
  remoteCommand: string,
): SshSpawnPlan => ({
  kind: "ssh",
  sshArgs: [
    "-o",
    `ConnectTimeout=${PROBE_SSH_CONNECT_TIMEOUT_SECONDS}`,
    ...plan.sshArgs.slice(0, -1),
    remoteCommand,
  ],
  remoteCommand,
});

export const makeEnvironmentProbe = Effect.fn(function* () {
  const registry = yield* RemoteEnvironmentRegistry;
  const resolver = yield* RemoteEnvironmentResolver;
  const sshProvider = yield* SshProcessProvider;

  const runProbeCommand = (plan: SshSpawnPlan | RemoteAgentSpawnPlan, remoteCommand: string) =>
    sshProvider
      .spawnSsh(probePlan(plan, remoteCommand), {
        cwd: process.cwd(),
        env: sshProcessEnv(process.env),
      })
      .pipe(
        Effect.flatMap((spawned) =>
          Effect.tryPromise({
            try: (signal) =>
              new Promise<{ exit: SshProcessExit; stdout: string }>((resolve, reject) => {
                let stdout = "";
                let settled = false;
                const finish = (error?: Error, exit?: SshProcessExit) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  signal.removeEventListener("abort", abort);
                  if (error) {
                    spawned.kill("SIGTERM");
                    const escalation = setTimeout(() => spawned.kill("SIGKILL"), 1_000);
                    escalation.unref();
                    spawned.child.once("close", () => clearTimeout(escalation));
                    reject(error);
                  } else if (exit) resolve({ exit, stdout });
                };
                const abort = () => finish(new Error("Remote environment probe cancelled"));
                const timer = setTimeout(
                  () => finish(new Error("Remote environment probe timed out after 15 seconds")),
                  15_000,
                );
                signal.addEventListener("abort", abort, { once: true });
                spawned.child.stdout.on("error", (error) => finish(error));
                spawned.child.stdout.on("data", (chunk: Buffer) => {
                  if (settled) return;
                  if (Buffer.byteLength(stdout) + chunk.length > 65_536) {
                    finish(new Error("Remote environment probe output exceeded 64 KiB"));
                    return;
                  }
                  stdout += chunk.toString("utf8");
                });
                void spawned.exit.then(
                  (exit) => finish(undefined, exit),
                  (error: Error) => finish(error),
                );
                if (signal.aborted) abort();
              }),
            catch: (cause) => new ProviderSpawnError({ reason: String(cause) }),
          }),
        ),
      );

  const recordConnection = (
    descriptor: ExecutionEnvironmentDescriptor,
    connection: ExecutionEnvironmentConnection,
  ) => registry.upsert({ ...descriptor, connection });

  const check: EnvironmentProbeShape["check"] = (
    executionProfile: ExecutionProfile,
    options?: { readonly minimumVersion?: string },
  ) =>
    Effect.gen(function* () {
      const { environmentId } = executionProfile;
      const found = yield* registry.getById(environmentId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(new RemoteEnvironmentNotFoundError({ environmentId }));
      }
      const descriptor = found.value;

      const plan = yield* resolver.resolve(executionProfile, {
        ...PROBE_SESSION_START_INPUT_BASE,
        executionProfile,
      });
      if (plan.kind === "local") {
        return passedConnection("local environment");
      }

      const workspaceRoot = executionProfile.remoteWorkspaceRoot;
      const binary = descriptor.runtime?.remoteBinaryPath?.trim() || DEFAULT_REMOTE_BINARY;

      const workspaceProbe = yield* runProbeCommand(
        plan,
        `echo "${REMOTE_PID_SENTINEL_PREFIX}$$" && test -d ${posixQuote(workspaceRoot)}`,
      );
      if (workspaceProbe.exit.kind === "ssh-transport-error") {
        const connection = failedConnection(workspaceProbe.exit.error.message);
        yield* recordConnection(descriptor, connection);
        return connection;
      }
      if (workspaceProbe.exit.kind === "provider-process-error") {
        const connection = failedConnection(
          `remote workspace root ${JSON.stringify(workspaceRoot)} does not exist`,
        );
        yield* recordConnection(descriptor, connection);
        return connection;
      }

      const versionProbe = yield* runProbeCommand(
        plan,
        `echo "${REMOTE_PID_SENTINEL_PREFIX}$$" && cd ${posixQuote(workspaceRoot)} && exec ${posixQuote(binary)} --version`,
      );
      if (versionProbe.exit.kind !== "clean") {
        const connection = failedConnection(versionProbe.exit.error.message);
        yield* recordConnection(descriptor, connection);
        return connection;
      }

      const version = parseCodexCliVersion(versionProbe.stdout);
      const minimumVersion = options?.minimumVersion ?? MINIMUM_CODEX_CLI_VERSION;
      if (version === null || compareCodexCliVersions(version, minimumVersion) < 0) {
        const error = new RemoteEnvironmentUnsupportedVersionError({
          environmentId,
          version,
          minimumVersion,
        });
        yield* recordConnection(descriptor, failedConnection(error.message));
        return yield* Effect.fail(error);
      }

      const connection = passedConnection(`codex v${version}`);
      yield* recordConnection(descriptor, connection);
      return connection;
    });

  return { check } satisfies EnvironmentProbeShape;
});

export const EnvironmentProbeLive = Layer.effect(EnvironmentProbe, makeEnvironmentProbe());
