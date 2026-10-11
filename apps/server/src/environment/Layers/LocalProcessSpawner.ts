// FILE: LocalProcessSpawner.ts
// Purpose: Local implementation of ProviderProcessSpawner. Spawns the process
//          on this machine via the shared platform/process boundary with piped stdio.

import { spawnProcess } from "@synara/shared/processRuntime";

import { Effect, Layer } from "effect";

import {
  ProviderProcessSpawner,
  type ProviderProcessSpawnerShape,
  ProviderSpawnError,
} from "../Services/ProviderProcessSpawner";

export const makeLocalProcessSpawner = (): ProviderProcessSpawnerShape => ({
  spawn: (command, args, options) =>
    Effect.try({
      try: () =>
        spawnProcess(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          lowerPriority: options.lowerPriority,
          requireExecutable: options.requireExecutable,
        }),
      catch: (cause) =>
        new ProviderSpawnError({
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
});

export const LocalProcessSpawnerLive = Layer.succeed(
  ProviderProcessSpawner,
  makeLocalProcessSpawner(),
);
