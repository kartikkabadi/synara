/**
 * compactionRuntimeStatus - Pure derivation of the per-thread compaction
 * runtime status projected to clients.
 *
 * Combines the provider capability descriptor, the provider-specific native
 * auto-compaction trigger, and the latest durable compaction operation into a
 * `ThreadCompactionRuntimeStatus` snapshot.
 *
 * @module compactionRuntimeStatus
 */
import type {
  CompactionOperationSummary,
  CompactionTrigger,
  ProviderCompactionCapabilities,
  ThreadCompactionPhase,
  ThreadCompactionRuntimeStatus,
  ThreadCompactionSettings,
} from "@synara/contracts";

import type { ThreadCompactionOperation } from "../../persistence/Services/ThreadCompactionOperations.ts";
import type { CompactionControlState } from "./compactionState.ts";

// Project the durable control state into the client-facing phase snapshot.
export function compactionPhaseFromControlState(
  state: CompactionControlState,
): ThreadCompactionPhase {
  switch (state.status) {
    case "idle":
      return { status: "idle" };
    case "pending":
      return { status: "pending", reason: state.reason };
    case "running":
      return { status: "running" };
    case "uncertain":
      return { status: "uncertain", detail: state.detail, retryable: true };
    case "suspended":
      return {
        status: "suspended",
        reason: state.reason,
        ...(state.detail !== undefined ? { detail: state.detail } : {}),
        retryable: false,
      };
  }
}

export function deriveThreadCompactionRuntimeStatus(input: {
  readonly provider: string | null;
  readonly capabilities: ProviderCompactionCapabilities | null;
  readonly nativeTrigger?: CompactionTrigger | undefined;
  readonly providerAutoEnabled?: boolean | undefined;
  readonly lastCompaction?: CompactionOperationSummary | undefined;
  readonly settings?: ThreadCompactionSettings | undefined;
  readonly controlState?: CompactionControlState | undefined;
}): ThreadCompactionRuntimeStatus {
  const { capabilities, lastCompaction, settings, controlState } = input;
  const automaticMode = capabilities?.automatic.mode ?? "unknown";
  const manualSupported = capabilities !== null && capabilities.manual.mode !== "unsupported";
  const providerAutoEnabled =
    input.providerAutoEnabled ??
    (automaticMode === "native"
      ? (capabilities?.automatic.enabledByDefault ?? null)
      : automaticMode === "none"
        ? false
        : null);
  const synaraManaged =
    (automaticMode !== "native" || providerAutoEnabled === false) &&
    manualSupported &&
    settings?.autoEnabled === true;
  const owner =
    automaticMode === "native" && providerAutoEnabled !== false
      ? "provider"
      : synaraManaged
        ? "synara"
        : "none";
  return {
    owner,
    providerAutoEnabled,
    manualAvailability: manualSupported
      ? { available: true }
      : {
          available: false,
          reason:
            capabilities === null
              ? "Provider compaction capabilities are unknown."
              : "Provider does not support manual compaction.",
        },
    ...(owner === "provider"
      ? { trigger: input.nativeTrigger ?? { kind: "opaque" } }
      : owner === "synara" && settings?.trigger !== undefined
        ? { trigger: settings.trigger }
        : {}),
    ...(controlState !== undefined ? { phase: compactionPhaseFromControlState(controlState) } : {}),
    ...(lastCompaction !== undefined ? { lastCompaction } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };
}

// Project a settled durable operation row into the summary surfaced under
// `lastCompaction`. Unsettled rows carry no outcome and yield null.
export function compactionSummaryFromOperation(
  operation: ThreadCompactionOperation,
): CompactionOperationSummary | null {
  if (
    operation.status !== "completed" &&
    operation.status !== "failed" &&
    operation.status !== "uncertain"
  ) {
    return null;
  }
  return {
    requestId: operation.requestId,
    owner: operation.owner,
    trigger: operation.trigger,
    result: operation.status === "completed" ? "completed" : "failed",
    sessionEffect: operation.sessionEffect ?? "same-session",
    ...(operation.startedAt !== null ? { startedAt: operation.startedAt } : {}),
    ...(operation.completedAt !== null ? { completedAt: operation.completedAt } : {}),
    ...(operation.beforeUsage !== null ? { beforeUsage: operation.beforeUsage } : {}),
    ...(operation.afterUsage !== null ? { afterUsage: operation.afterUsage } : {}),
    ...(operation.status !== "completed" && operation.detail !== null
      ? { failureDetail: operation.detail }
      : {}),
  };
}
