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
  isCodexCliVersionSupported,
  MINIMUM_CODEX_CLI_VERSION,
  parseCodexCliVersion,
} from "../../provider/codexCliVersion";
import { DEFAULT_REMOTE_BINARY, posixQuote } from "../sshCommand";
import {
  EnvironmentProbe,
  type EnvironmentProbeShape,
  RemoteEnvironmentUnsupportedVersionError,
} from "../Services/EnvironmentProbe";
import { RemoteEnvironmentRegistry } from "../Services/RemoteEnvironmentRegistry";
import {
  RemoteEnvironmentNotFoundError,
  RemoteEnvironmentResolver,
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

/** Swaps the plan's remote command (its last argv element) for a probe command. */
const probePlan = (plan: SshSpawnPlan, remoteCommand: string): SshSpawnPlan => ({
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

  const runProbeCommand = (plan: SshSpawnPlan, remoteCommand: string) =>
    sshProvider
      .spawnSsh(probePlan(plan, remoteCommand), { cwd: process.cwd(), env: process.env })
      .pipe(
        Effect.flatMap((spawned) =>
          Effect.promise(async (): Promise<{ exit: SshProcessExit; stdout: string }> => {
            let stdout = "";
            spawned.child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            });
            const exit = await spawned.exit;
            return { exit, stdout };
          }),
        ),
      );

  const recordConnection = (
    descriptor: ExecutionEnvironmentDescriptor,
    connection: ExecutionEnvironmentConnection,
  ) => registry.upsert({ ...descriptor, connection });

  const check: EnvironmentProbeShape["check"] = (executionProfile: ExecutionProfile) =>
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
        `echo $$ && test -d ${posixQuote(workspaceRoot)}`,
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
        `echo $$ && cd ${posixQuote(workspaceRoot)} && exec ${posixQuote(binary)} --version`,
      );
      if (versionProbe.exit.kind !== "clean") {
        const connection = failedConnection(versionProbe.exit.error.message);
        yield* recordConnection(descriptor, connection);
        return connection;
      }

      const version = parseCodexCliVersion(versionProbe.stdout);
      if (version === null || !isCodexCliVersionSupported(version)) {
        const error = new RemoteEnvironmentUnsupportedVersionError({
          environmentId,
          version,
          minimumVersion: MINIMUM_CODEX_CLI_VERSION,
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
