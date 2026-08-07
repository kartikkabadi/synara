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

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * Builds the remote shell command. Prints the remote shell PID (`$$`) as the
 * first line of stdout so the spawner can scope later teardown, then execs the
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
  return `echo $$ && cd ${posixQuote(workspaceRoot)} && exec ${posixQuote(binary)} ${REMOTE_APP_SERVER_ARG}`;
}

/**
 * Builds the shared `ssh` option/destination argument prefix (everything up to
 * and including `user@host`). Callers append `--` and their remote command.
 */
function buildSshBaseArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
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
    argv.push("-o", `HostKeyAlias=${host}`);
  }

  for (const name of runtime.forwardedEnvNames) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new SshCommandError({
        reason: `forwarded environment variable name is invalid: "${name}"`,
      });
    }
    argv.push("-o", `SendEnv=${name}`);
  }

  const user = transport.user !== undefined ? requireNonEmpty(transport.user, "user") : undefined;
  argv.push(user !== undefined ? `${user}@${host}` : host);
  return argv;
}

/**
 * Builds the full `ssh` argument array (without the leading `ssh`), ending
 * with `--` and the remote command string. Never embeds secret material; env
 * forwarding uses `SendEnv` with names only.
 */
export function buildSshArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  executionProfile: ExecutionProfile,
): string[] {
  const argv = buildSshBaseArgv(transport, runtime);
  argv.push("--", buildRemoteCommand(runtime, executionProfile));
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
export function buildRemoteAgentCommand(runtime: ExecutionEnvironmentRuntime): string {
  return `exec node ${quoteRemotePath(resolveRemoteAgentInstallPath(runtime))}`;
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
): string[] {
  const argv = buildSshBaseArgv(transport, runtime);
  argv.push("--", remoteCommand);
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
  const user = transport.user !== undefined ? requireNonEmpty(transport.user, "user") : undefined;
  const destination = user !== undefined ? `${user}@${host}` : host;
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
): string[] {
  const argv = buildSshBaseArgv(transport, runtime);
  argv.push("--", buildRemoteAgentCommand(runtime));
  return argv;
}

/**
 * Convenience formatter for logging/auditing: `ssh <args> -- <remoteCommand>`.
 * Contains no secret material (paths and env-var names only).
 */
export function buildSshCommandString(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  executionProfile: ExecutionProfile,
): string {
  return ["ssh", ...buildSshArgv(transport, runtime, executionProfile)].join(" ");
}
