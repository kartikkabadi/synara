import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionEnvironmentConnection, ExecutionEnvironmentRuntime } from "@synara/contracts";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerEnvironment } from "../Services/ServerEnvironment";
import { ServerEnvironmentLive } from "./ServerEnvironment";

const makeLayer = (baseDir: string) =>
  ServerEnvironmentLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

describe("ServerEnvironmentLive", () => {
  it("persists the environment id across service restarts", async () => {
    await Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "synara-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeLayer(baseDir)));

      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(first.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(second.capabilities.repositoryIdentity).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.runPromise);
  });

  it("returns local runtime and connection defaults that round-trip through the schemas", async () => {
    await Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "synara-server-environment-test-",
      });

      const descriptor = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeLayer(baseDir)));

      expect(descriptor.runtime).toBeDefined();
      expect(descriptor.runtime?.runtimeType).toBe("local");
      expect(descriptor.runtime?.serverVersion).toBe(descriptor.serverVersion);
      expect(descriptor.runtime?.supervisor).toBe("none");

      expect(descriptor.connection).toBeDefined();
      expect(descriptor.connection?.connectionStatus).toBe("connected");
      expect(descriptor.connection?.lastSeenAt).toBeDefined();
      expect(() => new Date(descriptor.connection!.lastSeenAt!).toISOString()).not.toThrow();

      const encodedRuntime = Schema.encodeUnknownSync(ExecutionEnvironmentRuntime)(
        descriptor.runtime,
      );
      expect(Schema.decodeUnknownSync(ExecutionEnvironmentRuntime)(encodedRuntime)).toEqual(
        descriptor.runtime,
      );

      const encodedConnection = Schema.encodeUnknownSync(ExecutionEnvironmentConnection)(
        descriptor.connection,
      );
      expect(Schema.decodeUnknownSync(ExecutionEnvironmentConnection)(encodedConnection)).toEqual(
        descriptor.connection,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.runPromise);
  });
});
