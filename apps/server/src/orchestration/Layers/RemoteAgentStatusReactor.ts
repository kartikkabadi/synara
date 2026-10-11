// FILE: RemoteAgentStatusReactor.ts
// Purpose: Persists remote agent transport status transitions (#99 PR VI).
//          The remote agent provider publishes status changes on the
//          in-process bus; this reactor dispatches them as internal
//          orchestration commands so they reach clients as
//          `thread.remote-agent-connection-status-changed` domain events.

import {
  CommandId,
  type OrchestrationCommand,
  type RemoteAgentConnectionStatusChanged,
} from "@synara/contracts";
import { Effect, Queue } from "effect";

import { subscribeRemoteAgentStatus } from "../../environment/remoteAgentStatusBus.ts";
import { type OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

function dispatchStatusChange(
  orchestrationEngine: OrchestrationEngineShape,
  change: RemoteAgentConnectionStatusChanged,
): Effect.Effect<void> {
  const createdAt = new Date().toISOString();
  const command = {
    type: "thread.remote-agent.connection-status.set" as const,
    commandId: CommandId.makeUnsafe(
      `remote-agent-status:${change.threadId}:${change.status}:${String(change.retryCount)}:${createdAt}`,
    ),
    threadId: change.threadId,
    environmentId: change.environmentId,
    status: change.status,
    retryCount: change.retryCount,
    lastSeq: change.lastSeq,
    ...(change.message !== undefined ? { message: change.message } : {}),
    createdAt,
  } satisfies Extract<OrchestrationCommand, { type: "thread.remote-agent.connection-status.set" }>;
  return orchestrationEngine.dispatch(command).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning("remote agent status dispatch failed", {
        threadId: change.threadId,
        status: change.status,
        error: String(error),
      }),
    ),
  );
}

export const startRemoteAgentStatusReactor = Effect.fn(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  const queue = yield* Queue.unbounded<RemoteAgentConnectionStatusChanged>();
  const unsubscribe = subscribeRemoteAgentStatus((event) => {
    Queue.offerUnsafe(queue, event);
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((change) => dispatchStatusChange(orchestrationEngine, change)),
      ),
    ),
  ).pipe(Effect.asVoid);
});
