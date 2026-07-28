// FILE: RemoteEnvironmentEndToEnd.test.ts
// Purpose: End-to-end wiring tests for remote execution (#99 PR F): an
//          executionProfile flows from ProviderService through the Codex
//          manager into the resolver/ssh seam, sessions without a profile
//          keep using the local spawner, and the checkEnvironment probe
//          reports a healthy connection against a mock ssh binary.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as Descriptor,
  ExecutionProfile,
  ProviderSessionStartInput,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Option, PubSub, Schema, ServiceMap, Stream } from "effect";
import { it as effectIt, vi as effectVi } from "@effect/vitest";
import { afterAll, describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "../codexAppServerManager";
import type { ProviderAdapterError } from "../provider/Errors";
import { ProviderUnsupportedError } from "../provider/Errors";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry";
import { ProviderService } from "../provider/Services/ProviderService";
import { makeProviderServiceLive } from "../provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { makeEnvironmentProbe } from "./Layers/EnvironmentProbe";
import { makeRemoteEnvironmentResolver } from "./Layers/RemoteEnvironmentResolver";
import { makeSshProcessProvider } from "./Layers/SshProcessProvider";
import {
  KnownHostsPath,
  RemoteEnvironmentResolver,
  type RemoteEnvironmentResolverShape,
  type SpawnPlan,
  type SshSpawnPlan,
} from "./Services/RemoteEnvironmentResolver";
import {
  ProviderProcessSpawner,
  type ProviderProcessSpawnerShape,
} from "./Services/ProviderProcessSpawner";
import {
  RemoteEnvironmentError,
  RemoteEnvironmentRegistry,
  type RemoteEnvironmentRegistryShape,
} from "./Services/RemoteEnvironmentRegistry";
import {
  SshProcessProvider,
  type SshProcessProviderShape,
  type SshSpawnedProcess,
} from "./Services/SshProcessProvider";
import { fingerprintOfPublicKey } from "./sshHostKey";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-remote-e2e-"));
const knownHostsPath = path.join(tempDir, "known_hosts");
const hostPublicKey = Buffer.from("mock-ed25519-public-key").toString("base64");
writeFileSync(knownHostsPath, `remote.test ssh-ed25519 ${hostPublicKey}\n`);

const mockSshPath = path.join(tempDir, "mock-ssh");
// Mock ssh: prints a fake remote PID (matching the `echo $$ && ...` remote
// command shape) followed by a codex version banner, exiting cleanly.
writeFileSync(
  mockSshPath,
  [
    "#!/usr/bin/env bash",
    "echo 4242",
    'echo "codex-cli ${MOCK_CODEX_VERSION:-0.45.0}"',
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(mockSshPath, 0o755);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const executionProfile = Schema.decodeUnknownSync(ExecutionProfile)({
  environmentId: "env-remote",
  providerKind: "codex",
  remoteWorkspaceRoot: "/srv/workspaces/repo",
});

const makeDescriptor = (overrides: Record<string, unknown> = {}): Descriptor =>
  Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
    environmentId: "env-remote",
    label: "remote box",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { providerKinds: ["codex"] },
    runtime: { runtimeType: "ssh-process" },
    transport: { host: "remote.test" },
    ...overrides,
  });

function makeFakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: () => true,
  });
  return child;
}

const sshPlan: SshSpawnPlan = {
  kind: "ssh",
  sshArgs: ["remote.test", "--", "echo $$ && cd '/srv/workspaces/repo' && exec 'codex' app-server"],
  remoteCommand: "echo $$ && cd '/srv/workspaces/repo' && exec 'codex' app-server",
};

describe("CodexAppServerManager remote spawn dispatch", () => {
  function makeSeams(plan: SpawnPlan) {
    const localChild = makeFakeChild();
    const remoteChild = makeFakeChild();
    const spawn = vi.fn(() => Effect.succeed(localChild));
    const resolve = vi.fn(() => Effect.succeed(plan));
    const spawnSsh = vi.fn(() =>
      Effect.succeed({
        child: remoteChild,
        remotePid: Promise.resolve(4242),
        onStderr: () => {},
        exit: new Promise(() => {}),
        kill: () => {},
      } as SshSpawnedProcess),
    );
    const services = ServiceMap.make(ProviderProcessSpawner, {
      spawn,
    } satisfies ProviderProcessSpawnerShape).pipe(
      ServiceMap.add(RemoteEnvironmentResolver, {
        resolve,
      } satisfies RemoteEnvironmentResolverShape),
      ServiceMap.add(SshProcessProvider, { spawnSsh } satisfies SshProcessProviderShape),
    );
    const manager = new CodexAppServerManager(services);
    const spawnCodexAppServer = (
      manager as unknown as {
        spawnCodexAppServer: (input: {
          readonly binaryPath: string;
          readonly cwd: string;
          readonly env: NodeJS.ProcessEnv;
          readonly remote?: {
            readonly executionProfile: ExecutionProfile;
            readonly sessionStartInput: ProviderSessionStartInput;
          };
        }) => Promise<ChildProcessWithoutNullStreams>;
      }
    ).spawnCodexAppServer.bind(manager);
    return { localChild, remoteChild, spawn, resolve, spawnSsh, spawnCodexAppServer };
  }

  const sessionStartInput: ProviderSessionStartInput = {
    threadId: ThreadId.makeUnsafe("thread-remote"),
    provider: "codex",
    runtimeMode: "approval-required",
    executionProfile,
  };

  it("resolves the profile and dispatches ssh plans to the SshProcessProvider", async () => {
    const seams = makeSeams(sshPlan);
    const child = await seams.spawnCodexAppServer({
      binaryPath: "codex",
      cwd: tempDir,
      env: process.env,
      remote: { executionProfile, sessionStartInput },
    });

    expect(seams.resolve).toHaveBeenCalledWith(executionProfile, sessionStartInput);
    expect(seams.spawnSsh).toHaveBeenCalledWith(sshPlan, { cwd: tempDir, env: process.env });
    expect(seams.spawn).not.toHaveBeenCalled();
    expect(child).toBe(seams.remoteChild);
  });

  it("falls back to the local spawner when the resolver returns a local plan", async () => {
    const seams = makeSeams({ kind: "local" });
    const child = await seams.spawnCodexAppServer({
      binaryPath: "codex",
      cwd: tempDir,
      env: process.env,
      remote: { executionProfile, sessionStartInput },
    });

    expect(seams.resolve).toHaveBeenCalledOnce();
    expect(seams.spawnSsh).not.toHaveBeenCalled();
    expect(child).toBe(seams.localChild);
  });

  it("uses the LocalProcessSpawner without touching the resolver when no profile is set", async () => {
    const seams = makeSeams(sshPlan);
    const child = await seams.spawnCodexAppServer({
      binaryPath: "codex",
      cwd: tempDir,
      env: process.env,
    });

    expect(seams.resolve).not.toHaveBeenCalled();
    expect(seams.spawnSsh).not.toHaveBeenCalled();
    expect(seams.spawn).toHaveBeenCalledOnce();
    expect(child).toBe(seams.localChild);
  });
});

describe("ProviderService executionProfile forwarding", () => {
  function makeRecordingAdapter() {
    const startSession = effectVi.fn((input: ProviderSessionStartInput) =>
      Effect.sync(() => {
        const now = new Date().toISOString();
        return {
          provider: "codex" as const,
          status: "ready" as const,
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
      }),
    );
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<never>());
    const adapter = {
      provider: "codex",
      capabilities: { sessionModelSwitch: "in-session", supportsTurnSteering: true },
      startSession,
      sendTurn: () => Effect.die("unused"),
      steerTurn: () => Effect.die("unused"),
      startReview: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      readThread: () => Effect.die("unused"),
      rollbackThread: () => Effect.die("unused"),
      compactThread: () => Effect.die("unused"),
      stopAll: () => Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } as unknown as ProviderAdapterShape<ProviderAdapterError>;
    return { adapter, startSession };
  }

  effectIt.effect("forwards executionProfile from the start input to the adapter", () =>
    Effect.gen(function* () {
      const { adapter, startSession } = makeRecordingAdapter();
      const registry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(NodeServices.layer),
      );

      const threadId = ThreadId.makeUnsafe("thread-profile");
      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(threadId, {
          provider: "codex",
          runtimeMode: "approval-required",
          threadId,
          executionProfile,
        });
      }).pipe(Effect.provide(providerLayer));

      expect(startSession).toHaveBeenCalledOnce();
      const forwarded = startSession.mock.calls[0]?.[0];
      expect(forwarded?.executionProfile).toEqual(executionProfile);
    }),
  );
});

describe("checkEnvironment probe (mock ssh)", () => {
  function makeInMemoryRegistry(descriptors: readonly Descriptor[]) {
    const store = new Map(descriptors.map((d) => [d.environmentId as string, d]));
    const upsert = vi.fn((descriptor: Descriptor) =>
      Effect.sync(() => {
        store.set(descriptor.environmentId as string, descriptor);
        return descriptor;
      }),
    );
    const registry: RemoteEnvironmentRegistryShape = {
      list: () => Effect.succeed([...store.values()]),
      upsert,
      remove: () => Effect.fail(new RemoteEnvironmentError({ reason: "read-only" })),
      getById: (environmentId) =>
        Effect.succeed(Option.fromNullishOr(store.get(environmentId as string))),
    };
    return { registry, upsert, store };
  }

  async function makeProbe(descriptors: readonly Descriptor[]) {
    const { registry, upsert, store } = makeInMemoryRegistry(descriptors);
    const resolver = await Effect.runPromise(
      makeRemoteEnvironmentResolver().pipe(
        Effect.provideService(RemoteEnvironmentRegistry, registry),
        Effect.provideService(KnownHostsPath, knownHostsPath),
      ),
    );
    const probe = await Effect.runPromise(
      makeEnvironmentProbe().pipe(
        Effect.provideService(RemoteEnvironmentRegistry, registry),
        Effect.provideService(RemoteEnvironmentResolver, resolver),
        Effect.provideService(SshProcessProvider, makeSshProcessProvider(mockSshPath)),
      ),
    );
    return { probe, upsert, store };
  }

  it("returns a healthy connection and records it on the descriptor", async () => {
    const { probe, upsert, store } = await makeProbe([makeDescriptor()]);
    const connection = await Effect.runPromise(probe.check(executionProfile));

    expect(connection.connectionStatus).toBe("connected");
    expect(connection.healthCheckResult?.status).toBe("passed");
    expect(connection.healthCheckResult?.message).toBe("codex v0.45.0");
    expect(upsert).toHaveBeenCalled();
    expect(store.get("env-remote")?.connection).toEqual(connection);
  });

  it("fails with RemoteEnvironmentUnsupportedVersionError below the minimum version", async () => {
    process.env.MOCK_CODEX_VERSION = "0.30.0";
    try {
      const { probe, store } = await makeProbe([makeDescriptor()]);
      const error = await Effect.runPromise(probe.check(executionProfile).pipe(Effect.flip));
      expect(error._tag).toBe("RemoteEnvironmentUnsupportedVersionError");
      expect(store.get("env-remote")?.connection?.healthCheckResult?.status).toBe("failed");
    } finally {
      delete process.env.MOCK_CODEX_VERSION;
    }
  });

  it("fails with RemoteEnvironmentProviderKindError for unsupported provider kinds", async () => {
    const { probe } = await makeProbe([
      makeDescriptor({ capabilities: { providerKinds: ["claudeAgent"] } }),
    ]);
    const error = await Effect.runPromise(probe.check(executionProfile).pipe(Effect.flip));
    expect(error._tag).toBe("RemoteEnvironmentProviderKindError");
  });

  it("fails with RemoteEnvironmentNotFoundError for unknown environments", async () => {
    const { probe } = await makeProbe([]);
    const error = await Effect.runPromise(probe.check(executionProfile).pipe(Effect.flip));
    expect(error._tag).toBe("RemoteEnvironmentNotFoundError");
  });
});
