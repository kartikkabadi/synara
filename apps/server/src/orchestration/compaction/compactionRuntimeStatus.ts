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
  ThreadCompactionRuntimeStatus,
} from "@synara/contracts";

import type { ThreadCompactionOperation } from "../../persistence/Services/ThreadCompactionOperations.ts";

const PI_DEFAULT_RESERVE_TOKENS = 16_384;
const GROK_DEFAULT_TRIGGER_PERCENT = 85;

// Native auto-compaction thresholds Synara can state exactly. Providers with a
// native pass but no visible threshold report an opaque trigger.
function providerAutoTrigger(
  provider: string | null,
  contextWindowMaxTokens: number | null,
): CompactionTrigger {
  switch (provider) {
    case "claudeAgent":
      // Claude compacts when usage reaches the configured auto-compact window.
      return contextWindowMaxTokens !== null && contextWindowMaxTokens > 0
        ? { kind: "absolute-used-tokens", usedTokens: contextWindowMaxTokens }
        : { kind: "opaque" };
    case "grok":
      return { kind: "percent", percent: GROK_DEFAULT_TRIGGER_PERCENT };
    case "pi":
      return { kind: "remaining-tokens", reserveTokens: PI_DEFAULT_RESERVE_TOKENS };
    default:
      return { kind: "opaque" };
  }
}

export function deriveThreadCompactionRuntimeStatus(input: {
  readonly provider: string | null;
  readonly capabilities: ProviderCompactionCapabilities | null;
  readonly contextWindowMaxTokens?: number | null;
  readonly lastCompaction?: CompactionOperationSummary | undefined;
}): ThreadCompactionRuntimeStatus {
  const { provider, capabilities, lastCompaction } = input;
  const automaticMode = capabilities?.automatic.mode ?? "unknown";
  const owner = automaticMode === "native" ? "provider" : "none";
  const providerAutoEnabled =
    automaticMode === "native"
      ? (capabilities?.automatic.enabledByDefault ?? true)
      : automaticMode === "none"
        ? false
        : null;
  const manualSupported = capabilities !== null && capabilities.manual.mode !== "unsupported";
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
      ? { trigger: providerAutoTrigger(provider, input.contextWindowMaxTokens ?? null) }
      : {}),
    ...(lastCompaction !== undefined ? { lastCompaction } : {}),
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
