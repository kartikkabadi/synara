// FILE: ProviderProcessSpawner.ts
// Purpose: Service contract for spawning provider app-server processes. The
//          manager builds the command/argv; the spawner owns process creation
//          so a remote (ssh) spawner can be swapped in behind the same seam.

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { type Effect, Schema, ServiceMap } from "effect";

/**
 * ProviderSpawnError - Spawning the provider process failed synchronously
 * (invalid arguments, resource exhaustion). Async failures still surface via
 * the child process "error" event, exactly as with a direct `spawn` call.
 */
export class ProviderSpawnError extends Schema.TaggedErrorClass<ProviderSpawnError>()(
  "ProviderSpawnError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to spawn provider process: ${this.reason}`;
  }
}

/**
 * Spawn options mirroring exactly what the Codex app-server launch uses today.
 * stdio is always ["pipe", "pipe", "pipe"], which is what guarantees the
 * ChildProcessWithoutNullStreams return type.
 */
export interface ProviderProcessSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell?: boolean | string | undefined;
  readonly windowsHide?: boolean | undefined;
  readonly windowsVerbatimArguments?: boolean | undefined;
}

export interface ProviderProcessSpawnerShape {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: ProviderProcessSpawnOptions,
  ) => Effect.Effect<ChildProcessWithoutNullStreams, ProviderSpawnError>;
}

export class ProviderProcessSpawner extends ServiceMap.Service<
  ProviderProcessSpawner,
  ProviderProcessSpawnerShape
>()("synara/environment/Services/ProviderProcessSpawner") {}
