// FILE: sshHostKey.ts
// Purpose: Pure helpers for SSH host-key fingerprint parsing and verification.
//          Parsing works on strings; the only I/O is an isolated known_hosts
//          read wrapped in Effect. Never stores or accepts secret material.
// Layer: Server utility (parsers are IO-free; file read is isolated)

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ExecutionEnvironmentSshTransport } from "@synara/contracts";
import { Effect, Schema } from "effect";

/**
 * SshHostKeyError - Host-key lookup or verification failed.
 */
export class SshHostKeyError extends Schema.TaggedErrorClass<SshHostKeyError>()("SshHostKeyError", {
  reason: Schema.String,
  host: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.host !== undefined
      ? `SSH host-key error for ${this.host}: ${this.reason}`
      : `SSH host-key error: ${this.reason}`;
  }
}

const SHA256_FINGERPRINT_PATTERN = /SHA256:[A-Za-z0-9+/]{43}/;

/**
 * Parses the SHA256 fingerprint from `ssh-keygen -lf <pubkey>` output (e.g.
 * `256 SHA256:xxxx user@host (ED25519)`) or matching `ssh-keyscan` output.
 */
export function parseSshKeyFingerprint(output: string): string | null {
  const match = SHA256_FINGERPRINT_PATTERN.exec(output);
  return match ? match[0] : null;
}

/** SHA256 fingerprint (OpenSSH format, unpadded base64) of a base64 public key. */
export function fingerprintOfPublicKey(base64Key: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

function hostPatternMatches(pattern: string, host: string, port: number): boolean {
  const target = port === 22 ? host : `[${host}]:${port}`;
  return pattern
    .split(",")
    .some((candidate) => candidate === target || (port === 22 && candidate === `[${host}]:22`));
}

/**
 * Finds the host entry in known_hosts contents and returns its SHA256
 * fingerprint. Pure string parser; hashed (`|1|...`) entries are skipped
 * because they cannot be matched without HMAC evaluation.
 */
export function knownHostsFingerprintFromContents(
  contents: string,
  host: string,
  port = 22,
): string | null {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("|")) continue;
    const fields = trimmed.startsWith("@") ? trimmed.split(/\s+/).slice(1) : trimmed.split(/\s+/);
    if (fields.length < 3) continue;
    const [pattern, , base64Key] = fields;
    if (pattern === undefined || base64Key === undefined) continue;
    if (!hostPatternMatches(pattern, host, port)) continue;
    return fingerprintOfPublicKey(base64Key);
  }
  return null;
}

export const DEFAULT_KNOWN_HOSTS_PATH = path.join(homedir(), ".ssh", "known_hosts");

/**
 * Reads a known_hosts file and returns the SHA256 fingerprint for the host.
 * The file read is the only I/O; parsing is delegated to the pure helpers.
 */
export function knownHostsFingerprint(
  host: string,
  port = 22,
  knownHostsPath = DEFAULT_KNOWN_HOSTS_PATH,
): Effect.Effect<string, SshHostKeyError> {
  return Effect.gen(function* () {
    const contents = yield* Effect.tryPromise({
      try: () => readFile(knownHostsPath, "utf8"),
      catch: (cause) =>
        new SshHostKeyError({ reason: `failed to read ${knownHostsPath}: ${String(cause)}`, host }),
    });
    const fingerprint = knownHostsFingerprintFromContents(contents, host, port);
    if (fingerprint === null) {
      return yield* Effect.fail(
        new SshHostKeyError({ reason: `no known_hosts entry in ${knownHostsPath}`, host }),
      );
    }
    return fingerprint;
  });
}

function normalizeFingerprint(value: string): string {
  const trimmed = value.trim();
  const withPrefix = trimmed.startsWith("SHA256:") ? trimmed : `SHA256:${trimmed}`;
  return withPrefix.replace(/=+$/, "");
}

/**
 * Compares the transport's pinned `hostKeyFingerprint` against an observed
 * fingerprint (from known_hosts or ssh-keyscan). Returns false when the
 * transport has no pinned fingerprint.
 */
export function verifyPinnedFingerprint(
  transport: ExecutionEnvironmentSshTransport,
  observedFingerprint: string,
): boolean {
  const pinned = transport.hostKeyFingerprint?.trim() ?? "";
  if (pinned.length === 0) return false;
  return normalizeFingerprint(pinned) === normalizeFingerprint(observedFingerprint);
}
