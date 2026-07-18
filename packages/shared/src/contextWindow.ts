import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@synara/contracts";

export interface ContextWindowUsageSnapshot {
  readonly usage: ThreadTokenUsageSnapshot;
  readonly usedPercentage: number | null;
  readonly updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asContextWindowPercent(value: unknown): number | null {
  const percent = asFiniteNumber(value);
  return percent === null ? null : Math.max(0, Math.min(100, percent));
}

/** Read the latest usable context-window usage emitted by a provider runtime. */
export function deriveLatestContextWindowUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowUsageSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const rawUsedTokens = asFiniteNumber(payload?.usedTokens);
    const usedTokens = rawUsedTokens ?? 0;
    const usedPercent = asContextWindowPercent(payload?.usedPercent);
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (usedTokens <= 0 && usedPercent === null && (maxTokens === null || maxTokens <= 0)) {
      continue;
    }

    const usedPercentage =
      usedPercent ??
      (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
    const optionalNumber = (key: string): number | undefined => {
      const value = asFiniteNumber(payload?.[key]);
      return value === null ? undefined : value;
    };

    return {
      usage: {
        usedTokens,
        usedPercent: usedPercent ?? undefined,
        totalProcessedTokens: optionalNumber("totalProcessedTokens"),
        maxTokens: maxTokens !== null && maxTokens > 0 ? maxTokens : undefined,
        inputTokens: optionalNumber("inputTokens"),
        cachedInputTokens: optionalNumber("cachedInputTokens"),
        outputTokens: optionalNumber("outputTokens"),
        reasoningOutputTokens: optionalNumber("reasoningOutputTokens"),
        lastUsedTokens: optionalNumber("lastUsedTokens"),
        lastInputTokens: optionalNumber("lastInputTokens"),
        lastCachedInputTokens: optionalNumber("lastCachedInputTokens"),
        lastOutputTokens: optionalNumber("lastOutputTokens"),
        lastReasoningOutputTokens: optionalNumber("lastReasoningOutputTokens"),
        toolUses: optionalNumber("toolUses"),
        durationMs: optionalNumber("durationMs"),
        compactsAutomatically:
          typeof payload?.compactsAutomatically === "boolean"
            ? payload.compactsAutomatically
            : undefined,
      },
      usedPercentage,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}
