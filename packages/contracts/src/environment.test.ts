import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ExecutionEnvironmentCapabilities,
  ExecutionEnvironmentConnection,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentRuntime,
  ExecutionEnvironmentSshTransport,
} from "./environment";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
const decodeTransport = Schema.decodeUnknownSync(ExecutionEnvironmentSshTransport);
const decodeRuntime = Schema.decodeUnknownSync(ExecutionEnvironmentRuntime);
const decodeConnection = Schema.decodeUnknownSync(ExecutionEnvironmentConnection);
const encodeDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor);

describe("ExecutionEnvironmentCapabilities", () => {
  it("defaults all capability flags to false and providerKinds to empty", () => {
    const parsed = decodeCapabilities({});
    expect(parsed.repositoryIdentity).toBe(false);
    expect(parsed.providerKinds).toEqual([]);
    expect(parsed.shell).toBe(false);
    expect(parsed.browser).toBe(false);
    expect(parsed.computerUse).toBe(false);
    expect(parsed.devServerForwarding).toBe(false);
    expect(parsed.checkpoint).toBe(false);
    expect(parsed.sync).toBe(false);
    expect(parsed.reconnect).toBe(false);
  });

  it("accepts explicit provider kinds", () => {
    const parsed = decodeCapabilities({
      providerKinds: ["codex", "claudeAgent"],
      shell: true,
    });
    expect(parsed.providerKinds).toEqual(["codex", "claudeAgent"]);
    expect(parsed.shell).toBe(true);
  });

  it("rejects unknown provider kinds", () => {
    expect(() => decodeCapabilities({ providerKinds: ["not-a-provider"] })).toThrow();
  });
});

describe("ExecutionEnvironmentSshTransport", () => {
  it("defaults port to 22 and host-key policy to known-hosts", () => {
    const parsed = decodeTransport({ host: "vps.example.com" });
    expect(parsed.port).toBe(22);
    expect(parsed.hostKeyVerification).toBe("known-hosts");
    expect(parsed.user).toBeUndefined();
    expect(parsed.jumpHost).toBeUndefined();
  });

  it("accepts a fully specified transport", () => {
    const parsed = decodeTransport({
      host: "10.0.0.5",
      port: 2222,
      user: "synara",
      sshConfigPath: "/home/synara/.ssh/config",
      identityFile: "/home/synara/.ssh/id_ed25519",
      jumpHost: "bastion.example.com",
      hostKeyVerification: "pinned-fingerprint",
      hostKeyFingerprint: "SHA256:abc123",
    });
    expect(parsed.port).toBe(2222);
    expect(parsed.hostKeyVerification).toBe("pinned-fingerprint");
    expect(parsed.hostKeyFingerprint).toBe("SHA256:abc123");
  });

  it("rejects empty host and out-of-range ports", () => {
    expect(() => decodeTransport({ host: "  " })).toThrow();
    expect(() => decodeTransport({ host: "vps", port: 0 })).toThrow();
    expect(() => decodeTransport({ host: "vps", port: 70_000 })).toThrow();
  });

  it("rejects disabling host-key verification", () => {
    expect(() => decodeTransport({ host: "vps", hostKeyVerification: "off" })).toThrow();
    expect(() => decodeTransport({ host: "vps", hostKeyVerification: "insecure" })).toThrow();
  });
});

describe("ExecutionEnvironmentRuntime", () => {
  it("defaults to a local runtime with no supervisor", () => {
    const parsed = decodeRuntime({});
    expect(parsed.runtimeType).toBe("local");
    expect(parsed.supervisor).toBe("none");
    expect(parsed.serverVersion).toBeUndefined();
  });

  it("accepts remote runtime configurations", () => {
    const parsed = decodeRuntime({
      runtimeType: "remote-synara-server",
      serverVersion: "0.6.2",
      supervisor: "systemd",
      installPath: "/opt/synara",
    });
    expect(parsed.runtimeType).toBe("remote-synara-server");
    expect(parsed.supervisor).toBe("systemd");
  });

  it("rejects unknown runtime types and supervisors", () => {
    expect(() => decodeRuntime({ runtimeType: "docker" })).toThrow();
    expect(() => decodeRuntime({ supervisor: "cron" })).toThrow();
  });
});

describe("ExecutionEnvironmentConnection", () => {
  it("defaults connectionStatus to unknown", () => {
    const parsed = decodeConnection({});
    expect(parsed.connectionStatus).toBe("unknown");
    expect(parsed.lastSeenAt).toBeUndefined();
    expect(parsed.healthCheckResult).toBeUndefined();
  });

  it("accepts a health check result", () => {
    const parsed = decodeConnection({
      connectionStatus: "connected",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
      healthCheckResult: {
        status: "passed",
        checkedAt: "2026-07-28T00:00:00.000Z",
      },
    });
    expect(parsed.connectionStatus).toBe("connected");
    expect(parsed.healthCheckResult?.status).toBe("passed");
  });

  it("rejects unknown connection statuses", () => {
    expect(() => decodeConnection({ connectionStatus: "offline" })).toThrow();
  });
});

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes a minimal local descriptor without remote fields", () => {
    const parsed = decodeDescriptor({
      environmentId: "env-1",
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.6.2",
      capabilities: {},
    });
    expect(parsed.environmentId).toBe("env-1");
    expect(parsed.transport).toBeUndefined();
    expect(parsed.runtime).toBeUndefined();
    expect(parsed.connection).toBeUndefined();
  });

  it("round-trips a remote descriptor through encode/decode", () => {
    const parsed = decodeDescriptor({
      environmentId: "env-2",
      label: "Box VPS",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.6.2",
      capabilities: { repositoryIdentity: true, providerKinds: ["codex"], shell: true },
      runtime: { runtimeType: "ssh-process", supervisor: "systemd" },
      transport: { host: "vps.example.com", user: "synara" },
      connection: { connectionStatus: "connected" },
    });
    const reparsed = decodeDescriptor(encodeDescriptor(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it("rejects a descriptor with an invalid platform os", () => {
    expect(() =>
      decodeDescriptor({
        environmentId: "env-3",
        label: "Bad",
        platform: { os: "beos", arch: "x64" },
        serverVersion: "0.6.2",
        capabilities: {},
      }),
    ).toThrow();
  });
});
