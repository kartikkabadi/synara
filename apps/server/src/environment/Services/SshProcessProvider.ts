// FILE: SshProcessProvider.ts
// Purpose: Service contract for spawning provider app-server processes on a
//          remote host through the system ssh client. The returned child looks
//          exactly like a local provider child: its stdout starts *after* the
//          remote PID line printed by the remote command (`echo $$ && ...`).

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { type Effect, Schema, ServiceMap } from "effect";

import type { ProviderProcessSpawnOptions, ProviderSpawnError } from "./ProviderProcessSpawner";
import type { SshSpawnPlan } from "./RemoteEnvironmentResolver";

/**
 * SshTransportError - The ssh client itself failed (exit code 255): network,
 * auth, or host-key problems. Distinct from the remote provider failing.
 */
export class SshTransportError extends Schema.TaggedErrorClass<SshTransportError>()(
  "SshTransportError",
  {
    reason: Schema.String,
    stderrTail: Schema.String,
  },
) {
  override get message(): string {
    return `SSH transport failure: ${this.reason}`;
  }
}

/**
 * ProviderProcessError - The remote provider process exited with a non-zero
 * code (anything other than 0 or the ssh-reserved 255).
 */
export class ProviderProcessError extends Schema.TaggedErrorClass<ProviderProcessError>()(
  "ProviderProcessError",
  {
    reason: Schema.String,
    exitCode: Schema.Number,
    stderrTail: Schema.String,
  },
) {
  override get message(): string {
    return `Remote provider process failed: ${this.reason}`;
  }
}

export type SshProcessExit =
  | { readonly kind: "clean"; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "ssh-transport-error"; readonly error: SshTransportError }
  | { readonly kind: "provider-process-error"; readonly error: ProviderProcessError };

export interface SshSpawnedProcess {
  /** The ssh child; `stdout` begins after the remote PID line is consumed. */
  readonly child: ChildProcessWithoutNullStreams;
  /** Remote shell PID from the first stdout line; null when unparseable. */
  readonly remotePid: Promise<number | null>;
  /** Resolves once the ssh child exits, with the exit classified. */
  readonly exit: Promise<SshProcessExit>;
  /** Subscribes to raw ssh/remote stderr output (never parsed as events). */
  readonly onStderr: (callback: (chunk: string) => void) => void;
  /**
   * Sends the signal down the ssh channel; sshd HUPs the remote child when
   * the channel closes (the remote command is `exec`'d, so it owns the PID).
   */
  readonly kill: (signal?: NodeJS.Signals) => void;
}

export interface SshProcessProviderShape {
  readonly spawnSsh: (
    plan: SshSpawnPlan,
    options: ProviderProcessSpawnOptions,
  ) => Effect.Effect<SshSpawnedProcess, ProviderSpawnError>;
}

export class SshProcessProvider extends ServiceMap.Service<
  SshProcessProvider,
  SshProcessProviderShape
>()("synara/environment/Services/SshProcessProvider") {}

/** Path of the ssh client binary. A Reference so tests can inject a mock. */
export const SshBinaryPath = ServiceMap.Reference<string>(
  "synara/environment/Services/SshProcessProvider/SshBinaryPath",
  { defaultValue: () => "ssh" },
);
