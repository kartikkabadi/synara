// FILE: RemoteEnvironmentRegistry.ts
// Purpose: Filesystem-backed layer for the RemoteEnvironmentRegistry service.
//          Each remote environment is persisted as one JSON file under
//          `<SYNARA_HOME>/environments/<environmentId>.json`, written atomically
//          so parallel upserts can never corrupt the store. The local server
//          environment (from ServerEnvironment) is always listed and immutable.

import {
  type EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as Descriptor,
} from "@synara/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite";
import { ServerConfig } from "../../config";
import {
  RemoteEnvironmentError,
  RemoteEnvironmentRegistry,
  type RemoteEnvironmentRegistryShape,
} from "../Services/RemoteEnvironmentRegistry";
import { ServerEnvironment } from "../Services/ServerEnvironment";

export const ENVIRONMENTS_DIRECTORY_NAME = "environments";

// Descriptor ids become file names, so restrict them to a filesystem-safe
// alphabet; UUIDs and human-readable slugs both pass.
const SAFE_ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const DescriptorJson = Schema.fromJsonString(ExecutionEnvironmentDescriptor);
const decodeDescriptorJson = Schema.decodeUnknownEffect(DescriptorJson);
const encodeDescriptorJson = Schema.encodeEffect(DescriptorJson);

const asRegistryError = (operation: string) => (cause: unknown) =>
  new RemoteEnvironmentError({
    reason: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const requireSafeEnvironmentId = (environmentId: string) =>
  SAFE_ENVIRONMENT_ID_PATTERN.test(environmentId)
    ? Effect.succeed(environmentId)
    : Effect.fail(
        new RemoteEnvironmentError({
          reason: `environmentId is not a safe file name: ${JSON.stringify(environmentId)}`,
        }),
      );

export const makeRemoteEnvironmentRegistry = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const serverEnvironment = yield* ServerEnvironment;

  const environmentsDir = path.join(serverConfig.baseDir, ENVIRONMENTS_DIRECTORY_NAME);
  const descriptorPath = (environmentId: string) =>
    path.join(environmentsDir, `${environmentId}.json`);

  const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;

  const requireRemoteEnvironmentId = (environmentId: EnvironmentId) =>
    environmentId === localEnvironmentId
      ? Effect.fail(
          new RemoteEnvironmentError({
            reason: "The local environment is immutable and cannot be modified or removed",
          }),
        )
      : requireSafeEnvironmentId(environmentId);

  const readDescriptorFile = (filePath: string) =>
    fileSystem
      .readFileString(filePath)
      .pipe(
        Effect.flatMap(decodeDescriptorJson),
        Effect.mapError(asRegistryError(`Failed to read environment descriptor ${filePath}`)),
      );

  const listPersisted = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(environmentsDir)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as readonly Descriptor[];

    const entries = yield* fileSystem
      .readDirectory(environmentsDir)
      .pipe(Effect.mapError(asRegistryError("Failed to list environments directory")));
    const fileNames = entries.filter((entry) => entry.endsWith(".json")).toSorted();
    return yield* Effect.forEach(fileNames, (fileName) =>
      readDescriptorFile(path.join(environmentsDir, fileName)),
    );
  });

  const list = () =>
    Effect.gen(function* () {
      const localDescriptor = yield* serverEnvironment.getDescriptor;
      const persisted = yield* listPersisted;
      return [localDescriptor, ...persisted.filter((d) => d.environmentId !== localEnvironmentId)];
    });

  const upsert = (descriptor: Descriptor) =>
    Effect.gen(function* () {
      yield* requireRemoteEnvironmentId(descriptor.environmentId);
      const contents = yield* Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)(
        descriptor,
      ).pipe(
        Effect.flatMap(encodeDescriptorJson),
        Effect.mapError(asRegistryError("Invalid environment descriptor")),
      );
      yield* writeFileStringAtomically({
        filePath: descriptorPath(descriptor.environmentId),
        contents: `${contents}\n`,
      }).pipe(Effect.mapError(asRegistryError("Failed to persist environment descriptor")));
    });

  const remove = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      yield* requireRemoteEnvironmentId(environmentId);
      const filePath = descriptorPath(environmentId);
      const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return false;
      yield* fileSystem
        .remove(filePath, { force: true })
        .pipe(Effect.mapError(asRegistryError("Failed to remove environment descriptor")));
      return true;
    });

  const getById = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      if (environmentId === localEnvironmentId) {
        return Option.some(yield* serverEnvironment.getDescriptor);
      }
      yield* requireSafeEnvironmentId(environmentId);
      const filePath = descriptorPath(environmentId);
      const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return Option.none<Descriptor>();
      return Option.some(yield* readDescriptorFile(filePath));
    });

  return {
    list,
    upsert,
    remove,
    getById,
  } satisfies RemoteEnvironmentRegistryShape;
});

export const RemoteEnvironmentRegistryLive = Layer.effect(
  RemoteEnvironmentRegistry,
  makeRemoteEnvironmentRegistry(),
);
