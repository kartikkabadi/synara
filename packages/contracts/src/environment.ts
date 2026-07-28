import { Schema } from "effect";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ExecutionEnvironmentRuntimeType = Schema.Literals([
  "local",
  "ssh-process",
  "remote-synara-server",
]);
export type ExecutionEnvironmentRuntimeType = typeof ExecutionEnvironmentRuntimeType.Type;

export const ExecutionEnvironmentSupervisor = Schema.Literals(["systemd", "launchd", "none"]);
export type ExecutionEnvironmentSupervisor = typeof ExecutionEnvironmentSupervisor.Type;

// Host-key verification is always on; policies only choose the trust source.
// "known-hosts" trusts the user's known_hosts files; "pinned-fingerprint"
// additionally requires the host key to match `hostKeyFingerprint`.
export const SshHostKeyVerificationPolicy = Schema.Literals(["known-hosts", "pinned-fingerprint"]);
export type SshHostKeyVerificationPolicy = typeof SshHostKeyVerificationPolicy.Type;

// Paths reference key files on disk; never key or password material itself.
export const ExecutionEnvironmentSshTransport = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(65_535))
    .pipe(Schema.withDecodingDefault(() => 22)),
  user: Schema.optional(TrimmedNonEmptyString),
  sshConfigPath: Schema.optional(TrimmedNonEmptyString),
  identityFile: Schema.optional(TrimmedNonEmptyString),
  jumpHost: Schema.optional(TrimmedNonEmptyString),
  hostKeyVerification: SshHostKeyVerificationPolicy.pipe(
    Schema.withDecodingDefault(() => "known-hosts" as const),
  ),
  hostKeyFingerprint: Schema.optional(TrimmedNonEmptyString),
});
export type ExecutionEnvironmentSshTransport = typeof ExecutionEnvironmentSshTransport.Type;

export const ExecutionEnvironmentRuntime = Schema.Struct({
  runtimeType: ExecutionEnvironmentRuntimeType.pipe(
    Schema.withDecodingDefault(() => "local" as const),
  ),
  serverVersion: Schema.optional(TrimmedNonEmptyString),
  supervisor: ExecutionEnvironmentSupervisor.pipe(
    Schema.withDecodingDefault(() => "none" as const),
  ),
  bootstrapImage: Schema.optional(TrimmedNonEmptyString),
  installPath: Schema.optional(TrimmedNonEmptyString),
  // ssh-process runtimes: provider binary on the remote host; default is a
  // remote PATH lookup. Per-thread workspace scope lives in ExecutionProfile.
  remoteBinaryPath: Schema.optional(TrimmedNonEmptyString),
  // Env-var names (never values) forwarded to the remote provider process.
  forwardedEnvNames: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  adapterProtocolVersion: Schema.optional(TrimmedNonEmptyString),
});
export type ExecutionEnvironmentRuntime = typeof ExecutionEnvironmentRuntime.Type;

const CapabilityFlag = Schema.Boolean.pipe(Schema.withDecodingDefault(() => false));

// "remote-agent": the environment runs a persistent agent that survives client
// disconnects and supports attach/replay; "none": sessions die with the connection.
export const ReconnectCapability = Schema.Literals(["none", "remote-agent"]);
export type ReconnectCapability = typeof ReconnectCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: CapabilityFlag,
  providerKinds: Schema.Array(ProviderKind).pipe(Schema.withDecodingDefault(() => [])),
  shell: CapabilityFlag,
  browser: CapabilityFlag,
  computerUse: CapabilityFlag,
  devServerForwarding: CapabilityFlag,
  checkpoint: CapabilityFlag,
  sync: CapabilityFlag,
  reconnect: ReconnectCapability.pipe(Schema.withDecodingDefault(() => "none" as const)),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentConnectionStatus = Schema.Literals([
  "unknown",
  "disconnected",
  "connecting",
  "connected",
  "degraded",
  "error",
]);
export type ExecutionEnvironmentConnectionStatus = typeof ExecutionEnvironmentConnectionStatus.Type;

export const ExecutionEnvironmentHealthCheckResult = Schema.Struct({
  status: Schema.Literals(["passed", "failed"]),
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ExecutionEnvironmentHealthCheckResult =
  typeof ExecutionEnvironmentHealthCheckResult.Type;

export const ExecutionEnvironmentConnection = Schema.Struct({
  connectionStatus: ExecutionEnvironmentConnectionStatus.pipe(
    Schema.withDecodingDefault(() => "unknown" as const),
  ),
  lastSeenAt: Schema.optional(IsoDateTime),
  healthCheckResult: Schema.optional(ExecutionEnvironmentHealthCheckResult),
});
export type ExecutionEnvironmentConnection = typeof ExecutionEnvironmentConnection.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
  runtime: Schema.optional(ExecutionEnvironmentRuntime),
  transport: Schema.optional(ExecutionEnvironmentSshTransport),
  connection: Schema.optional(ExecutionEnvironmentConnection),
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;
