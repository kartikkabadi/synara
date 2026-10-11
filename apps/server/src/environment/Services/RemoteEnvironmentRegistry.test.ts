import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as Descriptor,
} from "@synara/contracts";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerEnvironmentLive } from "../Layers/ServerEnvironment";
import { RemoteEnvironmentRegistryLive } from "../Layers/RemoteEnvironmentRegistry";
import { RemoteEnvironmentError, RemoteEnvironmentRegistry } from "./RemoteEnvironmentRegistry";
import { ServerEnvironment } from "./ServerEnvironment";

const makeLayer = (baseDir: string) =>
  RemoteEnvironmentRegistryLive.pipe(
    Layer.provideMerge(ServerEnvironmentLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const makeDescriptor = (environmentId: string, label = environmentId): Descriptor =>
  Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
    environmentId,
    label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: {},
    runtime: { runtimeType: "ssh-process" },
    transport: { host: "example.test" },
  });

const withRegistry = <A, E>(
  run: (
    registry: RemoteEnvironmentRegistry["Service"],
    environmentsDir: string,
  ) => Effect.Effect<A, E, ServerEnvironment | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "synara-remote-environment-registry-test-",
    });
    return yield* Effect.gen(function* () {
      const registry = yield* RemoteEnvironmentRegistry;
      return yield* run(registry, `${baseDir}/environments`);
    }).pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.runPromise);

describe("RemoteEnvironmentRegistryLive", () => {
  it("lists the immutable local descriptor plus persisted environments", async () => {
    await withRegistry((registry) =>
      Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        const localDescriptor = yield* serverEnvironment.getDescriptor;

        const initial = yield* registry.list();
        expect(initial.map((d) => d.environmentId)).toEqual([localDescriptor.environmentId]);

        yield* registry.upsert(makeDescriptor("env-b"));
        yield* registry.upsert(makeDescriptor("env-a"));

        const listed = yield* registry.list();
        expect(listed.map((d) => d.environmentId)).toEqual([
          localDescriptor.environmentId,
          "env-a",
          "env-b",
        ]);
      }),
    );
  });

  it("upsert persists through the schema and getById round-trips", async () => {
    await withRegistry((registry) =>
      Effect.gen(function* () {
        const descriptor = makeDescriptor("env-round-trip", "Round Trip");
        yield* registry.upsert(descriptor);

        const found = yield* registry.getById(descriptor.environmentId);
        expect(Option.isSome(found)).toBe(true);
        expect(Option.getOrThrow(found)).toEqual(descriptor);

        const updated = makeDescriptor("env-round-trip", "Renamed");
        yield* registry.upsert(updated);
        const afterUpdate = yield* registry.getById(descriptor.environmentId);
        expect(Option.getOrThrow(afterUpdate).label).toBe("Renamed");
      }),
    );
  });

  it("upsert with an invalid descriptor fails with a typed error", async () => {
    await withRegistry((registry) =>
      Effect.gen(function* () {
        const invalid = { ...makeDescriptor("env-invalid"), label: "" } as Descriptor;
        const labelError = yield* registry.upsert(invalid).pipe(Effect.flip);
        expect(labelError).toBeInstanceOf(RemoteEnvironmentError);

        const traversal = {
          ...makeDescriptor("env-invalid"),
          environmentId: EnvironmentId.makeUnsafe("../escape"),
        };
        const traversalError = yield* registry.upsert(traversal).pipe(Effect.flip);
        expect(traversalError).toBeInstanceOf(RemoteEnvironmentError);
        expect(traversalError.reason).toContain("not a safe file name");
      }),
    );
  });

  it("remove deletes a persisted descriptor but never the local one", async () => {
    await withRegistry((registry) =>
      Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;

        const descriptor = makeDescriptor("env-removable");
        yield* registry.upsert(descriptor);
        expect(yield* registry.remove(descriptor.environmentId)).toBe(true);
        expect(Option.isNone(yield* registry.getById(descriptor.environmentId))).toBe(true);
        expect(yield* registry.remove(descriptor.environmentId)).toBe(false);

        const localError = yield* registry.remove(localEnvironmentId).pipe(Effect.flip);
        expect(localError).toBeInstanceOf(RemoteEnvironmentError);
        expect(localError.reason).toContain("immutable");

        const localUpsertError = yield* registry
          .upsert(yield* serverEnvironment.getDescriptor)
          .pipe(Effect.flip);
        expect(localUpsertError).toBeInstanceOf(RemoteEnvironmentError);

        expect((yield* registry.list()).map((d) => d.environmentId)).toEqual([localEnvironmentId]);
      }),
    );
  });

  it("a corrupt descriptor file is skipped while valid environments stay listed", async () => {
    await withRegistry((registry, environmentsDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const serverEnvironment = yield* ServerEnvironment;
        const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;

        yield* registry.upsert(makeDescriptor("env-valid"));
        yield* fileSystem.writeFileString(`${environmentsDir}/env-corrupt.json`, "{not json");
        yield* fileSystem.writeFileString(
          `${environmentsDir}/env-stale.json`,
          JSON.stringify({ environmentId: "env-stale", unexpectedShape: true }),
        );

        const listed = yield* registry.list();
        expect(listed.map((d) => d.environmentId)).toEqual([localEnvironmentId, "env-valid"]);
      }),
    );
  });

  it("a descriptor whose id does not match its file name is rejected", async () => {
    await withRegistry((registry, environmentsDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const serverEnvironment = yield* ServerEnvironment;
        const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;

        yield* registry.upsert(makeDescriptor("env-original"));
        yield* fileSystem.copy(
          `${environmentsDir}/env-original.json`,
          `${environmentsDir}/env-copied.json`,
        );

        const listed = yield* registry.list();
        expect(listed.map((d) => d.environmentId)).toEqual([localEnvironmentId, "env-original"]);

        const mismatchError = yield* registry
          .getById(EnvironmentId.makeUnsafe("env-copied"))
          .pipe(Effect.flip);
        expect(mismatchError).toBeInstanceOf(RemoteEnvironmentError);
        expect(mismatchError.reason).toContain("does not match file name");
      }),
    );
  });

  it("parallel upserts do not corrupt the store", async () => {
    await withRegistry((registry) =>
      Effect.gen(function* () {
        const descriptors = Array.from({ length: 25 }, (_, index) =>
          makeDescriptor(`env-parallel-${index}`),
        );
        const rewrites = Array.from({ length: 25 }, (_, index) =>
          makeDescriptor("env-contended", `writer-${index}`),
        );
        yield* Effect.all(
          [...descriptors, ...rewrites].map((descriptor) => registry.upsert(descriptor)),
          { concurrency: "unbounded" },
        );

        const listed = yield* registry.list();
        expect(listed).toHaveLength(1 + descriptors.length + 1);

        const contended = yield* registry.getById(EnvironmentId.makeUnsafe("env-contended"));
        expect(Option.getOrThrow(contended).label).toMatch(/^writer-\d+$/);
      }),
    );
  });
});
