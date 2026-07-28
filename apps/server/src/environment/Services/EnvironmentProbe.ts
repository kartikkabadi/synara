// FILE: EnvironmentProbe.ts
// Purpose: Service contract for pre-flight health/capability probing of an
//          execution environment: verifies the remote workspace root exists,
//          runs the provider version probe over ssh, and enforces the same
//          minimum-version gate as local sessions.

import type { ExecutionEnvironmentConnection, ExecutionProfile } from "@synara/contracts";
import { type Effect, Schema, ServiceMap } from "effect";

import type { ProviderSpawnError } from "./ProviderProcessSpawner";
import type { RemoteEnvironmentResolveError } from "./RemoteEnvironmentResolver";

/**
 * RemoteEnvironmentUnsupportedVersionError - The provider CLI on the remote
 * host is below the minimum version Synara supports.
 */
export class RemoteEnvironmentUnsupportedVersionError extends Schema.TaggedErrorClass<RemoteEnvironmentUnsupportedVersionError>()(
  "RemoteEnvironmentUnsupportedVersionError",
  {
    environmentId: Schema.String,
    version: Schema.NullOr(Schema.String),
    minimumVersion: Schema.String,
  },
) {
  override get message(): string {
    const versionLabel = this.version === null ? "an unparseable version" : `v${this.version}`;
    return `Environment "${this.environmentId}" runs Codex CLI ${versionLabel}; Synara requires v${this.minimumVersion} or newer`;
  }
}

export type EnvironmentProbeError =
  | RemoteEnvironmentResolveError
  | RemoteEnvironmentUnsupportedVersionError
  | ProviderSpawnError;

export interface EnvironmentProbeShape {
  /**
   * Probes the environment referenced by the profile and records the outcome
   * on the descriptor's connection in the registry. Reachability failures
   * (transport, missing workspace, unparseable version) are reported through
   * the returned connection; resolution failures and an unsupported provider
   * version fail with a typed error.
   */
  readonly check: (
    executionProfile: ExecutionProfile,
  ) => Effect.Effect<ExecutionEnvironmentConnection, EnvironmentProbeError>;
}

export class EnvironmentProbe extends ServiceMap.Service<EnvironmentProbe, EnvironmentProbeShape>()(
  "synara/environment/Services/EnvironmentProbe",
) {}
