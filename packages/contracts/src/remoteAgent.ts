import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ExecutionProfile, RemoteAgentConnectionStatus } from "./orchestration";

// RPC schemas for the persistent remote agent that keeps provider sessions
// alive across client disconnects (environments with reconnect: "remote-agent").
// See issue #99 for the decision package.

export const RemoteAgentHelloInput = Schema.Struct({
  agentVersion: TrimmedNonEmptyString,
  protocolVersion: TrimmedNonEmptyString,
});
export type RemoteAgentHelloInput = typeof RemoteAgentHelloInput.Type;

export const RemoteAgentHelloOutput = Schema.Struct({
  agentVersion: TrimmedNonEmptyString,
  protocolVersion: TrimmedNonEmptyString,
});
export type RemoteAgentHelloOutput = typeof RemoteAgentHelloOutput.Type;

export const RemoteAgentSpawnInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  executionProfile: ExecutionProfile,
  providerArgv: Schema.Array(TrimmedNonEmptyString),
});
export type RemoteAgentSpawnInput = typeof RemoteAgentSpawnInput.Type;

export const RemoteAgentAttachInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  lastSeq: Schema.Int,
});
export type RemoteAgentAttachInput = typeof RemoteAgentAttachInput.Type;

export const RemoteAgentSendInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  // Base64 or JSON string forwarded verbatim to the provider process stdin.
  payload: TrimmedNonEmptyString,
});
export type RemoteAgentSendInput = typeof RemoteAgentSendInput.Type;

export const RemoteAgentKillInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type RemoteAgentKillInput = typeof RemoteAgentKillInput.Type;

export const RemoteAgentThreadStatus = Schema.Literals(["running", "exited", "unknown"]);
export type RemoteAgentThreadStatus = typeof RemoteAgentThreadStatus.Type;

export const RemoteAgentStatusInput = Schema.Struct({});
export type RemoteAgentStatusInput = typeof RemoteAgentStatusInput.Type;

export const RemoteAgentStatusOutput = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: TrimmedNonEmptyString,
      seq: Schema.Int,
      status: RemoteAgentThreadStatus,
    }),
  ),
});
export type RemoteAgentStatusOutput = typeof RemoteAgentStatusOutput.Type;

export const RemoteAgentEventKind = Schema.Literals(["stdout", "stderr", "exit"]);
export type RemoteAgentEventKind = typeof RemoteAgentEventKind.Type;

export const RemoteAgentEventEnvelope = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  seq: Schema.Int,
  kind: RemoteAgentEventKind,
  data: TrimmedNonEmptyString,
  exitCode: Schema.optional(Schema.Int),
});
export type RemoteAgentEventEnvelope = typeof RemoteAgentEventEnvelope.Type;

// Emitted by the server whenever a remote thread's transport status changes;
// persisted as the `thread.remote-agent-connection-status-changed` domain event.
export const RemoteAgentConnectionStatusChanged = Schema.Struct({
  _tag: Schema.Literal("RemoteAgentConnectionStatusChanged"),
  threadId: ThreadId,
  environmentId: EnvironmentId,
  status: RemoteAgentConnectionStatus,
  retryCount: Schema.Number,
  lastSeq: Schema.Number,
  message: Schema.optional(Schema.String),
});
export type RemoteAgentConnectionStatusChanged = typeof RemoteAgentConnectionStatusChanged.Type;
