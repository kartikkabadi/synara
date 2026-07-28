// FILE: LocalProcessSpawner.ts
// Purpose: Local implementation of ProviderProcessSpawner. Spawns the process
//          on this machine via node:child_process with piped stdio, preserving
//          the exact behavior of the previous direct `spawn` call.

import { spawn } from "node:child_process";

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
        spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: options.shell,
          windowsHide: options.windowsHide,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
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
