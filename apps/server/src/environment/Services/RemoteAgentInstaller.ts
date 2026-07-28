// FILE: RemoteAgentInstaller.ts
// Purpose: Service contract for bootstrapping the synara-remote-agent binary
//          onto a remote host before the RemoteAgentProvider transport opens
//          a session (#99 PR IV). Probes the installed agent's protocol
//          version over ssh and (re)installs the local bundle on miss.

import { fileURLToPath } from "node:url";

import type {
  ExecutionEnvironmentRuntime,
  ExecutionEnvironmentSshTransport,
} from "@synara/contracts";
import { type Effect, Schema, ServiceMap } from "effect";

/** The ssh client itself failed (exit code 255): network, auth, host key. */
export class SshConnectionFailedError extends Schema.TaggedErrorClass<SshConnectionFailedError>()(
  "SshConnectionFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent install: ssh connection failed: ${this.reason}`;
  }
}

/** Creating the remote install directory (`mkdir -p`) failed. */
export class InstallDirectoryCreationFailedError extends Schema.TaggedErrorClass<InstallDirectoryCreationFailedError>()(
  "InstallDirectoryCreationFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent install: directory creation failed: ${this.reason}`;
  }
}

/** Copying the agent bundle to the remote host failed (scp and fallback). */
export class CopyFailedError extends Schema.TaggedErrorClass<CopyFailedError>()("CopyFailedError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Remote agent install: copy failed: ${this.reason}`;
  }
}

/** The freshly installed agent did not answer agent/hello. */
export class VerificationFailedError extends Schema.TaggedErrorClass<VerificationFailedError>()(
  "VerificationFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent install: verification failed: ${this.reason}`;
  }
}

/** The freshly installed agent speaks a different protocol version (stale local bundle). */
export class ProtocolVersionMismatchError extends Schema.TaggedErrorClass<ProtocolVersionMismatchError>()(
  "ProtocolVersionMismatchError",
  {
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent install: protocol version mismatch after install: expected ${this.expected}, got ${this.actual}`;
  }
}

export type RemoteAgentInstallerError =
  | SshConnectionFailedError
  | InstallDirectoryCreationFailedError
  | CopyFailedError
  | VerificationFailedError
  | ProtocolVersionMismatchError;

/** The transport/runtime slice of the environment descriptor the installer needs. */
export interface RemoteAgentInstallDescriptor {
  readonly transport: ExecutionEnvironmentSshTransport;
  readonly runtime: ExecutionEnvironmentRuntime;
}

export interface RemoteAgentInstallerShape {
  /**
   * Idempotent: probes agent/hello at the runtime's install path; returns ok
   * when the protocol version matches, otherwise copies the local bundle to
   * the remote host and verifies. Safe to retry on any failure.
   */
  readonly ensureAgentInstalled: (
    descriptor: RemoteAgentInstallDescriptor,
  ) => Effect.Effect<void, RemoteAgentInstallerError>;
}

export class RemoteAgentInstaller extends ServiceMap.Service<
  RemoteAgentInstaller,
  RemoteAgentInstallerShape
>()("synara/environment/Services/RemoteAgentInstaller") {}

/** Local path of the built agent bundle. A Reference so tests can inject one. */
export const RemoteAgentBundlePath = ServiceMap.Reference<string>(
  "synara/environment/Services/RemoteAgentInstaller/RemoteAgentBundlePath",
  {
    defaultValue: () =>
      fileURLToPath(new URL("../../../../remote-agent/dist/remote-agent.cjs", import.meta.url)),
  },
);

/** Path of the scp binary. A Reference so tests can inject or disable it. */
export const ScpBinaryPath = ServiceMap.Reference<string>(
  "synara/environment/Services/RemoteAgentInstaller/ScpBinaryPath",
  { defaultValue: () => "scp" },
);
