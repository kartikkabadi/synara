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
 * Builds the full `ssh` argument array (without the leading `ssh`), ending
 * with `--` and the remote command string. Never embeds secret material; env
 * forwarding uses `SendEnv` with names only.
 */
export function buildSshArgv(
  transport: ExecutionEnvironmentSshTransport,
  runtime: ExecutionEnvironmentRuntime,
  executionProfile: ExecutionProfile,
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

  const user =
    transport.user !== undefined
      ? requireSafeCliValue(requireNonEmpty(transport.user, "user"), "user")
      : undefined;
  // The option terminator must precede the destination: OpenSSH stops option
  // parsing at the destination, so anything after it is the remote command.
  argv.push("--", user !== undefined ? `${user}@${host}` : host);
  argv.push(buildRemoteCommand(runtime, executionProfile));
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
