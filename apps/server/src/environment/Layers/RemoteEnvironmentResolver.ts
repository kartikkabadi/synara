// FILE: RemoteEnvironmentResolver.ts
// Purpose: Layer implementing RemoteEnvironmentResolver. Looks up the
//          environment descriptor, validates provider support, verifies the
//          ssh host key (fail-closed), and returns a SpawnPlan. No spawning.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import type { ExecutionProfile, ProviderSessionStartInput } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import {
  buildAgentSshArgv,
  buildRemoteCommand,
  buildSshArgv,
  DEFAULT_REMOTE_BINARY,
  REMOTE_APP_SERVER_ARG,
  SshCommandError,
} from "../sshCommand";
import { pinnedKnownHostEntryFromContents } from "../sshHostKey";
import { ServerConfig } from "../../config";
import { RemoteEnvironmentRegistry } from "../Services/RemoteEnvironmentRegistry";
import {
  KnownHostsPath,
  RemoteEnvironmentHostKeyError,
  RemoteEnvironmentNotFoundError,
  RemoteEnvironmentProviderKindError,
  RemoteEnvironmentResolver,
  type RemoteEnvironmentResolverShape,
  RemoteEnvironmentUnsupportedRuntimeError,
  type SpawnPlan,
} from "../Services/RemoteEnvironmentResolver";

export const makeRemoteEnvironmentResolver = Effect.fn(function* (options?: {
  readonly originId?: string;
}) {
  const registry = yield* RemoteEnvironmentRegistry;
  const knownHostsPath = yield* KnownHostsPath;
  const config = yield* Effect.serviceOption(ServerConfig);
  const originId =
    options?.originId ??
    Option.map(config, (value) => `${hostname()}:${value.environmentIdPath}`).pipe(
      Option.getOrUndefined,
    );

  const trustDir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "synara-ssh-trust-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const resolve = (
    executionProfile: ExecutionProfile,
    providerSessionStartInput: ProviderSessionStartInput,
  ) =>
    Effect.gen(function* () {
      const { environmentId, providerKind } = executionProfile;
      const found = yield* registry.getById(environmentId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(new RemoteEnvironmentNotFoundError({ environmentId }));
      }
      const descriptor = found.value;

      if (!descriptor.capabilities.providerKinds.includes(providerKind)) {
        return yield* Effect.fail(
          new RemoteEnvironmentProviderKindError({ environmentId, providerKind }),
        );
      }

      const runtime = descriptor.runtime;
      const runtimeType = runtime?.runtimeType ?? "local";
      if (runtimeType === "local") {
        return { kind: "local" } satisfies SpawnPlan;
      }
      if (runtimeType !== "ssh-process" || runtime === undefined) {
        return yield* Effect.fail(
          new RemoteEnvironmentUnsupportedRuntimeError({ environmentId, runtimeType }),
        );
      }

      const transport = descriptor.transport;
      if (transport === undefined) {
        return yield* Effect.fail(
          new SshCommandError({
            reason: `environment "${environmentId}" has an ssh-process runtime but no ssh transport`,
          }),
        );
      }

      // OpenSSH owns aliases, hashed host entries and configured trust sources in
      // known-hosts mode. A pin instead uses an isolated file containing ONLY
      // that public key so a different trusted key cannot satisfy the connection.
      let sshTrustArgs: readonly string[] = [];
      if (transport.hostKeyVerification === "pinned-fingerprint") {
        sshTrustArgs = yield* Effect.tryPromise({
          try: async () => {
            const contents = await readFile(knownHostsPath, "utf8");
            const pinned = pinnedKnownHostEntryFromContents(contents, transport);
            if (!pinned) throw new Error("The pinned key is missing or revoked in known_hosts");
            const alias = `synara-pinned-${createHash("sha256").update(pinned.publicKey).digest("hex")}`;
            const trustFile = path.join(trustDir, alias);
            await writeFile(trustFile, `${alias} ${pinned.keyType} ${pinned.publicKey}\n`, {
              mode: 0o600,
            });
            return [
              "-o",
              `UserKnownHostsFile="${trustFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
              "-o",
              "GlobalKnownHostsFile=none",
              "-o",
              "KnownHostsCommand=none",
              "-o",
              "VerifyHostKeyDNS=no",
              "-o",
              "UpdateHostKeys=no",
              "-o",
              `HostKeyAlias=${alias}`,
              "-o",
              `HostKeyAlgorithms=${pinned.keyType}`,
            ];
          },
          catch: (cause) =>
            new RemoteEnvironmentHostKeyError({ environmentId, reason: String(cause) }),
        });
      }

      // reconnect: "remote-agent" selects the persistent agent transport
      // (Architecture B); everything else keeps the direct ssh exec path.
      if (descriptor.capabilities.reconnect === "remote-agent") {
        if (!originId)
          return yield* Effect.fail(
            new SshCommandError({
              reason: "Remote agent requires an isolated server origin identity",
            }),
          );
        const endpointId = createHash("sha256")
          .update(JSON.stringify([originId, environmentId, providerSessionStartInput.threadId]))
          .digest("hex");
        const sshArgs = yield* Effect.try({
          try: () => buildAgentSshArgv(transport, runtime, sshTrustArgs, endpointId),
          catch: (cause) =>
            cause instanceof SshCommandError
              ? cause
              : new SshCommandError({ reason: String(cause) }),
        });
        return {
          kind: "remote-agent",
          sshArgs,
          remoteCommand: sshArgs[sshArgs.length - 1] ?? "",
          threadId: providerSessionStartInput.threadId,
          executionProfile,
          providerArgv: [
            runtime.remoteBinaryPath?.trim() || DEFAULT_REMOTE_BINARY,
            REMOTE_APP_SERVER_ARG,
          ],
          transport,
          runtime,
          sshTrustArgs,
        } satisfies SpawnPlan;
      }

      const sshArgs = yield* Effect.try({
        try: () => buildSshArgv(transport, runtime, executionProfile, sshTrustArgs),
        catch: (cause) =>
          cause instanceof SshCommandError ? cause : new SshCommandError({ reason: String(cause) }),
      });
      const remoteCommand = buildRemoteCommand(runtime, executionProfile);
      return { kind: "ssh", sshArgs, remoteCommand } satisfies SpawnPlan;
    });

  return { resolve } satisfies RemoteEnvironmentResolverShape;
});

export const RemoteEnvironmentResolverLive = Layer.effect(
  RemoteEnvironmentResolver,
  makeRemoteEnvironmentResolver(),
);
