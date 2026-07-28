// FILE: RemoteAgentInstaller.ts
// Purpose: Layer implementing RemoteAgentInstaller. Probes the remote agent
//          with agent/hello over ssh; on miss/mismatch/timeout it copies the
//          local bundle (scp, or base64-over-ssh when scp is unavailable) to
//          the runtime's install path and verifies with a second hello. Every
//          step is idempotent: mkdir -p, write-to-temp + atomic mv, re-probe.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer } from "effect";

import { REMOTE_AGENT_PROTOCOL_VERSION } from "../RemoteAgentVersion";
import {
  CopyFailedError,
  InstallDirectoryCreationFailedError,
  ProtocolVersionMismatchError,
  RemoteAgentBundlePath,
  RemoteAgentInstaller,
  type RemoteAgentInstallDescriptor,
  type RemoteAgentInstallerError,
  type RemoteAgentInstallerShape,
  ScpBinaryPath,
  SshConnectionFailedError,
  VerificationFailedError,
} from "../Services/RemoteAgentInstaller";
import { SshBinaryPath } from "../Services/SshProcessProvider";
import {
  buildRemoteAgentCommand,
  buildScpArgv,
  buildSshExecArgv,
  quoteRemotePath,
  resolveRemoteAgentInstallPath,
} from "../sshCommand";

const HELLO_PROBE_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 60_000;
const SSH_TRANSPORT_EXIT_CODE = 255;
const STDERR_TAIL_MAX_CHARS = 2_048;

interface RunResult {
  readonly kind: "exited";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderrTail: string;
  readonly timedOut: boolean;
}

interface RunSpawnFailure {
  readonly kind: "spawn-failed";
  readonly code: string | undefined;
  readonly reason: string;
}

/**
 * Runs a child process to completion with optional stdin payload and a hard
 * timeout. Never throws; spawn failures (e.g. ENOENT) surface as a variant.
 */
function runChild(
  binary: string,
  args: readonly string[],
  options: { readonly stdin?: string; readonly timeoutMs: number },
): Promise<RunResult | RunSpawnFailure> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderrTail = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ kind: "spawn-failed", code: error.code, reason: error.message });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ kind: "exited", exitCode, stdout, stderrTail, timedOut });
    });
    // A child that exits before reading (e.g. a missing remote binary)
    // EPIPEs the write; that is already reflected in the exit code.
    child.stdin.on("error", () => {});
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

type ProbeOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "mismatch"; readonly actual: string }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "connection-failed"; readonly reason: string };

/**
 * Starts the agent at the install path over ssh and performs one agent/hello
 * round trip. A missing binary, malformed reply, or timeout all classify as
 * "absent" (installable); ssh exit 255 is a transport failure (not).
 */
async function probeHello(
  sshBinaryPath: string,
  descriptor: RemoteAgentInstallDescriptor,
): Promise<ProbeOutcome> {
  const argv = buildSshExecArgv(
    descriptor.transport,
    descriptor.runtime,
    buildRemoteAgentCommand(descriptor.runtime),
  );
  const hello = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "agent/hello",
    params: { agentVersion: "server", protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION },
  });
  const result = await runChild(sshBinaryPath, argv, {
    stdin: `${hello}\n`,
    timeoutMs: HELLO_PROBE_TIMEOUT_MS,
  });
  if (result.kind === "spawn-failed") {
    return { kind: "connection-failed", reason: `ssh spawn failed: ${result.reason}` };
  }
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message: { id?: unknown; result?: { protocolVersion?: unknown } };
    try {
      message = JSON.parse(trimmed) as typeof message;
    } catch {
      continue;
    }
    if (message.id !== 1) continue;
    const actual = message.result?.protocolVersion;
    if (typeof actual !== "string" || actual.length === 0) {
      return { kind: "absent", reason: "agent/hello returned no protocolVersion" };
    }
    return actual === REMOTE_AGENT_PROTOCOL_VERSION ? { kind: "ok" } : { kind: "mismatch", actual };
  }
  if (result.exitCode === SSH_TRANSPORT_EXIT_CODE) {
    return { kind: "connection-failed", reason: result.stderrTail || "ssh exited with code 255" };
  }
  if (result.timedOut) {
    return { kind: "absent", reason: `agent/hello timed out after ${HELLO_PROBE_TIMEOUT_MS}ms` };
  }
  return {
    kind: "absent",
    reason: `agent exited with code ${result.exitCode} before responding: ${result.stderrTail}`,
  };
}

export function makeRemoteAgentInstaller(config: {
  readonly sshBinaryPath: string;
  readonly scpBinaryPath: string;
  readonly bundlePath: string;
}): RemoteAgentInstallerShape {
  const runSsh = (
    descriptor: RemoteAgentInstallDescriptor,
    remoteCommand: string,
    stdin?: string,
  ) =>
    runChild(
      config.sshBinaryPath,
      buildSshExecArgv(descriptor.transport, descriptor.runtime, remoteCommand),
      { ...(stdin !== undefined ? { stdin } : {}), timeoutMs: COMMAND_TIMEOUT_MS },
    );

  const describeFailure = (result: RunResult | RunSpawnFailure): string =>
    result.kind === "spawn-failed"
      ? `ssh spawn failed: ${result.reason}`
      : result.timedOut
        ? `timed out after ${COMMAND_TIMEOUT_MS}ms`
        : `exit code ${result.exitCode}: ${result.stderrTail}`;

  const isConnectionFailure = (result: RunResult | RunSpawnFailure): boolean =>
    result.kind === "exited" && result.exitCode === SSH_TRANSPORT_EXIT_CODE;

  const copyBundle = async (
    descriptor: RemoteAgentInstallDescriptor,
    installPath: string,
    stagingPath: string,
  ): Promise<RemoteAgentInstallerError | undefined> => {
    // scp first; when the client is unavailable (ENOENT) fall back to
    // streaming the bundle as base64 through the ssh channel itself.
    const scp = await runChild(
      config.scpBinaryPath,
      buildScpArgv(descriptor.transport, descriptor.runtime, config.bundlePath, stagingPath),
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
    if (scp.kind === "exited") {
      if (isConnectionFailure(scp)) {
        return new SshConnectionFailedError({ reason: describeFailure(scp) });
      }
      if (scp.exitCode !== 0) {
        return new CopyFailedError({ reason: `scp failed: ${describeFailure(scp)}` });
      }
    } else {
      if (scp.code !== "ENOENT") {
        return new CopyFailedError({ reason: `scp failed: ${describeFailure(scp)}` });
      }
      let bundle: Buffer;
      try {
        bundle = await readFile(config.bundlePath);
      } catch (cause) {
        return new CopyFailedError({
          reason: `local bundle unreadable at ${config.bundlePath}: ${String(cause)}`,
        });
      }
      const write = await runSsh(
        descriptor,
        `base64 -d > ${quoteRemotePath(stagingPath)}`,
        `${bundle.toString("base64")}\n`,
      );
      if (isConnectionFailure(write)) {
        return new SshConnectionFailedError({ reason: describeFailure(write) });
      }
      if (write.kind === "spawn-failed" || write.exitCode !== 0 || write.timedOut) {
        return new CopyFailedError({ reason: `base64 upload failed: ${describeFailure(write)}` });
      }
    }
    // Atomic swap so a concurrent agent start never sees a partial file.
    const move = await runSsh(
      descriptor,
      `mv -f ${quoteRemotePath(stagingPath)} ${quoteRemotePath(installPath)}`,
    );
    if (isConnectionFailure(move)) {
      return new SshConnectionFailedError({ reason: describeFailure(move) });
    }
    if (move.kind === "spawn-failed" || move.exitCode !== 0 || move.timedOut) {
      return new CopyFailedError({ reason: `install move failed: ${describeFailure(move)}` });
    }
    return undefined;
  };

  const ensureAgentInstalled = (descriptor: RemoteAgentInstallDescriptor) =>
    Effect.gen(function* () {
      const probe = yield* Effect.promise(() => probeHello(config.sshBinaryPath, descriptor));
      if (probe.kind === "ok") return;
      if (probe.kind === "connection-failed") {
        return yield* Effect.fail(new SshConnectionFailedError({ reason: probe.reason }));
      }

      const installPath = resolveRemoteAgentInstallPath(descriptor.runtime);
      const installDir = path.posix.dirname(installPath);
      const stagingPath = `${installPath}.staged`;

      const mkdir = yield* Effect.promise(() =>
        runSsh(descriptor, `mkdir -p ${quoteRemotePath(installDir)}`),
      );
      if (isConnectionFailure(mkdir)) {
        return yield* Effect.fail(new SshConnectionFailedError({ reason: describeFailure(mkdir) }));
      }
      if (mkdir.kind === "spawn-failed" || mkdir.exitCode !== 0 || mkdir.timedOut) {
        return yield* Effect.fail(
          new InstallDirectoryCreationFailedError({ reason: describeFailure(mkdir) }),
        );
      }

      const copyError = yield* Effect.promise(() =>
        copyBundle(descriptor, installPath, stagingPath),
      );
      if (copyError !== undefined) {
        return yield* Effect.fail(copyError);
      }

      const verify = yield* Effect.promise(() => probeHello(config.sshBinaryPath, descriptor));
      switch (verify.kind) {
        case "ok":
          return;
        case "mismatch":
          return yield* Effect.fail(
            new ProtocolVersionMismatchError({
              expected: REMOTE_AGENT_PROTOCOL_VERSION,
              actual: verify.actual,
            }),
          );
        case "connection-failed":
          return yield* Effect.fail(new SshConnectionFailedError({ reason: verify.reason }));
        case "absent":
          return yield* Effect.fail(new VerificationFailedError({ reason: verify.reason }));
      }
    });

  return { ensureAgentInstalled };
}

export const RemoteAgentInstallerLive = Layer.effect(
  RemoteAgentInstaller,
  Effect.gen(function* () {
    const sshBinaryPath = yield* SshBinaryPath.asEffect();
    const scpBinaryPath = yield* ScpBinaryPath.asEffect();
    const bundlePath = yield* RemoteAgentBundlePath.asEffect();
    return makeRemoteAgentInstaller({ sshBinaryPath, scpBinaryPath, bundlePath });
  }),
);
