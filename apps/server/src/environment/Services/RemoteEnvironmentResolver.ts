// FILE: RemoteEnvironmentResolver.ts
// Purpose: Service contract for resolving a per-thread ExecutionProfile into a
//          SpawnPlan. The resolver only decides *how* the provider process
//          should be launched (locally or over ssh); it never spawns anything.

import { homedir } from "node:os";
import path from "node:path";

import type { ExecutionProfile, ProviderSessionStartInput } from "@synara/contracts";
import { type Effect, Schema, ServiceMap } from "effect";

import type { SshCommandError } from "../sshCommand";
import type { RemoteEnvironmentError } from "./RemoteEnvironmentRegistry";

/** The provider process runs on this machine with today's command/args. */
export interface LocalSpawnPlan {
  readonly kind: "local";
}

/** The provider process runs on a remote host through the system ssh client. */
export interface SshSpawnPlan {
  readonly kind: "ssh";
  /** Full ssh argument vector (without the leading ssh binary). */
  readonly sshArgs: readonly string[];
  /** The remote command string, last element of `sshArgs` (for logging/tests). */
  readonly remoteCommand: string;
}

/**
 * The provider process runs on a remote host behind the persistent
 * synara-remote-agent (Architecture B; capabilities.reconnect "remote-agent").
 */
export interface RemoteAgentSpawnPlan {
  readonly kind: "remote-agent";
  /** Full ssh argument vector connecting to the agent (without leading ssh). */
  readonly sshArgs: readonly string[];
  /** The remote command string, last element of `sshArgs` (for logging/tests). */
  readonly remoteCommand: string;
  /** Stable per-session thread id passed to agent/spawn and agent/attach. */
  readonly threadId: string;
  readonly executionProfile: ExecutionProfile;
  /** The provider argv the agent spawns on the remote host. */
  readonly providerArgv: readonly string[];
}

export type SpawnPlan = LocalSpawnPlan | SshSpawnPlan | RemoteAgentSpawnPlan;

/**
 * RemoteEnvironmentNotFoundError - No environment descriptor exists for the
 * profile's environmentId.
 */
export class RemoteEnvironmentNotFoundError extends Schema.TaggedErrorClass<RemoteEnvironmentNotFoundError>()(
  "RemoteEnvironmentNotFoundError",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `No execution environment registered with id "${this.environmentId}"`;
  }
}

/**
 * RemoteEnvironmentProviderKindError - The environment does not advertise the
 * requested provider kind in its capabilities.
 */
export class RemoteEnvironmentProviderKindError extends Schema.TaggedErrorClass<RemoteEnvironmentProviderKindError>()(
  "RemoteEnvironmentProviderKindError",
  {
    environmentId: Schema.String,
    providerKind: Schema.String,
  },
) {
  override get message(): string {
    return `Environment "${this.environmentId}" does not support provider "${this.providerKind}"`;
  }
}

/**
 * RemoteEnvironmentUnsupportedRuntimeError - The environment's runtime type is
 * not spawnable in this slice (Architecture B: "remote-synara-server").
 */
export class RemoteEnvironmentUnsupportedRuntimeError extends Schema.TaggedErrorClass<RemoteEnvironmentUnsupportedRuntimeError>()(
  "RemoteEnvironmentUnsupportedRuntimeError",
  {
    environmentId: Schema.String,
    runtimeType: Schema.String,
  },
) {
  override get message(): string {
    return `Environment "${this.environmentId}" runtime "${this.runtimeType}" is not supported for spawning`;
  }
}

/**
 * RemoteEnvironmentHostKeyError - Host-key verification failed for the
 * environment's ssh transport (missing known_hosts entry or pinned-fingerprint
 * mismatch). Always fails closed.
 */
export class RemoteEnvironmentHostKeyError extends Schema.TaggedErrorClass<RemoteEnvironmentHostKeyError>()(
  "RemoteEnvironmentHostKeyError",
  {
    environmentId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Host-key verification failed for environment "${this.environmentId}": ${this.reason}`;
  }
}

export type RemoteEnvironmentResolveError =
  | RemoteEnvironmentNotFoundError
  | RemoteEnvironmentProviderKindError
  | RemoteEnvironmentUnsupportedRuntimeError
  | RemoteEnvironmentHostKeyError
  | RemoteEnvironmentError
  | SshCommandError;

export interface RemoteEnvironmentResolverShape {
  readonly resolve: (
    executionProfile: ExecutionProfile,
    providerSessionStartInput: ProviderSessionStartInput,
  ) => Effect.Effect<SpawnPlan, RemoteEnvironmentResolveError>;
}

export class RemoteEnvironmentResolver extends ServiceMap.Service<
  RemoteEnvironmentResolver,
  RemoteEnvironmentResolverShape
>()("synara/environment/Services/RemoteEnvironmentResolver") {}

/**
 * Path of the known_hosts file consulted for host-key verification. A
 * Reference so tests can point it at a fixture file.
 */
export const KnownHostsPath = ServiceMap.Reference<string>(
  "synara/environment/Services/RemoteEnvironmentResolver/KnownHostsPath",
  { defaultValue: () => path.join(homedir(), ".ssh", "known_hosts") },
);
