import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExecutionEnvironmentSshTransport } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  fingerprintOfPublicKey,
  knownHostsFingerprint,
  knownHostsFingerprintFromContents,
  parseSshKeyFingerprint,
  SshHostKeyError,
  verifyPinnedFingerprint,
} from "./sshHostKey.ts";

// Golden pair generated with `ssh-keygen -t ed25519` + `ssh-keygen -lf`.
const KEY_BASE64 = "AAAAC3NzaC1lZDI1NTE5AAAAICOpmqEYLS8c57YX2mlJa3OpvYGv64U1fvaqTdbQCQCD";
const KEY_FINGERPRINT = "SHA256:bc68pUntsFH3kPlgvZQmEdHdD085keEmwjKzPrkknzk";

const transport = (hostKeyFingerprint?: string) =>
  Schema.decodeUnknownSync(ExecutionEnvironmentSshTransport)({
    host: "build.example.com",
    hostKeyVerification: "pinned-fingerprint",
    ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
  });

describe("parseSshKeyFingerprint", () => {
  it("parses ssh-keygen -lf output", () => {
    assert.equal(
      parseSshKeyFingerprint(`256 ${KEY_FINGERPRINT} user@host (ED25519)`),
      KEY_FINGERPRINT,
    );
  });

  it("parses the first fingerprint from multi-line ssh-keyscan output", () => {
    assert.equal(
      parseSshKeyFingerprint(`# host:22 SSH-2.0\n256 ${KEY_FINGERPRINT} host (ED25519)\n`),
      KEY_FINGERPRINT,
    );
  });

  it("returns null when no fingerprint is present", () => {
    assert.equal(parseSshKeyFingerprint("no fingerprint here"), null);
  });
});

describe("fingerprintOfPublicKey", () => {
  it("computes the OpenSSH SHA256 fingerprint", () => {
    assert.equal(fingerprintOfPublicKey(KEY_BASE64), KEY_FINGERPRINT);
  });
});

describe("knownHostsFingerprintFromContents", () => {
  const line = `build.example.com ssh-ed25519 ${KEY_BASE64} comment`;

  it("finds a plain host entry", () => {
    assert.equal(knownHostsFingerprintFromContents(line, "build.example.com"), KEY_FINGERPRINT);
  });

  it("matches comma-separated host patterns", () => {
    assert.equal(
      knownHostsFingerprintFromContents(
        `other.example.com,build.example.com ssh-ed25519 ${KEY_BASE64}`,
        "build.example.com",
      ),
      KEY_FINGERPRINT,
    );
  });

  it("matches bracketed non-default ports", () => {
    assert.equal(
      knownHostsFingerprintFromContents(
        `[build.example.com]:2222 ssh-ed25519 ${KEY_BASE64}`,
        "build.example.com",
        2222,
      ),
      KEY_FINGERPRINT,
    );
  });

  it("skips comments, hashed entries, and non-matching hosts", () => {
    const contents = [
      "# comment",
      `|1|hashed|salt ssh-ed25519 ${KEY_BASE64}`,
      `other.example.com ssh-ed25519 ${KEY_BASE64}`,
    ].join("\n");
    assert.equal(knownHostsFingerprintFromContents(contents, "build.example.com"), null);
  });

  it("handles marker-prefixed entries", () => {
    assert.equal(
      knownHostsFingerprintFromContents(
        `@cert-authority build.example.com ssh-ed25519 ${KEY_BASE64}`,
        "build.example.com",
      ),
      KEY_FINGERPRINT,
    );
  });
});

describe("knownHostsFingerprint", () => {
  let dir: string;
  let knownHostsPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "synara-known-hosts-"));
    knownHostsPath = path.join(dir, "known_hosts");
    await writeFile(knownHostsPath, `build.example.com ssh-ed25519 ${KEY_BASE64}\n`);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the fingerprint for a known host", async () => {
    const fingerprint = await Effect.runPromise(
      knownHostsFingerprint("build.example.com", 22, knownHostsPath),
    );
    assert.equal(fingerprint, KEY_FINGERPRINT);
  });

  it("fails with SshHostKeyError for unknown hosts", async () => {
    const result = await Effect.runPromise(
      knownHostsFingerprint("missing.example.com", 22, knownHostsPath).pipe(Effect.flip),
    );
    assert.ok(result instanceof SshHostKeyError);
  });

  it("fails with SshHostKeyError when the file is missing", async () => {
    const result = await Effect.runPromise(
      knownHostsFingerprint("build.example.com", 22, path.join(dir, "absent")).pipe(Effect.flip),
    );
    assert.ok(result instanceof SshHostKeyError);
  });
});

describe("verifyPinnedFingerprint", () => {
  it("accepts a matching fingerprint", () => {
    assert.equal(verifyPinnedFingerprint(transport(KEY_FINGERPRINT), KEY_FINGERPRINT), true);
  });

  it("normalizes a missing SHA256: prefix", () => {
    assert.equal(
      verifyPinnedFingerprint(transport(KEY_FINGERPRINT.replace("SHA256:", "")), KEY_FINGERPRINT),
      true,
    );
  });

  it("rejects a mismatched fingerprint", () => {
    assert.equal(
      verifyPinnedFingerprint(transport(KEY_FINGERPRINT), "SHA256:completely-different"),
      false,
    );
  });

  it("rejects when no fingerprint is pinned", () => {
    assert.equal(verifyPinnedFingerprint(transport(), KEY_FINGERPRINT), false);
  });
});
