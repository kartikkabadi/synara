import {
  ClaudeCacheObservation,
  THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND,
  type CompactionTrigger,
  ContextUsageSnapshot,
  CumulativeUsageSnapshot,
  LastTurnUsageSnapshot,
  type ProviderCompactionCapabilities,
  ThreadCompactionRuntimeStatus,
  type ProviderKind,
  type OrchestrationThreadActivity,
  type ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { normalizeModelSlug, stripClaudeContextWindowSuffix } from "@synara/shared/model";
import { Option, Schema } from "effect";

const decodeClaudeCacheObservation = Schema.decodeUnknownOption(ClaudeCacheObservation);

function readClaudeCacheObservation(value: unknown): ClaudeCacheObservation | null {
  const decoded = decodeClaudeCacheObservation(value);
  return decoded._tag === "Some" ? decoded.value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const decodeContextUsage = Schema.decodeUnknownOption(ContextUsageSnapshot);
const decodeCumulativeUsage = Schema.decodeUnknownOption(CumulativeUsageSnapshot);
const decodeLastTurnUsage = Schema.decodeUnknownOption(LastTurnUsageSnapshot);

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

export interface ContextWindowState {
  readonly snapshot: ContextWindowSnapshot | null;
  readonly invalidatedByCompaction: boolean;
}

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

export function isCompletedContextCompaction(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "thread.compaction-completed") return true;
  if (activity.kind !== "context-compaction") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.state === "compacted" || payload?.status === "completed";
}

// Read the latest token-usage snapshot emitted by the runtime.
export function deriveLatestContextWindowState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowState {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) {
      continue;
    }
    // A new configuration starts a new reporting epoch. Old usage cannot
    // establish the effective threshold of a resumed or switched session.
    if (activity.kind === "context-window.configured") {
      return { snapshot: null, invalidatedByCompaction: false };
    }
    if (isCompletedContextCompaction(activity)) {
      return { snapshot: null, invalidatedByCompaction: true };
    }
    if (activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const context = Option.getOrNull(decodeContextUsage(payload?.context));
    const cumulative = Option.getOrNull(decodeCumulativeUsage(payload?.cumulative));
    const lastTurn = Option.getOrNull(decodeLastTurnUsage(payload?.lastTurn));
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
      snapshot: {
        claudeCache: readClaudeCacheObservation(payload?.claudeCache),
        usedTokens,
        usedPercent: payloadUsedPercent,
        // Older Claude totals counted completed content blocks repeatedly.
        // Keep the context meter, but withhold an unverifiable lifetime counter.
        totalProcessedTokens:
          payload?.provider === "claudeAgent" && payload.tokenAccountingVersion !== 1
            ? null
            : cumulative
              ? asFiniteNumber(cumulative.totalProcessedTokens)
              : asFiniteNumber(payload?.totalProcessedTokens),
        tokenAccountingVersion: payload?.tokenAccountingVersion === 1 ? 1 : null,
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
        cumulative:
          payload?.provider === "claudeAgent" && payload.tokenAccountingVersion !== 1
            ? null
            : cumulative,
        lastTurn,
        updatedAt: activity.createdAt,
      },
      invalidatedByCompaction: false,
    };
  }

  return { snapshot: null, invalidatedByCompaction: false };
}

export interface ObservedClaudeContextBudget {
  readonly model: string;
  readonly maxTokens: number;
}

/** The context window a configuration activity applies: "auto" when cleared, else its size. */
function configuredContextWindowKey(activity: OrchestrationThreadActivity): string {
  const payload = asRecord(activity.payload);
  if (payload?.cleared === true) return "auto";
  return String(asFiniteNumber(payload?.maxTokens) ?? "unknown");
}

/**
 * The context budget the runtime reported for the newest observed Claude model, held at
 * the largest value seen while the configured context window stays the same.
 *
 * Every session start reconfigures the window, and each turn first reports a provisional
 * budget from the model catalog (e.g. 200k) that the live session corrects at the end of
 * the turn (e.g. 1M); usage without a cache observation (task usage) carries no model.
 * Reading each snapshot on its own made the composer label flip between "(200k)", nothing,
 * and "(1M)" for the same model while a turn ran. The server only ever raises its
 * corrected window, so the largest report for one model under one configuration is the
 * stable answer. Compaction shrinks usage, not the window, so it does not reset this.
 */
export function deriveObservedClaudeContextBudget(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ObservedClaudeContextBudget | null {
  // Walking back, reports gather until the configuration they ran under is reached; they
  // count only if that configuration matches the newest one.
  const counted: Array<{ model: string; maxTokens: number }> = [];
  let pending: Array<{ model: string; maxTokens: number }> = [];
  let newestConfiguredKey: string | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    // A completed handoff can change accounts even with the same model and Auto
    // configuration. Its previous runtime budget is no longer evidence.
    if (activity.kind === "provider.handoff") break;
    if (activity.kind === "context-window.configured") {
      const key = configuredContextWindowKey(activity);
      newestConfiguredKey ??= key;
      if (key !== newestConfiguredKey) break;
      counted.push(...pending);
      pending = [];
      continue;
    }
    if (activity.kind !== "context-window.updated") continue;
    const payload = asRecord(activity.payload);
    const model = readClaudeCacheObservation(payload?.claudeCache)?.model;
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (!model || maxTokens === null || maxTokens <= 0) continue;
    pending.push({ model, maxTokens });
  }
  // A history that never recorded its configuration still has one running session.
  if (newestConfiguredKey === null) counted.push(...pending);
  const newestModel = counted[0]?.model;
  if (newestModel === undefined) return null;
  return {
    model: newestModel,
    maxTokens: Math.max(
      ...counted.filter((entry) => entry.model === newestModel).map((entry) => entry.maxTokens),
    ),
  };
}

// Configuration identifies the applied target, never the runtime denominator.
export function deriveAppliedContextWindowSelection(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  const activity = activities.findLast((item) => item.kind === "context-window.configured");
  const payload = asRecord(activity?.payload);
  if (payload?.cleared === true) return "auto";
  const maxTokens = asFiniteNumber(payload?.maxTokens);
  return (
    Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).find(
      ([, tokens]) => tokens === maxTokens,
    )?.[0] ?? null
  );
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
    claudeCache: null,
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
  const usedPercentageLabel =
    usage.context && !isReliableContextUsageConfidence(usage.context.confidence)
      ? null
      : formatPercentage(usage.usedPercentage);
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

/** 16-unit meter glyph: a pie inside an outline ring (1.5 stroke) with a one-unit gap. */
export const CONTEXT_WINDOW_METER_GEOMETRY = {
  center: 8,
  pieRadius: 5.25,
  outlineRadius: 7,
} as const;

/**
 * Filled pie sector for a usage percentage, starting at 12 o'clock and running clockwise.
 * A filled sector inside a closed outline reads as a gauge; the open stroked arc it replaces
 * looked like a loading spinner.
 */
export function contextWindowMeterSectorPath(percentage: number): string | null {
  const fraction = Math.max(0, Math.min(100, percentage)) / 100;
  if (fraction <= 0) return null;
  const c = CONTEXT_WINDOW_METER_GEOMETRY.center;
  const r = CONTEXT_WINDOW_METER_GEOMETRY.pieRadius;
  if (fraction >= 1) {
    return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c} ${c + r} A ${r} ${r} 0 1 1 ${c} ${c - r} Z`;
  }
  const angle = fraction * 2 * Math.PI;
  const x = c + r * Math.sin(angle);
  const y = c - r * Math.cos(angle);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
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

function formatContextWindowSelectionLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "auto") return "Auto";
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
  appliedValue?: string | null;
  selectedValue: string | null | undefined;
}): ContextWindowSelectionStatus {
  const activeValue =
    input.appliedValue === undefined
      ? inferContextWindowSelectionValue(input.activeSnapshot?.maxTokens ?? null)
      : input.appliedValue;
  const selectedValue = input.selectedValue?.trim().toLowerCase() ?? null;
  const activeLabel =
    formatContextWindowSelectionLabel(activeValue) ??
    (input.appliedValue === undefined && input.activeSnapshot?.maxTokens != null
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

// Budget is runtime evidence; the configured mode remains a separate target.
export function deriveComposerContextWindowLabel(input: {
  provider: ProviderKind;
  model: string;
  snapshot: ContextWindowSnapshot | null;
  status: ContextWindowSelectionStatus;
  /** Stable budget from `deriveObservedClaudeContextBudget`; preferred over the snapshot's. */
  observedBudget?: ObservedClaudeContextBudget | null;
}): string | null {
  if (input.provider !== "claudeAgent") return null;
  const observedModel =
    input.observedBudget === undefined
      ? input.snapshot?.claudeCache?.model
      : input.observedBudget?.model;
  const observedMaxTokens =
    input.observedBudget === undefined
      ? input.snapshot?.maxTokens
      : input.observedBudget?.maxTokens;
  const sameModel =
    observedModel !== undefined &&
    stripClaudeContextWindowSuffix(normalizeModelSlug(observedModel, "claudeAgent") ?? "") ===
      stripClaudeContextWindowSuffix(normalizeModelSlug(input.model, "claudeAgent") ?? "");
  const budget = sameModel
    ? formatContextWindowSelectionLabel(inferContextWindowSelectionValue(observedMaxTokens))
    : null;
  const { selectedLabel, activeLabel, pendingSelectedLabel } = input.status;
  const pending = pendingSelectedLabel ?? (!sameModel ? selectedLabel : null);
  if (budget) return pending ? `(${budget} · ${pending} next)` : `(${budget})`;
  if (selectedLabel === null || (selectedLabel === "Auto" && !pendingSelectedLabel)) return null;
  return `(${selectedLabel} ${pending || activeLabel === null ? "next" : "target"})`;
}

export function formatCostUsd(value: number): string {
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

const decodeCompactionRuntimeStatus = Schema.decodeUnknownOption(ThreadCompactionRuntimeStatus);

function asCompactionRuntimeStatus(value: unknown): ThreadCompactionRuntimeStatus | null {
  const decoded = decodeCompactionRuntimeStatus(value);
  return decoded._tag === "Some" ? decoded.value : null;
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
  | { readonly kind: "in-progress" }
  | { readonly kind: "error"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "provider-auto"; readonly triggerLabel: string | null }
  | { readonly kind: "synara-auto"; readonly triggerLabel: string | null }
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
    const phase = runtimeStatus.phase;
    if (phase?.status === "pending" || phase?.status === "running") {
      return { kind: "in-progress" };
    }
    if (phase?.status === "uncertain" || phase?.status === "suspended") {
      return {
        kind: "error",
        reason: phase.detail ?? phase.reason ?? "Compaction failed",
        retryable: phase.retryable ?? phase.status === "uncertain",
      };
    }
    if (runtimeStatus.owner === "provider") {
      return {
        kind: "provider-auto",
        triggerLabel: formatCompactionTriggerLabel(runtimeStatus.trigger),
      };
    }
    if (runtimeStatus.owner === "synara") {
      return {
        kind: "synara-auto",
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
