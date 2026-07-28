// FILE: RemoteEnvironmentResolver.ts
// Purpose: Layer implementing RemoteEnvironmentResolver. Looks up the
//          environment descriptor, validates provider support, verifies the
//          ssh host key (fail-closed), and returns a SpawnPlan. No spawning.

import type { ExecutionProfile, ProviderSessionStartInput } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { buildRemoteCommand, buildSshArgv, SshCommandError } from "../sshCommand";
import { knownHostsFingerprint, verifyPinnedFingerprint } from "../sshHostKey";
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

export const makeRemoteEnvironmentResolver = Effect.fn(function* () {
  const registry = yield* RemoteEnvironmentRegistry;
  const knownHostsPath = yield* KnownHostsPath;

  const resolve = (
    executionProfile: ExecutionProfile,
    _providerSessionStartInput: ProviderSessionStartInput,
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

      // Host-key verification is always on and fails closed. "known-hosts"
      // requires an entry for the host; "pinned-fingerprint" additionally
      // requires the observed fingerprint to match the pinned one.
      const observedFingerprint = yield* knownHostsFingerprint(
        transport.host,
        transport.port,
        knownHostsPath,
      ).pipe(
        Effect.mapError(
          (error) => new RemoteEnvironmentHostKeyError({ environmentId, reason: error.reason }),
        ),
      );
      if (
        transport.hostKeyVerification === "pinned-fingerprint" &&
        !verifyPinnedFingerprint(transport, observedFingerprint)
      ) {
        return yield* Effect.fail(
          new RemoteEnvironmentHostKeyError({
            environmentId,
            reason: `observed host key ${observedFingerprint} does not match the pinned fingerprint`,
          }),
        );
      }

      const sshArgs = yield* Effect.try({
        try: () => buildSshArgv(transport, runtime, executionProfile),
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
