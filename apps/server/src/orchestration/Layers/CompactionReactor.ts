import type { ProviderKind, ThreadId } from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { CompactionReactor, type CompactionReactorShape } from "../Services/CompactionReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

// Static provider compaction capability map (verified from providerDiscovery.ts +
// adapter source). Provider capabilities don't change at runtime, so a compile-time
// constant avoids a cross-service dependency on ProviderDiscoveryService.
//
// supportsCompaction: provider exposes a compact action (Synara can drive it)
// autoCompacts: provider handles compaction internally (Synara should stay out)
const PROVIDER_COMPACTION_CAPABILITY: Record<
  ProviderKind,
  { supportsCompaction: boolean; autoCompacts: boolean }
> = {
  codex: { supportsCompaction: true, autoCompacts: true },
  claudeAgent: { supportsCompaction: false, autoCompacts: false },
  cursor: { supportsCompaction: false, autoCompacts: true },
  gemini: { supportsCompaction: false, autoCompacts: true },
  grok: { supportsCompaction: false, autoCompacts: false },
  kilo: { supportsCompaction: false, autoCompacts: false },
  opencode: { supportsCompaction: true, autoCompacts: false },
  pi: { supportsCompaction: true, autoCompacts: false },
};

const EMERGENCY_THRESHOLD = 90;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const settingsService = yield* ServerSettingsService;

  // Per-thread compaction lock + last-compaction timestamp. The lock prevents
  // double-compaction from rapid events; the timestamp enforces the cooldown.
  // In-memory only — lost on restart, which is fine (compaction is idempotent).
  const compactingThreads = new Set<ThreadId>();
  const lastCompactedAt = new Map<ThreadId, number>();

  const handleActivity = Effect.fn(function* (threadId: ThreadId) {
    const settings = yield* settingsService.getSettings;
    if (!settings.autoCompactionEnabled) {
      return;
    }

    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(threadId),
    );
    if (!thread) {
      return;
    }

    const provider = thread.modelSelection.provider as ProviderKind;
    const capability = PROVIDER_COMPACTION_CAPABILITY[provider];
    if (!capability) {
      return;
    }
    // Provider handles compaction internally — stay out of the way.
    if (capability.autoCompacts) {
      return;
    }
    // Provider can't compact at all — nothing to do. (LoopReactor handles the
    // pause-on-high-usage path for loops on these providers.)
    if (!capability.supportsCompaction) {
      return;
    }

    // Scan activities backwards for the latest context-window.updated activity.
    // This reuses the same scanning pattern as the web UI's contextWindow.ts.
    let usedPercent: number | null = null;
    let compactsAutomatically = false;
    for (let i = thread.activities.length - 1; i >= 0; i -= 1) {
      const activity = thread.activities[i];
      if (!activity || activity.kind !== "context-window.updated") {
        continue;
      }
      const payload = asRecord(activity.payload);
      const rawPercent = asFiniteNumber(payload?.usedPercent);
      const usedTokens = asFiniteNumber(payload?.usedTokens);
      const maxTokens = asFiniteNumber(payload?.maxTokens);
      compactsAutomatically = asBoolean(payload?.compactsAutomatically) ?? false;
      if (rawPercent !== null) {
        usedPercent = Math.max(0, Math.min(100, rawPercent));
        break;
      }
      if (usedTokens !== null && maxTokens !== null && maxTokens > 0) {
        usedPercent = Math.min(100, (usedTokens / maxTokens) * 100);
        break;
      }
      // No usable data in this activity — keep scanning backwards.
    }

    if (usedPercent === null) {
      return;
    }

    // The activity payload's compactsAutomatically flag is the per-session truth
    // (set by the provider runtime). If it says the provider auto-compacts, skip
    // even if the static map says otherwise — the runtime knows best.
    if (compactsAutomatically) {
      return;
    }

    // Loop-active threads use a lower threshold (context grows predictably).
    // Goals and normal threads use the general threshold. The loop field is
    // added when LoopReactor lands; until then, all threads use the general
    // threshold. The loopCompactionThreshold setting is already in the schema
    // so LoopReactor can opt in without a migration.
    const threshold = settings.autoCompactionThreshold;

    if (usedPercent < threshold) {
      return;
    }

    // Cooldown prevents rapid re-compaction. Emergency bypass at 90% ignores
    // cooldown — without this, a fast-filling loop could hit the hard context
    // limit during the cooldown window.
    const now = Date.now();
    const lastCompacted = lastCompactedAt.get(threadId);
    if (
      lastCompacted !== undefined &&
      usedPercent < EMERGENCY_THRESHOLD &&
      now - lastCompacted < settings.autoCompactionCooldownSeconds * 1000
    ) {
      return;
    }

    // Per-thread lock: prevent double-compaction from concurrent events.
    if (compactingThreads.has(threadId)) {
      return;
    }
    compactingThreads.add(threadId);

    yield* providerService.compactThread({ threadId }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          compactingThreads.delete(threadId);
          lastCompactedAt.set(threadId, Date.now());
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("auto-compaction failed", {
          threadId,
          usedPercent,
          threshold,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const handleActivitySafely = (threadId: ThreadId) =>
    handleActivity(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("compaction reactor failed to process thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(handleActivitySafely);

  const start: CompactionReactorShape["start"] = Effect.fn(function* () {
    // Wrap the stream consumer in Effect.retry so a stream-level failure doesn't
    // permanently kill the reactor. Same pattern as GoalContinuationReactor.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        // Filter on activity kind FIRST (cheapest) — avoids snapshot reads on
        // tool calls, messages, compactions, etc. that all fire activity-appended.
        if (event.type !== "thread.activity-appended") {
          return Effect.void;
        }
        if (event.payload.activity.kind !== "context-window.updated") {
          return Effect.void;
        }
        return worker.enqueue(event.payload.threadId);
      }).pipe(Effect.retry(Schedule.spaced(Duration.seconds(1)))),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CompactionReactorShape;
});

export const CompactionReactorLive = Layer.effect(CompactionReactor, make);
