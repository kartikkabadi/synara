// FILE: remoteAgentStatusBus.ts
// Purpose: In-process bridge between the remote agent provider (provider layer
//          graph) and the orchestration engine (runtime services graph). The
//          provider publishes transport status transitions here; the
//          RemoteAgentStatusReactor consumes them and persists domain events.

import type { RemoteAgentConnectionStatusChanged } from "@synara/contracts";

type Listener = (event: RemoteAgentConnectionStatusChanged) => void;

const listeners = new Set<Listener>();

export function publishRemoteAgentStatus(event: RemoteAgentConnectionStatusChanged): void {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeRemoteAgentStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
