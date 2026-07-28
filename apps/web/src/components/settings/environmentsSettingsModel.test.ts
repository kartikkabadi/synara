import type { ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  descriptorFromEnvironmentForm,
  emptyEnvironmentForm,
  environmentFormFromDescriptor,
  validateEnvironmentForm,
} from "./environmentsSettingsModel";

const noExisting = { existingIds: new Set<string>(), editingId: null };

function validForm() {
  return { ...emptyEnvironmentForm(), environmentId: "box-1", host: "devbox.example.com" };
}

describe("validateEnvironmentForm", () => {
  it("accepts a minimal valid ssh form", () => {
    expect(validateEnvironmentForm(validForm(), noExisting)).toEqual([]);
  });

  it("requires an environment id and rejects duplicates", () => {
    expect(validateEnvironmentForm({ ...validForm(), environmentId: " " }, noExisting)).toEqual([
      "Environment ID is required.",
    ]);
    expect(
      validateEnvironmentForm(validForm(), { existingIds: new Set(["box-1"]), editingId: null }),
    ).toEqual(['An environment with ID "box-1" already exists.']);
    expect(
      validateEnvironmentForm(validForm(), {
        existingIds: new Set(["box-1"]),
        editingId: "box-1",
      }),
    ).toEqual([]);
  });

  it("requires a host for remote runtimes but not local", () => {
    expect(validateEnvironmentForm({ ...validForm(), host: "" }, noExisting)).toEqual([
      "Host is required for remote runtimes.",
    ]);
    expect(
      validateEnvironmentForm({ ...validForm(), host: "", runtimeType: "local" }, noExisting),
    ).toEqual([]);
  });

  it("bounds the port to 1-65535 integers", () => {
    for (const port of ["0", "65536", "22.5", "abc"]) {
      expect(validateEnvironmentForm({ ...validForm(), port }, noExisting)).toEqual([
        "Port must be an integer between 1 and 65535.",
      ]);
    }
  });

  it("requires a fingerprint when pinning and rejects pasted key material", () => {
    expect(
      validateEnvironmentForm(
        { ...validForm(), hostKeyVerification: "pinned-fingerprint" },
        noExisting,
      ),
    ).toEqual(["A host key fingerprint is required when pinning is enabled."]);
    expect(
      validateEnvironmentForm(
        { ...validForm(), identityFile: "-----BEGIN OPENSSH PRIVATE KEY-----" },
        noExisting,
      ),
    ).toEqual(["Identity file must be a path or fingerprint, never key material."]);
  });

  it("requires at least one provider", () => {
    expect(validateEnvironmentForm({ ...validForm(), providerKinds: [] }, noExisting)).toEqual([
      "Select at least one provider.",
    ]);
  });
});

describe("descriptorFromEnvironmentForm", () => {
  it("builds a fresh descriptor with defaults and round-trips through the form", () => {
    const descriptor = descriptorFromEnvironmentForm(validForm(), undefined);
    expect(descriptor.environmentId).toBe("box-1");
    expect(descriptor.label).toBe("box-1");
    expect(descriptor.platform).toEqual({ os: "unknown", arch: "other" });
    expect(descriptor.runtime?.runtimeType).toBe("ssh-process");
    expect(descriptor.runtime?.remoteBinaryPath).toBe("codex");
    expect(descriptor.transport).toEqual({
      host: "devbox.example.com",
      port: 22,
      hostKeyVerification: "known-hosts",
    });
    expect(environmentFormFromDescriptor(descriptor)).toEqual({
      ...validForm(),
      displayName: "box-1",
    });
  });

  it("preserves server-owned fields from the existing descriptor", () => {
    const existing = descriptorFromEnvironmentForm(validForm(), undefined);
    const withServerFields: ExecutionEnvironmentDescriptor = {
      ...existing,
      platform: { os: "linux", arch: "arm64" },
      serverVersion: "1.2.3",
      capabilities: { ...existing.capabilities, shell: true },
      connection: { connectionStatus: "connected" },
    };
    const next = descriptorFromEnvironmentForm(
      { ...environmentFormFromDescriptor(withServerFields), displayName: "Renamed" },
      withServerFields,
    );
    expect(next.label).toBe("Renamed");
    expect(next.platform).toEqual({ os: "linux", arch: "arm64" });
    expect(next.serverVersion).toBe("1.2.3");
    expect(next.capabilities.shell).toBe(true);
    expect(next.connection?.connectionStatus).toBe("connected");
  });

  it("drops the fingerprint when verification falls back to known hosts", () => {
    const descriptor = descriptorFromEnvironmentForm(
      { ...validForm(), hostKeyFingerprint: "SHA256:abc" },
      undefined,
    );
    expect(descriptor.transport?.hostKeyFingerprint).toBeUndefined();
  });
});
