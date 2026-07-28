// FILE: RemoteAgentProvider.ts
// Purpose: Service contract for spawning provider app-server processes through
//          the persistent synara-remote-agent over ssh (Architecture B,
//          reconnect: "remote-agent"). The returned child looks like a local
//          provider child: agent NDJSON events are demultiplexed back into
//          real stdout/stderr streams and exit events.

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { RemoteAgentThreadStatus } from "@synara/contracts";
import { type Effect, ServiceMap } from "effect";

import type { RemoteAgentError } from "../RemoteEnvironmentErrors";
import type { ProviderProcessSpawnOptions, ProviderSpawnError } from "./ProviderProcessSpawner";
import type { RemoteAgentSpawnPlan } from "./RemoteEnvironmentResolver";

/**
 * Protocol version this server speaks. Must match PROTOCOL_VERSION in
 * apps/remote-agent/src/version.ts; the hello handshake fails closed on any
 * mismatch, so drift is caught on first connect.
 */
export const REMOTE_AGENT_PROTOCOL_VERSION = "0.1.0";

export interface RemoteAgentAttachResult {
  readonly status: RemoteAgentThreadStatus;
  readonly lastSeq: number;
}

export interface RemoteAgentSpawnedProcess {
  /**
   * ChildProcess-shaped adapter: stdout/stderr replay the provider's output
   * demultiplexed from agent/event notifications, stdin writes travel as
   * agent/send requests, and "exit"/"close" fire on the provider's exit event.
   */
  readonly child: ChildProcessWithoutNullStreams;
  /** Subscribes to raw ssh transport stderr output (never parsed as events). */
  readonly onStderr: (callback: (chunk: string) => void) => void;
  /**
   * Sends agent/kill for the thread, then closes the ssh channel. The agent
   * outlives the channel; only the provider process is terminated.
   */
  readonly kill: (signal?: NodeJS.Signals) => void;
}

export interface RemoteAgentProviderShape {
  /** Connects to the agent, performs the hello handshake, and spawns the provider. */
  readonly spawnRemoteAgent: (
    plan: RemoteAgentSpawnPlan,
    options: ProviderProcessSpawnOptions,
  ) => Effect.Effect<RemoteAgentSpawnedProcess, RemoteAgentError | ProviderSpawnError>;
  /**
   * Reconnects to the agent and replays journaled events after `lastSeq`
   * through agent/attach instead of spawning a fresh provider (PR V wires
   * this into the manager's reconnect loop).
   */
  readonly attachRemoteAgent: (
    plan: RemoteAgentSpawnPlan,
    lastSeq: number,
    options: ProviderProcessSpawnOptions,
  ) => Effect.Effect<
    { readonly process: RemoteAgentSpawnedProcess; readonly attach: RemoteAgentAttachResult },
    RemoteAgentError | ProviderSpawnError
  >;
}

export class RemoteAgentProvider extends ServiceMap.Service<
  RemoteAgentProvider,
  RemoteAgentProviderShape
>()("synara/environment/Services/RemoteAgentProvider") {}
