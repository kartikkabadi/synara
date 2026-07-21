import type {
  CompactionTrigger,
  ContextUsageSnapshot,
  CumulativeUsageSnapshot,
  LastTurnUsageSnapshot,
  OrchestrationThreadActivity,
  ProviderCompactionCapabilities,
  ThreadCompactionRuntimeStatus,
  ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND } from "@synara/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const CONTEXT_USAGE_MEASUREMENTS = [
  "provider-reported",
  "provider-estimated",
  "synara-estimated",
] as const;
const CONTEXT_USAGE_CONFIDENCES = ["exact", "high", "medium", "low"] as const;

function asContextUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const usedTokens = asFiniteNumber(record.usedTokens);
  const measurement = CONTEXT_USAGE_MEASUREMENTS.find((entry) => entry === record.measurement);
  const confidence = CONTEXT_USAGE_CONFIDENCES.find((entry) => entry === record.confidence);
  if (usedTokens === null || usedTokens < 0 || !measurement || !confidence) {
    return null;
  }
  const maxTokens = asFiniteNumber(record.maxTokens);
  const usedPercent = asContextWindowPercent(record.usedPercent);
  return {
    usedTokens,
    ...(maxTokens !== null && maxTokens > 0 ? { maxTokens } : {}),
    ...(usedPercent !== null ? { usedPercent } : {}),
    measurement,
    confidence,
  };
}

function asCumulativeUsageSnapshot(value: unknown): CumulativeUsageSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const totalProcessedTokens = asFiniteNumber(record.totalProcessedTokens);
  const inputTokens = asFiniteNumber(record.inputTokens);
  const cachedInputTokens = asFiniteNumber(record.cachedInputTokens);
  const outputTokens = asFiniteNumber(record.outputTokens);
  const reasoningOutputTokens = asFiniteNumber(record.reasoningOutputTokens);
  return {
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== null ? { reasoningOutputTokens } : {}),
    ...(totalProcessedTokens !== null ? { totalProcessedTokens } : {}),
  };
}

function asLastTurnUsageSnapshot(value: unknown): LastTurnUsageSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const inputTokens = asFiniteNumber(record.inputTokens);
  const cachedInputTokens = asFiniteNumber(record.cachedInputTokens);
  const outputTokens = asFiniteNumber(record.outputTokens);
  const reasoningOutputTokens = asFiniteNumber(record.reasoningOutputTokens);
  const durationMs = asFiniteNumber(record.durationMs);
  const toolUses = asFiniteNumber(record.toolUses);
  return {
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== null ? { reasoningOutputTokens } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    ...(toolUses !== null ? { toolUses } : {}),
  };
}

export function isReliableContextUsageConfidence(
  confidence: ContextUsageSnapshot["confidence"],
): boolean {
  return confidence === "exact" || confidence === "high";
}

function asContextWindowPercent(value: unknown): number | null {
  const percent = asFiniteNumber(value);
  if (percent === null) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export interface ContextWindowSelectionStatus {
  readonly activeLabel: string | null;
  readonly selectedLabel: string | null;
  readonly pendingSelectedLabel: string | null;
}

export interface ContextWindowMeterDisplay {
  readonly usedPercentageLabel: string | null;
  readonly tokenUsageLabel: string;
  readonly hasReliableTokenRatio: boolean;
  readonly normalizedPercentage: number;
  readonly compactLabel: string;
  readonly ariaLabel: string;
}

const KNOWN_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

// Read the latest token-usage snapshot emitted by the runtime.
function deriveLatestUsageContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const context = asContextUsageSnapshot(payload?.context);
    const cumulative = asCumulativeUsageSnapshot(payload?.cumulative);
    const lastTurn = asLastTurnUsageSnapshot(payload?.lastTurn);
    // Prefer nested context occupancy; fall back to legacy flat fields.
    const rawUsedTokens = context ? context.usedTokens : asFiniteNumber(payload?.usedTokens);
    const usedTokens = rawUsedTokens ?? 0;
    const payloadUsedPercent = context
      ? asContextWindowPercent(context.usedPercent)
      : asContextWindowPercent(payload?.usedPercent);
    const maxTokens = context
      ? (asFiniteNumber(context.maxTokens) ?? asFiniteNumber(payload?.maxTokens))
      : asFiniteNumber(payload?.maxTokens);
    if (usedTokens <= 0 && payloadUsedPercent === null && (maxTokens === null || maxTokens <= 0)) {
      continue;
    }

    const usedPercentage =
      payloadUsedPercent ??
      (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
    const hasReliableTokenUsage =
      rawUsedTokens !== null &&
      (usedTokens > 0 || payloadUsedPercent === null || (maxTokens !== null && maxTokens > 0));
    const remainingTokens =
      maxTokens !== null && hasReliableTokenUsage
        ? Math.max(0, Math.round(maxTokens - usedTokens))
        : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      usedPercent: payloadUsedPercent,
      totalProcessedTokens: cumulative
        ? asFiniteNumber(cumulative.totalProcessedTokens)
        : asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      context,
      cumulative,
      lastTurn,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

// Use the configured session window as the source of truth for the meter denominator.
function deriveLatestConfiguredContextWindowMaxTokens(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.configured") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (maxTokens !== null && maxTokens > 0) {
      return maxTokens;
    }
  }

  return null;
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  const usageSnapshot = deriveLatestUsageContextWindowSnapshot(activities);
  const configuredMaxTokens = deriveLatestConfiguredContextWindowMaxTokens(activities);

  if (usageSnapshot === null && configuredMaxTokens === null) {
    return null;
  }

  const usedTokens = usageSnapshot?.usedTokens ?? 0;
  const maxTokens = configuredMaxTokens ?? usageSnapshot?.maxTokens ?? null;
  const usedPercentage =
    usageSnapshot?.usedPercent ??
    (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
  const hasReliableTokenUsage =
    usageSnapshot === null ||
    usageSnapshot.usedTokens > 0 ||
    usageSnapshot.usedPercent === null ||
    usageSnapshot.maxTokens !== null;
  const remainingTokens =
    maxTokens !== null && hasReliableTokenUsage
      ? Math.max(0, Math.round(maxTokens - usedTokens))
      : null;
  const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

  return {
    usedTokens,
    usedPercent: usageSnapshot?.usedPercent ?? null,
    totalProcessedTokens: usageSnapshot?.totalProcessedTokens ?? null,
    maxTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    inputTokens: usageSnapshot?.inputTokens ?? null,
    cachedInputTokens: usageSnapshot?.cachedInputTokens ?? null,
    outputTokens: usageSnapshot?.outputTokens ?? null,
    reasoningOutputTokens: usageSnapshot?.reasoningOutputTokens ?? null,
    lastUsedTokens: usageSnapshot?.lastUsedTokens ?? null,
    lastInputTokens: usageSnapshot?.lastInputTokens ?? null,
    lastCachedInputTokens: usageSnapshot?.lastCachedInputTokens ?? null,
    lastOutputTokens: usageSnapshot?.lastOutputTokens ?? null,
    lastReasoningOutputTokens: usageSnapshot?.lastReasoningOutputTokens ?? null,
    toolUses: usageSnapshot?.toolUses ?? null,
    durationMs: usageSnapshot?.durationMs ?? null,
    compactsAutomatically: usageSnapshot?.compactsAutomatically ?? false,
    context: usageSnapshot?.context ?? null,
    cumulative: usageSnapshot?.cumulative ?? null,
    lastTurn: usageSnapshot?.lastTurn ?? null,
    updatedAt: usageSnapshot?.updatedAt ?? activities[activities.length - 1]?.createdAt ?? "",
  };
}

export function deriveSelectedContextWindowSnapshot(
  selectedValue: string | null | undefined,
): ContextWindowSnapshot | null {
  const normalized = selectedValue?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const maxTokens =
    KNOWN_CONTEXT_WINDOW_MAX_TOKENS[normalized as keyof typeof KNOWN_CONTEXT_WINDOW_MAX_TOKENS] ??
    null;
  if (maxTokens === null) {
    return null;
  }

  return {
    usedTokens: 0,
    usedPercent: null,
    totalProcessedTokens: null,
    maxTokens,
    remainingTokens: maxTokens,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    context: null,
    cumulative: null,
    lastTurn: null,
    updatedAt: "",
  };
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function deriveContextWindowMeterDisplay(
  usage: ContextWindowSnapshot,
): ContextWindowMeterDisplay {
  const usedPercentageLabel = formatPercentage(usage.usedPercentage);
  const tokenUsageLabel = formatContextWindowTokens(usage.usedTokens);
  // With a nested context claim, reliability follows its confidence; legacy
  // flat payloads keep the historical heuristic.
  const contextIsReliable = usage.context
    ? isReliableContextUsageConfidence(usage.context.confidence)
    : null;
  const hasReliableTokenRatio =
    contextIsReliable !== null
      ? contextIsReliable && usage.maxTokens !== null
      : usage.maxTokens !== null &&
        (usage.usedTokens > 0 || usage.usedPercent === null || usage.remainingTokens !== null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const showPercentage = usage.usedPercentage !== null && contextIsReliable !== false;
  return {
    usedPercentageLabel,
    tokenUsageLabel,
    hasReliableTokenRatio,
    normalizedPercentage,
    compactLabel: showPercentage ? `${Math.round(usage.usedPercentage ?? 0)}%` : tokenUsageLabel,
    ariaLabel: usedPercentageLabel
      ? `Context window ${usedPercentageLabel} used`
      : `Context window ${tokenUsageLabel} tokens used`,
  };
}

export function deriveCumulativeCostUsd(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  let turnDeltaTotal = 0;
  let latestCumulative: number | null = null;
  let foundTurnDelta = false;
  for (const activity of activities) {
    if (activity.kind !== "turn.completed") continue;
    const payload = asRecord(activity.payload);
    const cumulativeCost = asFiniteNumber(payload?.cumulativeCostUsd);
    if (cumulativeCost !== null) {
      latestCumulative = cumulativeCost;
      continue;
    }
    const cost = asFiniteNumber(payload?.totalCostUsd);
    if (cost === null) continue;
    turnDeltaTotal += cost;
    foundTurnDelta = true;
  }
  if (latestCumulative !== null) {
    return latestCumulative + turnDeltaTotal;
  }
  return foundTurnDelta ? turnDeltaTotal : null;
}

export function formatContextWindowSelectionLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1m") {
    return "1M";
  }
  if (normalized === "200k") {
    return "200k";
  }
  return normalized.replace(/m$/u, "M");
}

export function inferContextWindowSelectionValue(
  maxTokens: number | null | undefined,
): string | null {
  if (maxTokens == null || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return null;
  }
  const bestMatch = Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).reduce<{
    value: string | null;
    relativeDistance: number;
  }>(
    (best, [value, knownMaxTokens]) => {
      const relativeDistance = Math.abs(maxTokens - knownMaxTokens) / knownMaxTokens;
      return relativeDistance < best.relativeDistance ? { value, relativeDistance } : best;
    },
    { value: null, relativeDistance: Number.POSITIVE_INFINITY },
  );
  return bestMatch.relativeDistance <= 0.2 ? bestMatch.value : null;
}

export function deriveContextWindowSelectionStatus(input: {
  activeSnapshot: ContextWindowSnapshot | null;
  selectedValue: string | null | undefined;
}): ContextWindowSelectionStatus {
  const activeValue = inferContextWindowSelectionValue(input.activeSnapshot?.maxTokens ?? null);
  const selectedValue = input.selectedValue?.trim().toLowerCase() ?? null;
  const activeLabel =
    formatContextWindowSelectionLabel(activeValue) ??
    (input.activeSnapshot?.maxTokens != null
      ? formatContextWindowTokens(input.activeSnapshot.maxTokens)
      : null);
  const selectedLabel = formatContextWindowSelectionLabel(selectedValue);
  const pendingSelectedLabel =
    selectedLabel !== null && activeValue !== null && selectedValue !== activeValue
      ? selectedLabel
      : null;

  return {
    activeLabel,
    selectedLabel,
    pendingSelectedLabel,
  };
}

export function formatCostUsd(value: number): string {
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

const COMPACTION_OWNERS = ["provider", "synara", "none"] as const;

function asCompactionTrigger(value: unknown): CompactionTrigger | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  switch (record.kind) {
    case "percent": {
      const percent = asFiniteNumber(record.percent);
      return percent !== null ? { kind: "percent", percent } : null;
    }
    case "remaining-tokens": {
      const reserveTokens = asFiniteNumber(record.reserveTokens);
      return reserveTokens !== null ? { kind: "remaining-tokens", reserveTokens } : null;
    }
    case "absolute-used-tokens": {
      const usedTokens = asFiniteNumber(record.usedTokens);
      return usedTokens !== null ? { kind: "absolute-used-tokens", usedTokens } : null;
    }
    case "opaque":
      return { kind: "opaque" };
    default:
      return null;
  }
}

function asCompactionRuntimeStatus(value: unknown): ThreadCompactionRuntimeStatus | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const owner = COMPACTION_OWNERS.find((entry) => entry === record.owner);
  const manualAvailability = asRecord(record.manualAvailability);
  const available = asBoolean(manualAvailability?.available);
  if (!owner || available === null) {
    return null;
  }
  const reason = typeof manualAvailability?.reason === "string" ? manualAvailability.reason : null;
  const trigger = asCompactionTrigger(record.trigger);
  return {
    owner,
    providerAutoEnabled: asBoolean(record.providerAutoEnabled),
    manualAvailability: { available, ...(reason !== null ? { reason } : {}) },
    ...(trigger !== null ? { trigger } : {}),
  };
}

// Read the latest compaction runtime status projected by the server. The
// status rides the durable activity log, so it survives reconnects.
export function deriveLatestCompactionRuntimeStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadCompactionRuntimeStatus | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND) {
      continue;
    }
    const status = asCompactionRuntimeStatus(activity.payload);
    if (status !== null) {
      return status;
    }
  }
  return null;
}

export function formatCompactionTriggerLabel(
  trigger: CompactionTrigger | null | undefined,
): string | null {
  switch (trigger?.kind) {
    case "percent":
      return `Auto-compacts at ${Math.round(trigger.percent)}%`;
    case "remaining-tokens":
      return `Keeps ${formatContextWindowTokens(trigger.reserveTokens)} tokens free`;
    case "absolute-used-tokens":
      return `Auto-compacts at ${formatContextWindowTokens(trigger.usedTokens)} tokens`;
    default:
      return null;
  }
}

export type ContextCompactionStatusLine =
  | { readonly kind: "provider-auto"; readonly triggerLabel: string | null }
  | { readonly kind: "manual" }
  | { readonly kind: "unavailable" }
  | null;

// Runtime-status-first meter status line: when the server projects a
// ThreadCompactionRuntimeStatus it wins; otherwise fall back to the static
// capability descriptor.
export function deriveContextCompactionStatusLine(input: {
  readonly compaction: ProviderCompactionCapabilities | null | undefined;
  readonly runtimeStatus?: ThreadCompactionRuntimeStatus | null | undefined;
}): ContextCompactionStatusLine {
  const runtimeStatus = input.runtimeStatus ?? null;
  if (runtimeStatus !== null) {
    if (runtimeStatus.owner === "provider" || runtimeStatus.owner === "synara") {
      return {
        kind: "provider-auto",
        triggerLabel: formatCompactionTriggerLabel(runtimeStatus.trigger),
      };
    }
    return runtimeStatus.manualAvailability.available
      ? { kind: "manual" }
      : { kind: "unavailable" };
  }
  const capabilityCopy = deriveContextCompactionMeterCopy({ compaction: input.compaction });
  if (capabilityCopy === "provider-auto") {
    return { kind: "provider-auto", triggerLabel: null };
  }
  if (capabilityCopy === "unavailable") {
    return { kind: "unavailable" };
  }
  const compaction = input.compaction;
  return compaction && compaction.manual.mode !== "unsupported" ? { kind: "manual" } : null;
}

export type ContextCompactionMeterCopy = "provider-auto" | "unavailable" | null;

// Capability-only meter copy: the structured descriptor is the sole source of
// compaction-policy claims. The legacy per-snapshot `compactsAutomatically`
// boolean carries no policy meaning and is never consulted.
export function deriveContextCompactionMeterCopy(input: {
  readonly compaction: ProviderCompactionCapabilities | null | undefined;
}): ContextCompactionMeterCopy {
  const compaction = input.compaction;
  if (!compaction) {
    return null;
  }
  if (compaction.automatic.mode === "native") {
    return "provider-auto";
  }
  if (compaction.manual.mode === "unsupported") {
    return "unavailable";
  }
  return null;
}

export function formatContextWindowTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
