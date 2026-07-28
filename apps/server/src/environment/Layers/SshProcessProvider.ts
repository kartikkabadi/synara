// FILE: SshProcessProvider.ts
// Purpose: Layer implementing SshProcessProvider. Spawns the system ssh client
//          with the argv from an SshSpawnPlan, strips the sentinel remote PID
//          line from stdout before consumers see it, captures stderr
//          separately, and classifies exit codes (255 = ssh transport,
//          non-zero = provider) plus local spawn failures (ssh transport).

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
import { REMOTE_PID_SENTINEL_PREFIX } from "../sshCommand";

const SSH_TRANSPORT_EXIT_CODE = 255;
const STDERR_TAIL_MAX_CHARS = 8_192;
const NEWLINE_BYTE = 0x0a;
const PID_LINE_MAX_BYTES = 256;
const PID_LINE_PATTERN = new RegExp(`^${REMOTE_PID_SENTINEL_PREFIX}(\\d+)$`);

/**
 * Consumes the sentinel remote PID line (`__SYNARA_REMOTE_PID__=<digits>`,
 * printed by the remote command before it execs the provider) and forwards
 * everything after it, byte-for-byte, into a fresh stream. Any other output
 * before the sentinel (login banners, wrapper warnings) is a protocol
 * violation: the filtered stream is destroyed with an error instead of
 * silently discarding or forwarding lines that would corrupt the JSON-RPC
 * stream.
 */
function stripRemotePidLine(stdout: Readable): {
  readonly filtered: PassThrough;
  readonly remotePid: Promise<number | null>;
} {
  const filtered = new PassThrough();
  let pending: Buffer = Buffer.alloc(0);
  let pidConsumed = false;
  let failed = false;
  let resolvePid: (pid: number | null) => void = () => {};
  const remotePid = new Promise<number | null>((resolve) => {
    resolvePid = resolve;
  });

  const fail = (reason: string) => {
    failed = true;
    pending = Buffer.alloc(0);
    resolvePid(null);
    filtered.destroy(
      new Error(`Remote PID sentinel violation: ${reason}. Refusing to stream stdout.`),
    );
  };

  stdout.on("data", (chunk: Buffer) => {
    if (failed) return;
    if (pidConsumed) {
      filtered.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const newlineIndex = pending.indexOf(NEWLINE_BYTE);
    if (newlineIndex === -1) {
      if (pending.length > PID_LINE_MAX_BYTES) {
        fail(`no newline within the first ${PID_LINE_MAX_BYTES} bytes of stdout`);
      }
      return;
    }
    const firstLine = pending.subarray(0, newlineIndex).toString("utf8").trimEnd();
    const match = PID_LINE_PATTERN.exec(firstLine);
    if (match === null) {
      fail(
        `first stdout line is not "${REMOTE_PID_SENTINEL_PREFIX}<pid>" (got ${JSON.stringify(firstLine.slice(0, 128))})`,
      );
      return;
    }
    const rest = pending.subarray(newlineIndex + 1);
    pidConsumed = true;
    pending = Buffer.alloc(0);
    const pid = Number.parseInt(match[1] ?? "", 10);
    resolvePid(Number.isInteger(pid) && pid > 0 ? pid : null);
    if (rest.length > 0) {
      filtered.write(rest);
    }
  });
  stdout.on("end", () => {
    if (failed) return;
    if (!pidConsumed) resolvePid(null);
    filtered.end();
  });
  stdout.on("error", (error) => {
    if (failed) return;
    if (!pidConsumed) resolvePid(null);
    filtered.destroy(error);
  });
  // A failed spawn closes the pipe without an "end" event.
  stdout.on("close", () => {
    if (!pidConsumed) resolvePid(null);
  });

  return { filtered, remotePid };
}

export const makeSshProcessProvider = (sshBinaryPath: string): SshProcessProviderShape => ({
  spawnSsh: (plan: SshSpawnPlan, options: ProviderProcessSpawnOptions) =>
    Effect.try({
      try: () => {
        // The local ssh client must not run from the session's cwd: that is
        // the *remote* workspace root, which usually does not exist on this
        // machine. `remoteWorkspaceRoot` only appears inside the remote
        // command; ssh itself inherits the server process's cwd.
        const child = spawn(sshBinaryPath, [...plan.sshArgs], {
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
          // Asynchronous spawn failures (ENOENT, EACCES) arrive here, not as
          // a synchronous throw from spawn(). The channel never opened, so
          // this is a local ssh transport failure.
          child.once("error", (error) => {
            resolve({
              kind: "ssh-transport-error",
              error: new SshTransportError({
                reason: `failed to spawn ssh: ${error.message}`,
                stderrTail,
              }),
            });
          });
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
