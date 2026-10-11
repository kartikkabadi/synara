// FILE: RemoteEnvironmentRegistry.ts
// Purpose: Service contract for persisting remote ExecutionEnvironmentDescriptors.
//          The local server environment is always present and immutable.

import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { type Effect, type Option, Schema, ServiceMap } from "effect";

/**
 * RemoteEnvironmentError - A registry operation failed (invalid descriptor,
 * immutable local environment, or storage failure).
 */
export class RemoteEnvironmentError extends Schema.TaggedErrorClass<RemoteEnvironmentError>()(
  "RemoteEnvironmentError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote environment registry error: ${this.reason}`;
  }
}

export interface RemoteEnvironmentRegistryShape {
  readonly list: () => Effect.Effect<
    readonly ExecutionEnvironmentDescriptor[],
    RemoteEnvironmentError
  >;
  readonly upsert: (
    descriptor: ExecutionEnvironmentDescriptor,
  ) => Effect.Effect<void, RemoteEnvironmentError>;
  readonly remove: (environmentId: EnvironmentId) => Effect.Effect<boolean, RemoteEnvironmentError>;
  readonly getById: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<ExecutionEnvironmentDescriptor>, RemoteEnvironmentError>;
}

export class RemoteEnvironmentRegistry extends ServiceMap.Service<
  RemoteEnvironmentRegistry,
  RemoteEnvironmentRegistryShape
>()("synara/environment/Services/RemoteEnvironmentRegistry") {}
