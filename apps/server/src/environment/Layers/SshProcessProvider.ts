// FILE: SshProcessProvider.ts
// Purpose: Layer implementing SshProcessProvider. Spawns the system ssh client
//          with the argv from an SshSpawnPlan, strips the remote PID line from
//          stdout before consumers see it, captures stderr separately, and
//          classifies exit codes (255 = ssh transport, non-zero = provider).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";

import { Effect, Layer } from "effect";

import { ProviderSpawnError } from "../Services/ProviderProcessSpawner";
import type { ProviderProcessSpawnOptions } from "../Services/ProviderProcessSpawner";
import type { SshSpawnPlan } from "../Services/RemoteEnvironmentResolver";
import {
  ProviderProcessError,
  SshBinaryPath,
  SshProcessProvider,
  type SshProcessExit,
  type SshProcessProviderShape,
  SshTransportError,
} from "../Services/SshProcessProvider";

const SSH_TRANSPORT_EXIT_CODE = 255;
const STDERR_TAIL_MAX_CHARS = 8_192;
const NEWLINE_BYTE = 0x0a;

/**
 * Consumes the first stdout line (the remote PID printed by `echo $$`) and
 * forwards everything after it, byte-for-byte, into a fresh stream.
 */
function stripRemotePidLine(stdout: Readable): {
  readonly filtered: PassThrough;
  readonly remotePid: Promise<number | null>;
} {
  const filtered = new PassThrough();
  let pending: Buffer = Buffer.alloc(0);
  let pidConsumed = false;
  let resolvePid: (pid: number | null) => void = () => {};
  const remotePid = new Promise<number | null>((resolve) => {
    resolvePid = resolve;
  });

  stdout.on("data", (chunk: Buffer) => {
    if (pidConsumed) {
      filtered.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const newlineIndex = pending.indexOf(NEWLINE_BYTE);
    if (newlineIndex === -1) return;
    const pidLine = pending.subarray(0, newlineIndex).toString("utf8").trim();
    const rest = pending.subarray(newlineIndex + 1);
    pidConsumed = true;
    pending = Buffer.alloc(0);
    const pid = Number.parseInt(pidLine, 10);
    resolvePid(Number.isInteger(pid) && pid > 0 ? pid : null);
    if (rest.length > 0) {
      filtered.write(rest);
    }
  });
  stdout.on("end", () => {
    if (!pidConsumed) resolvePid(null);
    filtered.end();
  });
  stdout.on("error", (error) => {
    if (!pidConsumed) resolvePid(null);
    filtered.destroy(error);
  });

  return { filtered, remotePid };
}

export const makeSshProcessProvider = (sshBinaryPath: string): SshProcessProviderShape => ({
  spawnSsh: (plan: SshSpawnPlan, options: ProviderProcessSpawnOptions) =>
    Effect.try({
      try: () => {
        const child = spawn(sshBinaryPath, [...plan.sshArgs], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;

        const { filtered, remotePid } = stripRemotePidLine(child.stdout);
        // Consumers read the PID-stripped stream through the usual property.
        Object.defineProperty(child, "stdout", { value: filtered });

        let stderrTail = "";
        const stderrCallbacks: Array<(chunk: string) => void> = [];
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
          for (const callback of stderrCallbacks) callback(chunk);
        });

        const exit = new Promise<SshProcessExit>((resolve) => {
          child.once("close", (code, signal) => {
            if (code === SSH_TRANSPORT_EXIT_CODE) {
              resolve({
                kind: "ssh-transport-error",
                error: new SshTransportError({
                  reason: `ssh exited with code ${SSH_TRANSPORT_EXIT_CODE}`,
                  stderrTail,
                }),
              });
            } else if (code !== null && code !== 0) {
              resolve({
                kind: "provider-process-error",
                error: new ProviderProcessError({
                  reason: `remote provider exited with code ${code}`,
                  exitCode: code,
                  stderrTail,
                }),
              });
            } else {
              resolve({ kind: "clean", signal });
            }
          });
        });

        return {
          child,
          remotePid,
          exit,
          onStderr: (callback: (chunk: string) => void) => {
            stderrCallbacks.push(callback);
          },
          // Signalling the local ssh child closes the channel; sshd then HUPs
          // the exec'd remote provider. TODO(PR F): remote PID-scoped
          // `ssh <host> kill <pid>` fallback for an already-closed channel.
          kill: (signal?: NodeJS.Signals) => {
            if (child.exitCode === null && !child.killed) {
              child.kill(signal);
            }
          },
        };
      },
      catch: (cause) =>
        new ProviderSpawnError({
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
});

export const SshProcessProviderLive = Layer.effect(
  SshProcessProvider,
  Effect.map(SshBinaryPath.asEffect(), makeSshProcessProvider),
);
