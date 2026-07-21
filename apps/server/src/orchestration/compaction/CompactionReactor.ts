/**
 * CompactionReactor - Durable, event-driven compaction lifecycle orchestration.
 *
 * Admits manual and synara-auto compaction requests, observes provider-native
 * compaction from the runtime event stream, persists every transition before
 * acting, and reconciles interrupted operations once at startup. Uncertain
 * outcomes are never retried automatically.
 *
 * @module CompactionReactor
 */
import {
  EventId,
  ProviderDiscoveryKind,
  THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND,
  ThreadId,
  type CommandId as CommandIdType,
  type CompactionOperationSummary,
  type ProviderCompactionCapabilities,
  type ProviderCompactionRequest,
  type ProviderCompactionResult,
  type ProviderRuntimeEvent,
  type ProviderSetCompactionSettingsInput,
  type RuntimeSessionState,
  type SynaraAutoCompactionOptions,
  type ThreadCompactionLifecycleEvent,
  type ThreadCompactionSettings,
  type ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { CommandId } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";

import { ProviderValidationError, type ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ThreadCompactionOperationRepositoryLive } from "../../persistence/Layers/ThreadCompactionOperations.ts";
import {
  ThreadCompactionOperationRepository,
  type ThreadCompactionOperation,
} from "../../persistence/Services/ThreadCompactionOperations.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { CompactionReactor, type CompactionReactorShape } from "../Services/CompactionReactor.ts";
import {
  IDLE_COMPACTION_STATE,
  compactionReducer,
  type CompactionControlState,
  type CompactionLifecycleInput,
} from "./compactionState.ts";
import {
  compactionSummaryFromOperation,
  deriveThreadCompactionRuntimeStatus,
} from "./compactionRuntimeStatus.ts";
import { decideAutoCompaction } from "./decideCompaction.ts";

const COMPACTION_REACTOR_CAPACITY = 256;
const AUTO_COMPACTION_MAX_CONSECUTIVE_FAILURES = 2;

// Resolve the per-thread settings into a decider policy. Threads without an
// evaluable trigger have no Synara-managed auto-compaction; there is no
// universal default threshold.
function autoOptionsFromSettings(
  settings: ThreadCompactionSettings | undefined,
): SynaraAutoCompactionOptions | null {
  if (settings === undefined || !settings.autoEnabled) {
    return null;
  }
  const trigger = settings.trigger;
  if (trigger === undefined || trigger.kind === "opaque") {
    return null;
  }
  return {
    enabled: true,
    trigger,
    ...(settings.cooldownSeconds !== undefined
      ? { cooldownMs: settings.cooldownSeconds * 1_000 }
      : {}),
  };
}

const isProviderDiscoveryKind = Schema.is(ProviderDiscoveryKind);

const serverCommandId = (tag: string): CommandIdType =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

interface PendingWaiter {
  readonly request: ProviderCompactionRequest;
  readonly deferred: Deferred.Deferred<ProviderCompactionResult, ProviderServiceError>;
}

function failValidation(issue: string): Effect.Effect<never, ProviderValidationError> {
  return Effect.fail(
    new ProviderValidationError({ operation: "CompactionReactor.request", issue }),
  );
}

function outcomeKnownForError(error: ProviderServiceError): boolean {
  switch (error._tag) {
    case "ProviderValidationError":
    case "ProviderUnsupportedError":
    case "ProviderSessionNotFoundError":
    case "ProviderAdapterValidationError":
    case "ProviderAdapterSessionNotFoundError":
      return true;
    default:
      return false;
  }
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const providerDiscoveryService = yield* ProviderDiscoveryService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const operations = yield* ThreadCompactionOperationRepository;
  const sessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;

  const states = new Map<string, CompactionControlState>();
  const settings = new Map<string, ThreadCompactionSettings>();
  const latestUsage = new Map<string, ThreadTokenUsageSnapshot>();
  const lastCompactions = new Map<string, CompactionOperationSummary>();
  const capabilitiesCache = new Map<string, ProviderCompactionCapabilities | null>();
  const pendingWaiters = new Map<string, PendingWaiter>();
  const lastAutoCompactionAt = new Map<string, number>();
  const autoFailureCounts = new Map<string, number>();
  const autoInFlight = new Set<string>();
  let autoScope: Scope.Closeable | null = null;
  const inFlight = new Map<
    string,
    Deferred.Deferred<ProviderCompactionResult, ProviderServiceError>
  >();
  const settledResults = new Map<string, ProviderCompactionResult>();

  const getState = (threadId: string): CompactionControlState =>
    states.get(threadId) ?? IDLE_COMPACTION_STATE;

  const lookupProviderName = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map((threadOption) => {
        const providerName = Option.getOrUndefined(threadOption)?.session?.providerName ?? null;
        return providerName !== null && isProviderDiscoveryKind(providerName) ? providerName : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  const lookupCapabilities = (provider: (typeof ProviderDiscoveryKind.Type & string) | null) =>
    Effect.gen(function* () {
      if (provider === null) {
        return null;
      }
      const cached = capabilitiesCache.get(provider);
      if (cached !== undefined) {
        return cached;
      }
      const capabilities = yield* providerDiscoveryService
        .getComposerCapabilities({ provider })
        .pipe(
          Effect.map((result) => result.compaction),
          Effect.catch(() => Effect.succeed(null)),
        );
      if (capabilities !== null) {
        capabilitiesCache.set(provider, capabilities);
      }
      return capabilities;
    });

  const buildRuntimeStatus = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const provider = yield* lookupProviderName(threadId);
      const capabilities = yield* lookupCapabilities(provider);
      return deriveThreadCompactionRuntimeStatus({
        provider,
        capabilities,
        contextWindowMaxTokens: latestUsage.get(threadId)?.maxTokens ?? null,
        lastCompaction: lastCompactions.get(threadId),
        settings: settings.get(threadId),
        controlState: getState(threadId),
      });
    });

  const publishStatus = (threadId: ThreadId, state: CompactionControlState) =>
    buildRuntimeStatus(threadId).pipe(
      Effect.flatMap((status) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("compaction-status"),
          threadId,
          activity: {
            id: EventId.makeUnsafe(crypto.randomUUID()),
            tone: state.status === "uncertain" || state.status === "suspended" ? "error" : "info",
            kind: THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND,
            summary: `Compaction ${state.status}`,
            payload: JSON.parse(JSON.stringify(status)),
            turnId: null,
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      ),
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    );

  const persistOperation = (
    threadId: string,
    state: CompactionControlState,
    event: CompactionLifecycleInput,
    previous: CompactionControlState,
  ) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const base = {
        threadId,
        sessionEffect: null,
        failureKind: null,
        detail: null,
        retryable: null,
        outcomeKnown: null,
        beforeUsage: null,
        afterUsage: null,
        requestedAt: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      };
      let row: ThreadCompactionOperation | null = null;
      switch (event.type) {
        case "thread.compaction-requested":
          if (state.status === "pending") {
            row = {
              ...base,
              requestId: state.requestId,
              status: "pending",
              owner: "synara",
              trigger: state.trigger,
              requestedAt: state.requestedAt,
            };
          }
          break;
        case "thread.compaction-started":
          if (state.status === "running") {
            row = {
              ...base,
              requestId: state.requestId,
              status: "running",
              owner: state.owner,
              trigger: state.trigger,
              beforeUsage: state.beforeUsage ?? null,
              startedAt: state.startedAt,
            };
          }
          break;
        case "thread.compaction-completed":
          row = {
            ...base,
            requestId: event.payload.requestId,
            status: "completed",
            owner: previous.status === "running" ? previous.owner : "synara",
            trigger: previous.status === "running" ? previous.trigger : "manual",
            sessionEffect: event.payload.sessionEffect,
            beforeUsage: event.payload.beforeUsage ?? null,
            afterUsage: event.payload.afterUsage ?? null,
            startedAt: previous.status === "running" ? previous.startedAt : null,
            completedAt: event.payload.createdAt,
          };
          break;
        case "thread.compaction-failed":
          row = {
            ...base,
            requestId: event.payload.requestId,
            status: event.payload.outcomeKnown ? "failed" : "uncertain",
            owner: previous.status === "running" ? previous.owner : "synara",
            trigger: previous.status === "running" ? previous.trigger : "manual",
            failureKind: event.payload.failureKind,
            detail: event.payload.detail ?? null,
            retryable: event.payload.retryable,
            outcomeKnown: event.payload.outcomeKnown,
            completedAt: event.payload.createdAt,
          };
          break;
        case "thread.compaction-suspended":
          break;
      }
      if (row !== null) {
        yield* operations.upsert(row).pipe(
          Effect.catch((error) =>
            Effect.logWarning("compaction operation persistence failed", {
              threadId,
              detail: error.detail,
            }),
          ),
        );
      }
      return row;
    });

  const applyEvent = (threadId: ThreadId, event: CompactionLifecycleInput) =>
    Effect.gen(function* () {
      const previous = getState(threadId);
      const next = compactionReducer(previous, event);
      states.set(threadId, next);
      const row = yield* persistOperation(threadId, next, event, previous);
      const summary = row === null ? null : compactionSummaryFromOperation(row);
      if (summary !== null) {
        lastCompactions.set(threadId, summary);
      }
      yield* publishStatus(threadId, next);
      return next;
    });

  const settle = (
    requestId: string,
    exit:
      | { readonly _tag: "success"; readonly result: ProviderCompactionResult }
      | { readonly _tag: "failure"; readonly error: ProviderServiceError },
  ) =>
    Effect.gen(function* () {
      const deferred = inFlight.get(requestId);
      inFlight.delete(requestId);
      if (exit._tag === "success") {
        settledResults.set(requestId, exit.result);
        if (deferred !== undefined) {
          yield* Deferred.succeed(deferred, exit.result);
        }
      } else if (deferred !== undefined) {
        yield* Deferred.fail(deferred, exit.error);
      }
    });

  const runOperation = (
    input: ProviderCompactionRequest,
  ): Effect.Effect<ProviderCompactionResult, ProviderServiceError> =>
    Effect.gen(function* () {
      const beforeUsage = latestUsage.get(input.threadId);
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();
      // Persist the running state before the provider call so a crash between
      // the two is visible to startup reconciliation.
      yield* applyEvent(input.threadId, {
        type: "thread.compaction-started",
        payload: {
          requestId: input.requestId,
          owner: "synara",
          trigger: input.trigger,
          ...(beforeUsage !== undefined ? { beforeUsage } : {}),
          createdAt: startedAt,
        },
      });
      const outcome = yield* providerService.compactThread(input).pipe(
        Effect.map((result) => ({ _tag: "ok" as const, result })),
        Effect.catch((error) => Effect.succeed({ _tag: "err" as const, error })),
      );
      if (outcome._tag === "ok") {
        const afterUsage = latestUsage.get(input.threadId);
        yield* applyEvent(input.threadId, {
          type: "thread.compaction-completed",
          payload: {
            requestId: input.requestId,
            sessionEffect:
              outcome.result.kind === "runtime-restart-required"
                ? "runtime-restart"
                : outcome.result.kind,
            ...(beforeUsage !== undefined ? { beforeUsage } : {}),
            ...(afterUsage !== undefined ? { afterUsage } : {}),
            durationMs: Math.max(0, Date.now() - startedAtMs),
            createdAt: new Date().toISOString(),
          },
        });
        yield* settle(input.requestId, { _tag: "success", result: outcome.result });
        return outcome.result;
      }
      const error = outcome.error;
      const outcomeKnown = outcomeKnownForError(error);
      yield* applyEvent(input.threadId, {
        type: "thread.compaction-failed",
        payload: {
          requestId: input.requestId,
          outcomeKnown,
          retryable: outcomeKnown,
          failureKind: error._tag,
          detail: error.message,
          createdAt: new Date().toISOString(),
        },
      });
      yield* settle(input.requestId, { _tag: "failure", error });
      return yield* Effect.fail(error);
    });

  const validate = (input: ProviderCompactionRequest) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const thread = Option.getOrUndefined(threadOption);
      const session = thread?.session ?? null;
      if (session === null || session.providerName === null) {
        return yield* failValidation(`No provider session is bound to thread '${input.threadId}'.`);
      }
      if (!isProviderDiscoveryKind(session.providerName)) {
        return yield* failValidation(
          `Context compaction is unavailable for provider '${session.providerName}'.`,
        );
      }
      const capabilities = yield* providerDiscoveryService
        .getComposerCapabilities({ provider: session.providerName })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (capabilities !== null && capabilities.compaction.manual.mode === "unsupported") {
        return yield* failValidation(
          `Provider '${session.providerName}' does not support manual compaction.`,
        );
      }
      if (input.expectedLifecycleGeneration !== undefined) {
        const runtime = yield* sessionRuntimeRepository
          .getByThreadId({ threadId: input.threadId })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        const currentGeneration = Option.getOrUndefined(runtime)?.lifecycleGeneration;
        if (
          currentGeneration !== undefined &&
          currentGeneration !== input.expectedLifecycleGeneration
        ) {
          return yield* failValidation(
            `Stale lifecycle generation for thread '${input.threadId}'.`,
          );
        }
      }
      return session;
    });

  const request: CompactionReactorShape["request"] = (input) =>
    Effect.gen(function* () {
      // Dedupe by requestId: a repeated request joins the existing operation.
      const settled = settledResults.get(input.requestId);
      if (settled !== undefined) {
        return settled;
      }
      const existing = inFlight.get(input.requestId);
      if (existing !== undefined) {
        return yield* Deferred.await(existing);
      }
      const state = getState(input.threadId);
      if (state.status === "suspended") {
        return yield* failValidation(
          `Compaction is suspended for thread '${input.threadId}': ${state.reason}.`,
        );
      }
      if (state.status === "running" || state.status === "pending") {
        return yield* failValidation(
          `A compaction operation is already ${state.status} for thread '${input.threadId}'.`,
        );
      }
      const session = yield* validate(input);
      const deferred = yield* Deferred.make<ProviderCompactionResult, ProviderServiceError>();
      inFlight.set(input.requestId, deferred);
      if (session.activeTurnId !== null) {
        // Defer behind the active turn; the turn-completion runtime event
        // promotes the pending request.
        yield* applyEvent(input.threadId, {
          type: "thread.compaction-requested",
          payload: {
            requestId: input.requestId,
            trigger: input.trigger,
            ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
            createdAt: new Date().toISOString(),
          },
        });
        pendingWaiters.set(input.threadId, { request: input, deferred });
        return yield* Deferred.await(deferred);
      }
      return yield* runOperation(input);
    });

  const suspendAutoCompaction = (threadId: ThreadId, reason: string, detail?: string) =>
    applyEvent(threadId, {
      type: "thread.compaction-suspended",
      payload: {
        reason,
        ...(detail !== undefined ? { detail } : {}),
        createdAt: new Date().toISOString(),
      },
    }).pipe(Effect.asVoid);

  const runAutoCompaction = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const requestId = `synara-auto:${crypto.randomUUID()}`;
      const outcome = yield* request({ requestId, threadId, trigger: "synara-auto" }).pipe(
        Effect.map((result) => ({ _tag: "ok" as const, result })),
        Effect.catch((error) => Effect.succeed({ _tag: "err" as const, error })),
      );
      if (outcome._tag === "ok") {
        autoFailureCounts.delete(threadId);
        lastAutoCompactionAt.set(threadId, Date.now());
        return;
      }
      const error = outcome.error;
      if (
        error._tag === "ProviderValidationError" ||
        error._tag === "ProviderUnsupportedError" ||
        error._tag === "ProviderAdapterValidationError"
      ) {
        yield* suspendAutoCompaction(threadId, "provider-state-uncertain", error.message);
        return;
      }
      const failures = (autoFailureCounts.get(threadId) ?? 0) + 1;
      autoFailureCounts.set(threadId, failures);
      if (failures >= AUTO_COMPACTION_MAX_CONSECUTIVE_FAILURES) {
        yield* suspendAutoCompaction(threadId, "repeated-failure", error.message);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => autoInFlight.delete(threadId))));

  const maybeAutoCompact = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const options = autoOptionsFromSettings(settings.get(threadId));
      const usage = latestUsage.get(threadId);
      if (options === null || usage === undefined || autoInFlight.has(threadId)) {
        return;
      }
      const provider = yield* lookupProviderName(threadId);
      const capability = yield* lookupCapabilities(provider);
      if (capability === null) {
        return;
      }
      const threadOption = yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const session = Option.getOrUndefined(threadOption)?.session ?? null;
      if (session === null) {
        return;
      }
      const runtimeStatus = yield* buildRuntimeStatus(threadId);
      const decisionInput = {
        usage,
        options,
        capability,
        runtimeStatus,
        threadState: session.status as RuntimeSessionState,
        activeTurnId: session.activeTurnId ?? undefined,
        now: Date.now(),
      };
      const decision = decideAutoCompaction({
        ...decisionInput,
        lastAutoCompactionAt: lastAutoCompactionAt.get(threadId),
      });
      if (decision.action === "none" && decision.reason === "cooldown") {
        // Usage still exceeds the trigger inside the cooldown window right
        // after a Synara-triggered pass: the compaction is not reclaiming
        // enough context to make progress.
        const withoutCooldown = decideAutoCompaction({
          ...decisionInput,
          lastAutoCompactionAt: undefined,
        });
        if (withoutCooldown.action === "compact" || withoutCooldown.action === "pending") {
          yield* suspendAutoCompaction(
            threadId,
            "compaction-thrashing",
            "Context usage still exceeds the trigger immediately after an automatic compaction.",
          );
        }
        return;
      }
      const shouldRequest =
        decision.action === "compact" ||
        (decision.action === "pending" && decision.reason === "active-turn");
      if (!shouldRequest || autoScope === null) {
        return;
      }
      // Fork so a request deferred behind an active turn cannot block the
      // reactor worker that must process the turn-completion event.
      autoInFlight.add(threadId);
      yield* runAutoCompaction(threadId).pipe(Effect.forkIn(autoScope));
    });

  const promotePendingRequest = (threadId: string) =>
    Effect.gen(function* () {
      const waiter = pendingWaiters.get(threadId);
      if (waiter === undefined) {
        return;
      }
      pendingWaiters.delete(threadId);
      yield* runOperation(waiter.request).pipe(Effect.exit);
    });

  const handleProviderNativeStarted = (event: ProviderRuntimeEvent, requestId: string) =>
    Effect.gen(function* () {
      const state = getState(event.threadId);
      if (state.status === "running") {
        return;
      }
      const beforeUsage = latestUsage.get(event.threadId);
      yield* applyEvent(event.threadId, {
        type: "thread.compaction-started",
        payload: {
          requestId,
          owner: "provider",
          trigger: "provider-auto",
          ...(beforeUsage !== undefined ? { beforeUsage } : {}),
          createdAt: event.createdAt,
        },
      });
    });

  const handleProviderNativeCompleted = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const state = getState(event.threadId);
      if (state.status !== "running" || state.owner !== "provider") {
        return;
      }
      const afterUsage = latestUsage.get(event.threadId);
      yield* applyEvent(event.threadId, {
        type: "thread.compaction-completed",
        payload: {
          requestId: state.requestId,
          sessionEffect: "same-session",
          ...(state.beforeUsage !== undefined ? { beforeUsage: state.beforeUsage } : {}),
          ...(afterUsage !== undefined ? { afterUsage: afterUsage } : {}),
          createdAt: event.createdAt,
        },
      });
    });

  const processRuntimeEvent = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    if (event.type === "thread.token-usage.updated") {
      latestUsage.set(event.threadId, event.payload.usage);
      yield* maybeAutoCompact(event.threadId);
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      // Auto decisions deferred behind the turn already sit in pendingWaiters;
      // fresh evaluations wait for the next usage event so a stale pre-turn
      // snapshot cannot re-trigger a compaction that just ran.
      yield* promotePendingRequest(event.threadId);
      return;
    }
    if (event.type === "item.started" && event.payload.itemType === "context_compaction") {
      yield* handleProviderNativeStarted(event, `provider:${event.eventId}`);
      return;
    }
    if (event.type === "item.completed" && event.payload.itemType === "context_compaction") {
      yield* handleProviderNativeCompleted(event);
      return;
    }
  });

  const processRuntimeEventSafely = (event: ProviderRuntimeEvent) =>
    processRuntimeEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("compaction reactor failed to process runtime event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // One-shot startup reconciliation: classify persisted pending/running rows
  // instead of resuming them. Interrupted running operations may or may not
  // have compacted provider-side, so they settle as uncertain and are never
  // retried automatically; interrupted pending requests never reached the
  // provider and settle as retryable failures.
  const reconcile = Effect.gen(function* () {
    // Hydrate lastCompaction from settled durable rows so the first status
    // emission after a restart carries the previous pass.
    const settled = yield* operations
      .listSettled()
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ThreadCompactionOperation>)));
    for (const operation of settled) {
      const summary = compactionSummaryFromOperation(operation);
      if (summary !== null) {
        lastCompactions.set(operation.threadId, summary);
      }
    }
    const unsettled = yield* operations
      .listUnsettled()
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ThreadCompactionOperation>)));
    for (const operation of unsettled) {
      const threadId = ThreadId.makeUnsafe(operation.threadId);
      states.set(
        operation.threadId,
        operation.status === "pending"
          ? {
              status: "pending",
              requestId: operation.requestId,
              trigger: operation.trigger === "provider-auto" ? "synara-auto" : operation.trigger,
              reason: "startup-reconciliation",
              requestedAt: operation.requestedAt ?? operation.updatedAt,
            }
          : {
              status: "running",
              requestId: operation.requestId,
              owner: operation.owner,
              trigger: operation.trigger,
              startedAt: operation.startedAt ?? operation.updatedAt,
              ...(operation.beforeUsage !== null ? { beforeUsage: operation.beforeUsage } : {}),
            },
      );
      const outcomeKnown = operation.status === "pending";
      yield* applyEvent(threadId, {
        type: "thread.compaction-failed",
        payload: {
          requestId: operation.requestId,
          outcomeKnown,
          retryable: outcomeKnown,
          failureKind: "startup-reconciliation",
          detail: outcomeKnown
            ? "Pending compaction request was interrupted before it started."
            : "Compaction was running when the server stopped; the provider outcome is unknown.",
          createdAt: new Date().toISOString(),
        },
      });
    }
  });

  const worker = yield* makeDrainableWorker(processRuntimeEventSafely, {
    capacity: COMPACTION_REACTOR_CAPACITY,
  });

  const start: CompactionReactorShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      autoScope = scope;
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* reconcile;
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => {
          switch (event.type) {
            case "thread.token-usage.updated":
            case "turn.completed":
            case "turn.aborted":
            case "item.started":
            case "item.completed":
              return worker.enqueue(event).pipe(Effect.asVoid);
            default:
              return Effect.void;
          }
        }),
      );
    }),
  );

  const getControlState: CompactionReactorShape["getControlState"] = (threadId) =>
    Effect.sync(() => getState(threadId));

  const setThreadSettings: CompactionReactorShape["setThreadSettings"] = (
    input: ProviderSetCompactionSettingsInput,
  ) =>
    Effect.suspend(() => {
      settings.set(input.threadId, input.settings);
      // Re-applying settings is the manual resume action: it clears an
      // auto-compaction suspension and resets the failure streak.
      autoFailureCounts.delete(input.threadId);
      const state = getState(input.threadId);
      if (state.status === "suspended") {
        states.set(input.threadId, IDLE_COMPACTION_STATE);
      }
      return publishStatus(input.threadId, getState(input.threadId));
    });

  return {
    start,
    drain: worker.drain,
    request,
    getControlState,
    setThreadSettings,
  } satisfies CompactionReactorShape;
});

export const CompactionReactorLive = Layer.effect(CompactionReactor, make).pipe(
  Layer.provide(ThreadCompactionOperationRepositoryLive),
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);
