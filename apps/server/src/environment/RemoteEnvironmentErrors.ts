// FILE: RemoteEnvironmentErrors.ts
// Purpose: Tagged error variants for the remote agent transport (Architecture
//          B, issue #99). Each variant maps to one RPC surface of the agent
//          protocol so failures stay attributable end to end.
// Layer: Server utility (no IO; safe to import from anywhere)

import { Schema } from "effect";

/** The `agent/hello` handshake failed or timed out. */
export class RemoteAgentHelloFailedError extends Schema.TaggedErrorClass<RemoteAgentHelloFailedError>()(
  "RemoteAgentHelloFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent hello failed: ${this.reason}`;
  }
}

/** The agent reported a protocol version this server does not speak. */
export class RemoteAgentVersionMismatchError extends Schema.TaggedErrorClass<RemoteAgentVersionMismatchError>()(
  "RemoteAgentVersionMismatchError",
  {
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent protocol version mismatch: expected ${this.expected}, got ${this.actual}`;
  }
}

/** The agent rejected `agent/spawn` for the provider process. */
export class RemoteAgentSpawnFailedError extends Schema.TaggedErrorClass<RemoteAgentSpawnFailedError>()(
  "RemoteAgentSpawnFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent spawn failed: ${this.reason}`;
  }
}

/** The agent already has a running thread with this threadId. */
export class RemoteAgentThreadExistsError extends Schema.TaggedErrorClass<RemoteAgentThreadExistsError>()(
  "RemoteAgentThreadExistsError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent thread already exists: ${this.threadId}`;
  }
}

/** The agent rejected `agent/attach` (unknown thread or journal failure). */
export class RemoteAgentAttachFailedError extends Schema.TaggedErrorClass<RemoteAgentAttachFailedError>()(
  "RemoteAgentAttachFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent attach failed: ${this.reason}`;
  }
}

/** The agent rejected `agent/send` (thread missing or already exited). */
export class RemoteAgentSendFailedError extends Schema.TaggedErrorClass<RemoteAgentSendFailedError>()(
  "RemoteAgentSendFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent send failed: ${this.reason}`;
  }
}

/** The agent rejected `agent/kill`. */
export class RemoteAgentKillFailedError extends Schema.TaggedErrorClass<RemoteAgentKillFailedError>()(
  "RemoteAgentKillFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent kill failed: ${this.reason}`;
  }
}

/** The agent rejected `agent/status`. */
export class RemoteAgentStatusFailedError extends Schema.TaggedErrorClass<RemoteAgentStatusFailedError>()(
  "RemoteAgentStatusFailedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent status failed: ${this.reason}`;
  }
}

/** An `agent/event` notification did not decode as a valid envelope. */
export class RemoteAgentEventParseError extends Schema.TaggedErrorClass<RemoteAgentEventParseError>()(
  "RemoteAgentEventParseError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Remote agent event parse error: ${this.reason}`;
  }
}

export type RemoteAgentError =
  | RemoteAgentHelloFailedError
  | RemoteAgentVersionMismatchError
  | RemoteAgentSpawnFailedError
  | RemoteAgentThreadExistsError
  | RemoteAgentAttachFailedError
  | RemoteAgentSendFailedError
  | RemoteAgentKillFailedError
  | RemoteAgentStatusFailedError
  | RemoteAgentEventParseError;
