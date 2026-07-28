import type { ChildProcess } from "node:child_process";

import type { RemoteAgentEventKind, RemoteAgentThreadStatus } from "@synara/contracts/remoteAgent";

export interface JournalEntry {
  seq: number;
  kind: RemoteAgentEventKind;
  data: string;
  exitCode?: number;
}

export interface ThreadState {
  threadId: string;
  child: ChildProcess;
  seq: number;
  status: RemoteAgentThreadStatus;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}
