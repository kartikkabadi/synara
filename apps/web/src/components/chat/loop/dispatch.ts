// FILE: dispatch.ts
// Purpose: Single dispatch → snapshot-sync path for every `/loop` command.
// Layer: Web chat loop helpers (no JSX, no hooks)
// Callers pick their own error copy via onError; the plumbing lives here once.

import {
  type ClientOrchestrationCommand,
  type CommandId,
  type LoopActivationId,
  type OrchestrationShellSnapshot,
  type ThreadId,
} from "@synara/contracts";
import { loopBudgetChoiceToDispatchFields, type LoopBudgetChoice } from "../../../lib/loop";
import { newCommandId } from "../../../lib/utils";
import { readNativeApi } from "../../../nativeApi";

export interface DispatchLoopCommandInput {
  command: ClientOrchestrationCommand;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  onError: (error: unknown) => void;
}

// Dispatches the command, then refreshes the shell snapshot so the loop state
// the UI renders is authoritative. Returns false (after onError) on failure.
export async function dispatchLoopCommand(input: DispatchLoopCommandInput): Promise<boolean> {
  const api = readNativeApi();
  if (!api) {
    input.onError(new Error("Unable to connect to the app server."));
    return false;
  }
  try {
    await api.orchestration.dispatchCommand(input.command);
    input.syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
    return true;
  } catch (error) {
    input.onError(error);
    return false;
  }
}

export function buildLoopSetCommand(input: {
  threadId: ThreadId;
  objective: string;
  budget: LoopBudgetChoice;
  expectedActivationId?: LoopActivationId;
  commandId?: CommandId;
}): Extract<ClientOrchestrationCommand, { type: "thread.loop.set" }> {
  const fields = loopBudgetChoiceToDispatchFields(input.budget);
  return {
    type: "thread.loop.set",
    commandId: input.commandId ?? newCommandId(),
    threadId: input.threadId,
    prompt: input.objective.trim(),
    maxIterations: fields.maxIterations,
    durationSeconds: fields.durationSeconds,
    ...(input.expectedActivationId !== undefined
      ? { expectedActivationId: input.expectedActivationId }
      : {}),
    createdAt: new Date().toISOString(),
  };
}

export type LoopSetupSubmitResult = { ok: true } | { ok: false; message: string };

// Guided setup / edit submit: one `thread.loop.set` through the shared path.
export async function performLoopSetupSubmit(input: {
  threadId: ThreadId;
  objective: string;
  budget: LoopBudgetChoice;
  expectedActivationId?: LoopActivationId;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}): Promise<LoopSetupSubmitResult> {
  let message = "An error occurred while starting the loop.";
  const ok = await dispatchLoopCommand({
    command: buildLoopSetCommand(input),
    syncServerShellSnapshot: input.syncServerShellSnapshot,
    onError: (error) => {
      if (error instanceof Error) message = error.message;
    },
  });
  return ok ? { ok: true } : { ok: false, message };
}
