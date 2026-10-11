// FILE: sshCommand.ts
// Purpose: Pure helpers that build the `ssh` argument vector used to launch a
//          provider app-server on a remote host (runtimeType "ssh-process").
//          No I/O and no process spawning here; the spawner consumes the argv.
// Layer: Server utility (no IO; safe to import from anywhere)

import type {
  ExecutionEnvironmentRuntime,
  ExecutionEnvironmentSshTransport,
  ExecutionProfile,
} from "@synara/contracts";
import { Schema } from "effect";

export const DEFAULT_REMOTE_BINARY = "codex";
/**
 * Sentinel prefixing the remote PID line so the spawner can distinguish it
 * from banners or other unexpected stdout. The full line is
 * `__SYNARA_REMOTE_PID__=<digits>`.
 */
export const REMOTE_PID_SENTINEL_PREFIX = "__SYNARA_REMOTE_PID__=";
export const REMOTE_APP_SERVER_ARG = "app-server";

/**
 * SshCommandError - Transport/runtime/profile input is invalid for building an
 * ssh command.
 */
export class SshCommandError extends Schema.TaggedErrorClass<SshCommandError>()("SshCommandError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Invalid ssh command input: ${this.reason}`;
  }
}

/**
 * Quotes a value for a POSIX shell using single quotes, escaping embedded
 * single quotes via the `'\''` idiom. Single audited quoting entry point.
 */
export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new SshCommandError({ reason: `${label} must be a non-empty string` });
  }
  return trimmed;
}

function requireSafeCliValue(value: string, label: string): string {
  if (value.startsWith("-")) {
    throw new SshCommandError({ reason: `${label} must not start with "-"` });
  }
  return value;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SshCommandError({ reason: `port must be an integer in [1, 65535], got ${port}` });
  }
  return port;
}

/**
 * Builds the remote shell command. Prints a sentinel PID line
 * (`__SYNARA_REMOTE_PID__=$$`) as the first line of stdout so the spawner can
 * scope later teardown and reject unexpected preamble output, then execs the
 * provider binary from the workspace root.
 */
export function buildRemoteCommand(
  runtime: ExecutionEnvironmentRuntime,
  executionProfile: ExecutionProfile,
): string {
  const workspaceRoot = requireNonEmpty(
    executionProfile.remoteWorkspaceRoot,
    "remoteWorkspaceRoot",
  );
  const binary = runtime.remoteBinaryPath?.trim() || DEFAULT_REMOTE_BINARY;
  return `echo "${REMOTE_PID_SENTINEL_PREFIX}$$" && cd ${posixQuote(workspaceRoot)} && exec ${posixQuote(binary)} ${REMOTE_APP_SERVER_ARG}`;
}

/**
 * Builds the shared `ssh` option/destination argument prefix (everything up to
 * and including `user@host`). Callers append `--` and their remote command.
 */
function buildSshBaseArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  sshTrustArgs: readonly string[] = [],
): string[] {
  if (runtime.runtimeType !== "ssh-process") {
    throw new SshCommandError({
      reason: `runtimeType must be "ssh-process", got "${runtime.runtimeType}"`,
    });
  }

  const host = requireSafeCliValue(requireNonEmpty(transport.host, "host"), "host");
  const port = validatePort(transport.port);
  const argv: string[] = ["-o", "BatchMode=yes"];

  if (port !== 22) {
    argv.push("-p", String(port));
  }
  if (transport.identityFile !== undefined) {
    argv.push("-i", requireNonEmpty(transport.identityFile, "identityFile"));
  }
  if (transport.sshConfigPath !== undefined) {
    argv.push("-F", requireNonEmpty(transport.sshConfigPath, "sshConfigPath"));
  }
  if (transport.jumpHost !== undefined) {
    argv.push("-J", requireNonEmpty(transport.jumpHost, "jumpHost"));
  }

  // Never inherit port forwardings from the user's SSH config, and turn a
  // half-open channel into a deterministic failure via protocol keepalives.
  argv.push(
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  );

  // Host-key verification is always strict; the policy only selects the trust
  // source. "pinned-fingerprint" additionally requires a fingerprint check
  // before spawn (see sshHostKey.ts).
  argv.push("-o", "StrictHostKeyChecking=yes");
  if (transport.hostKeyVerification === "pinned-fingerprint") {
    const fingerprint = transport.hostKeyFingerprint?.trim() ?? "";
    if (fingerprint.length === 0) {
      throw new SshCommandError({
        reason: 'hostKeyFingerprint is required when hostKeyVerification is "pinned-fingerprint"',
      });
    }
    if (sshTrustArgs.length === 0)
      throw new SshCommandError({
        reason: "Pinned host verification requires a resolved trust source",
      });
  }

  argv.push(
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    ...sshTrustArgs,
  );
  const user =
    transport.user !== undefined
      ? requireSafeCliValue(requireNonEmpty(transport.user, "user"), "user")
      : undefined;
  argv.push("--", user !== undefined ? `${user}@${host}` : host);
  return argv;
}

/**
 * Builds the full `ssh` argument array (without the leading `ssh`), terminating
 * options before the destination and remote command string. Never embeds or forwards secret material.
 */
export function buildSshArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  executionProfile: ExecutionProfile,
  sshTrustArgs: readonly string[] = [],
): string[] {
  const argv = buildSshBaseArgv(transport, runtime, sshTrustArgs);
  argv.push(buildRemoteCommand(runtime, executionProfile));
  return argv;
}

export const DEFAULT_REMOTE_AGENT_INSTALL_PATH = "~/.synara/bin/remote-agent.cjs";

/**
 * Resolves the remote agent install path from the runtime descriptor,
 * defaulting to the well-known per-user location.
 */
export function resolveRemoteAgentInstallPath(runtime: ExecutionEnvironmentRuntime): string {
  return runtime.installPath?.trim() || DEFAULT_REMOTE_AGENT_INSTALL_PATH;
}

/**
 * Quotes a remote path while preserving `~/` home expansion by rewriting the
 * tilde prefix to a double-quoted `$HOME` reference.
 */
export function quoteRemotePath(remotePath: string): string {
  return remotePath.startsWith("~/")
    ? `"$HOME"${posixQuote(remotePath.slice(1))}`
    : posixQuote(remotePath);
}

/**
 * Builds the remote command that starts the persistent remote agent
 * (reconnect: "remote-agent"). Runs the bundled cjs through `node` so the
 * install does not depend on the file's executable bit.
 */
export function buildRemoteAgentCommand(
  runtime: ExecutionEnvironmentRuntime,
  endpointId?: string,
): string {
  return `exec node ${quoteRemotePath(resolveRemoteAgentInstallPath(runtime))}${endpointId ? ` --connect ${posixQuote(endpointId)}` : ""}`;
}

/**
 * Builds the full `ssh` argument array for running an arbitrary remote
 * command over the same transport as the agent connection. Used by the
 * installer for probe/mkdir/copy steps; the caller quotes the command.
 */
export function buildSshExecArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  remoteCommand: string,
  sshTrustArgs: readonly string[] = [],
): string[] {
  const argv = buildSshBaseArgv(transport, runtime, sshTrustArgs);
  argv.push(remoteCommand);
  return argv;
}

/**
 * Builds the `scp` argument array (without the leading `scp`) copying a local
 * file to a remote path over the same transport. `~/`-prefixed remote paths
 * become home-relative, matching scp's default working directory.
 */
export function buildScpArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  localPath: string,
  remotePath: string,
  sshTrustArgs: readonly string[] = [],
): string[] {
  if (runtime.runtimeType !== "ssh-process") {
    throw new SshCommandError({
      reason: `runtimeType must be "ssh-process", got "${runtime.runtimeType}"`,
    });
  }
  const host = requireSafeCliValue(requireNonEmpty(transport.host, "host"), "host");
  const port = validatePort(transport.port);
  const argv: string[] = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
  if (port !== 22) {
    argv.push("-P", String(port));
  }
  if (transport.identityFile !== undefined) {
    argv.push("-i", requireNonEmpty(transport.identityFile, "identityFile"));
  }
  if (transport.sshConfigPath !== undefined) {
    argv.push("-F", requireNonEmpty(transport.sshConfigPath, "sshConfigPath"));
  }
  if (transport.jumpHost !== undefined) {
    argv.push("-J", requireNonEmpty(transport.jumpHost, "jumpHost"));
  }
  argv.push(
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    ...sshTrustArgs,
  );
  const user =
    transport.user !== undefined
      ? requireSafeCliValue(requireNonEmpty(transport.user, "user"), "user")
      : undefined;
  const destination = user !== undefined ? `${user}@${host}` : host;
  if (transport.hostKeyVerification === "pinned-fingerprint" && sshTrustArgs.length === 0)
    throw new SshCommandError({
      reason: "Pinned host verification requires a resolved trust source",
    });
  const homeRelative = remotePath.startsWith("~/") ? remotePath.slice(2) : remotePath;
  argv.push("--", localPath, `${destination}:${homeRelative}`);
  return argv;
}

/**
 * Builds the full `ssh` argument array for connecting to the remote agent
 * binary instead of execing the provider directly (Architecture B).
 */
export function buildAgentSshArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  sshTrustArgs: readonly string[] = [],
  endpointId?: string,
): string[] {
  const argv = buildSshBaseArgv(transport, runtime, sshTrustArgs);
  argv.push(buildRemoteAgentCommand(runtime, endpointId));
  return argv;
}

/**
 * Convenience formatter for logging/auditing: `ssh <options> -- <destination> <remoteCommand>`.
 * Contains no secret material (paths and env-var names only).
 */
export function buildSshCommandString(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  executionProfile: ExecutionProfile,
): string {
  return ["ssh", ...buildSshArgv(transport, runtime, executionProfile)].join(" ");
}
