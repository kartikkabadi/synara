/**
 * decideCompaction - Pure Synara-managed auto-compaction decision.
 *
 * Evaluates one thread's token usage against its auto-compaction policy and
 * returns whether Synara should compact now, wait, or do nothing. All inputs
 * are explicit so the reactor can call it on every usage event and tests can
 * cover every branch without wiring.
 *
 * @module decideCompaction
 */
import type {
  ProviderCompactionCapabilities,
  RuntimeSessionState,
  RuntimeThreadState,
  SynaraAutoCompactionOptions,
  SynaraAutoCompactionTrigger,
  ThreadCompactionRuntimeStatus,
  ThreadTokenUsageSnapshot,
} from "@synara/contracts";

export interface AutoCompactionDecision {
  readonly action: "compact" | "pending" | "none";
  readonly reason: string;
}

const IDLE_THREAD_STATES: ReadonlySet<string> = new Set(["ready", "idle"]);

interface EvaluableContext {
  readonly usedTokens: number;
  readonly maxTokens: number | undefined;
  readonly usedPercent: number | undefined;
  readonly reliable: boolean;
}

// Prefer the nested context snapshot; the flat fields remain only for
// backward compatibility and carry no measurement provenance.
function contextFromUsage(usage: ThreadTokenUsageSnapshot): EvaluableContext {
  if (usage.context !== undefined) {
    return {
      usedTokens: usage.context.usedTokens,
      maxTokens: usage.context.maxTokens,
      usedPercent: usage.context.usedPercent,
      reliable: usage.context.confidence !== "low",
    };
  }
  return {
    usedTokens: usage.usedTokens,
    maxTokens: usage.maxTokens,
    usedPercent: usage.usedPercent,
    reliable: true,
  };
}

// Returns whether the trigger threshold is reached, or null when the usage
// snapshot lacks the fields required to evaluate it.
function triggerReached(
  trigger: SynaraAutoCompactionTrigger,
  context: EvaluableContext,
): boolean | null {
  switch (trigger.kind) {
    case "percent": {
      const percent =
        context.usedPercent ??
        (context.maxTokens !== undefined && context.maxTokens > 0
          ? (context.usedTokens / context.maxTokens) * 100
          : undefined);
      return percent === undefined ? null : percent >= trigger.percent;
    }
    case "remaining-tokens": {
      if (context.maxTokens === undefined) {
        return null;
      }
      return context.maxTokens - context.usedTokens <= trigger.reserveTokens;
    }
    case "absolute-used-tokens":
      return context.usedTokens >= trigger.usedTokens;
  }
}

/**
 * Decide whether Synara should auto-compact a thread right now.
 *
 * `compact` means the threshold is reached and the thread is safe to compact.
 * `pending` means the threshold is reached but the operation must wait (active
 * turn, or usage too unreliable to act on). `none` means no action.
 */
export function decideAutoCompaction(input: {
  readonly usage: ThreadTokenUsageSnapshot;
  readonly options: SynaraAutoCompactionOptions;
  readonly capability: ProviderCompactionCapabilities;
  readonly runtimeStatus: ThreadCompactionRuntimeStatus;
  readonly threadState: RuntimeThreadState | RuntimeSessionState;
  readonly activeTurnId: string | undefined;
  readonly now: number;
  readonly lastAutoCompactionAt: number | undefined;
}): AutoCompactionDecision {
  const { options, capability, runtimeStatus } = input;
  if (!options.enabled) {
    return { action: "none", reason: "auto-compaction-disabled" };
  }
  if (capability.automatic.mode === "native" && runtimeStatus.providerAutoEnabled !== false) {
    return { action: "none", reason: "provider-native-auto" };
  }
  if (capability.manual.mode !== "same-session" && capability.manual.mode !== "session-rollover") {
    return { action: "none", reason: "manual-compaction-unsupported" };
  }
  const phase = runtimeStatus.phase?.status;
  if (phase === "running" || phase === "pending" || phase === "uncertain") {
    return { action: "none", reason: `operation-${phase}` };
  }
  if (phase === "suspended") {
    return { action: "none", reason: "suspended" };
  }
  if (
    options.cooldownMs !== undefined &&
    input.lastAutoCompactionAt !== undefined &&
    input.now - input.lastAutoCompactionAt < options.cooldownMs
  ) {
    return { action: "none", reason: "cooldown" };
  }
  const context = contextFromUsage(input.usage);
  const reached = triggerReached(options.trigger, context);
  if (reached === null) {
    return { action: "none", reason: "usage-unavailable" };
  }
  if (!reached) {
    return { action: "none", reason: "below-trigger" };
  }
  if (!context.reliable || capability.telemetry.contextUsage === "processed-total-only") {
    return { action: "pending", reason: "usage-unavailable" };
  }
  if (input.activeTurnId !== undefined) {
    return { action: "pending", reason: "active-turn" };
  }
  if (!IDLE_THREAD_STATES.has(input.threadState)) {
    return { action: "none", reason: "thread-not-idle" };
  }
  return { action: "compact", reason: "trigger-reached" };
}
