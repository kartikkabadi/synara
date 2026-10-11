const resolverScopes: Scope.Closeable[] = [];
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Exit, Scope, Effect, Option, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as Descriptor,
  ExecutionProfile,
  ProviderSessionStartInput,
} from "@synara/contracts";

import { makeRemoteEnvironmentResolver } from "./Layers/RemoteEnvironmentResolver";
import {
  KnownHostsPath,
  type RemoteEnvironmentResolverShape,
} from "./Services/RemoteEnvironmentResolver";
import {
  RemoteEnvironmentError,
  RemoteEnvironmentRegistry,
  type RemoteEnvironmentRegistryShape,
} from "./Services/RemoteEnvironmentRegistry";
import { fingerprintOfPublicKey } from "./sshHostKey";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-resolver-test-"));
const knownHostsPath = path.join(tempDir, "known_hosts");
const hostPublicKey = Buffer.from("mock-ed25519-public-key").toString("base64");
const hostFingerprint = fingerprintOfPublicKey(hostPublicKey);

writeFileSync(knownHostsPath, `remote.test ssh-ed25519 ${hostPublicKey}\n`);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const makeDescriptor = (overrides: Record<string, unknown>): Descriptor =>
  Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
    environmentId: "env-1",
    label: "env-1",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { providerKinds: ["codex"] },
    ...overrides,
  });

const makeInMemoryRegistry = (
  descriptors: readonly Descriptor[],
): RemoteEnvironmentRegistryShape => ({
  list: () => Effect.succeed(descriptors),
  upsert: () => Effect.fail(new RemoteEnvironmentError({ reason: "read-only test registry" })),
  remove: () => Effect.fail(new RemoteEnvironmentError({ reason: "read-only test registry" })),
  getById: (environmentId) =>
    Effect.succeed(
      Option.fromNullishOr(descriptors.find((d) => d.environmentId === environmentId)),
    ),
});

const makeResolver = async (
  descriptors: readonly Descriptor[],
): Promise<RemoteEnvironmentResolverShape> =>
  Effect.runPromise(
    makeRemoteEnvironmentResolver({ originId: "isolated-test-origin" }).pipe(
      Effect.provideService(Scope.Scope, await newResolverScope()),
      Effect.provideService(RemoteEnvironmentRegistry, makeInMemoryRegistry(descriptors)),
      Effect.provideService(KnownHostsPath, knownHostsPath),
    ),
  );

const makeProfile = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(ExecutionProfile)({
    environmentId: "env-1",
    providerKind: "codex",
    remoteWorkspaceRoot: "/srv/workspaces/repo",
    ...overrides,
  });

const startInput = Schema.decodeUnknownSync(ProviderSessionStartInput)({
  threadId: "thread-1",
  runtimeMode: "approval-required",
});

describe("RemoteEnvironmentResolver", () => {
  it("returns a local plan for local runtimes", async () => {
    const resolver = await makeResolver([makeDescriptor({ runtime: { runtimeType: "local" } })]);
    const plan = await Effect.runPromise(resolver.resolve(makeProfile(), startInput));
    expect(plan).toEqual({ kind: "local" });
  });

  it("returns an ssh plan with the built argv for ssh-process runtimes", async () => {
    const resolver = await makeResolver([
      makeDescriptor({
        runtime: { runtimeType: "ssh-process" },
        transport: { host: "remote.test" },
      }),
    ]);
    const plan = await Effect.runPromise(resolver.resolve(makeProfile(), startInput));
    expect(plan.kind).toBe("ssh");
    if (plan.kind === "ssh") {
      expect(plan.sshArgs.at(-1)).toBe(plan.remoteCommand);
      expect(plan.remoteCommand).toBe(
        "echo \"__SYNARA_REMOTE_PID__=$$\" && cd '/srv/workspaces/repo' && exec 'codex' app-server",
      );
      expect(plan.sshArgs).toContain("remote.test");
    }
  });

  it("fails with RemoteEnvironmentNotFoundError for unknown environments", async () => {
    const resolver = await makeResolver([]);
    const error = await Effect.runPromise(
      resolver.resolve(makeProfile({ environmentId: "missing" }), startInput).pipe(Effect.flip),
    );
    expect(error._tag).toBe("RemoteEnvironmentNotFoundError");
  });

  it("fails when the environment does not support the provider kind", async () => {
    const resolver = await makeResolver([
      makeDescriptor({ capabilities: { providerKinds: ["claudeAgent"] } }),
    ]);
    const error = await Effect.runPromise(
      resolver.resolve(makeProfile(), startInput).pipe(Effect.flip),
    );
    expect(error._tag).toBe("RemoteEnvironmentProviderKindError");
  });

  it("fails with a typed error for remote-synara-server runtimes (Architecture B)", async () => {
    const resolver = await makeResolver([
      makeDescriptor({ runtime: { runtimeType: "remote-synara-server" } }),
    ]);
    const error = await Effect.runPromise(
      resolver.resolve(makeProfile(), startInput).pipe(Effect.flip),
    );
    expect(error._tag).toBe("RemoteEnvironmentUnsupportedRuntimeError");
  });

  it("leaves known-host aliases and configured trust files to strict OpenSSH verification", async () => {
    const resolver = await makeResolver([
      makeDescriptor({
        runtime: { runtimeType: "ssh-process" },
        transport: { host: "configured-alias" },
      }),
    ]);
    const plan = await Effect.runPromise(resolver.resolve(makeProfile(), startInput));
    expect(plan.kind).toBe("ssh");
    if (plan.kind !== "local") expect(plan.sshArgs).toContain("StrictHostKeyChecking=yes");
  });

  it("verifies pinned fingerprints and fails closed on mismatch", async () => {
    const matching = await makeResolver([
      makeDescriptor({
        runtime: { runtimeType: "ssh-process" },
        transport: {
          host: "remote.test",
          hostKeyVerification: "pinned-fingerprint",
          hostKeyFingerprint: hostFingerprint,
        },
      }),
    ]);
    const plan = await Effect.runPromise(matching.resolve(makeProfile(), startInput));
    expect(plan.kind).toBe("ssh");
    if (plan.kind !== "local") {
      expect(plan.sshArgs).toContain("GlobalKnownHostsFile=none");
      expect(plan.sshArgs).toContain("KnownHostsCommand=none");
      expect(plan.sshArgs).toContain("ControlPath=none");
      const fileOption = plan.sshArgs.find((arg) => arg.startsWith("UserKnownHostsFile="))!;
      const file = fileOption.slice('UserKnownHostsFile="'.length, -1);
      expect(readFileSync(file, "utf8")).toContain(`ssh-ed25519 ${hostPublicKey}`);
      expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    }

    const mismatching = await makeResolver([
      makeDescriptor({
        runtime: { runtimeType: "ssh-process" },
        transport: {
          host: "remote.test",
          hostKeyVerification: "pinned-fingerprint",
          hostKeyFingerprint: "SHA256:0000000000000000000000000000000000000000000",
        },
      }),
    ]);
    const error = await Effect.runPromise(
      mismatching.resolve(makeProfile(), startInput).pipe(Effect.flip),
    );
    expect(error._tag).toBe("RemoteEnvironmentHostKeyError");
  });
});

async function newResolverScope(): Promise<Scope.Closeable> {
  const scope = await Effect.runPromise(Scope.make());
  resolverScopes.push(scope);
  return scope;
}
afterAll(async () => {
  for (const scope of resolverScopes) await Effect.runPromise(Scope.close(scope, Exit.void));
});
