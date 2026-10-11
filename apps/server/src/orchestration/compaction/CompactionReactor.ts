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
import * as Crypto from "node:crypto";

import {
  EventId,
  ProviderDiscoveryKind,
  THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND,
  ThreadId,
  type CommandId as CommandIdType,
  type CompactionOperationSummary,
  type ProviderInstanceId,
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

import {
  ProviderCompactionPersistenceError,
  ProviderValidationError,
  type ProviderServiceError,
} from "../../provider/Errors.ts";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
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
const SETTLED_RESULTS_CAPACITY = 256;

// Canonical fingerprint of the operation-defining request payload so a reused
// requestId cannot silently join or replay a different operation.
function fingerprintCompactionRequest(input: ProviderCompactionRequest): string {
  const canonical = JSON.stringify({
    threadId: input.threadId,
    trigger: input.trigger,
    instructions: input.instructions ?? null,
    expectedLifecycleGeneration: input.expectedLifecycleGeneration ?? null,
  });
  return Crypto.createHash("sha256").update(canonical).digest("hex");
}

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
  readonly ready: Deferred.Deferred<void, ProviderServiceError>;
}

interface InFlightEntry {
  readonly fingerprint: string;
  readonly deferred: Deferred.Deferred<ProviderCompactionResult, ProviderServiceError>;
}

interface SettledEntry {
  readonly fingerprint: string;
  readonly result: ProviderCompactionResult;
}

function failValidation(issue: string): Effect.Effect<never, ProviderValidationError> {
  return Effect.fail(
    new ProviderValidationError({ operation: "CompactionReactor.request", issue }),
  );
}

function outcomeKnownForError(error: ProviderServiceError): boolean {
  switch (error._tag) {
    case "ProviderCompactionPersistenceError":
      return error.outcomeKnown;
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
  const providerAutoEnabled = new Map<string, boolean>();
  const lastCompactions = new Map<string, CompactionOperationSummary>();
  const pendingWaiters = new Map<string, PendingWaiter>();
  const admittedThreads = new Set<string>();
  const nativePasses = new Map<string, { requestId: string; event: ProviderRuntimeEvent }>();
  const lastAutoCompactionAt = new Map<string, number>();
  const autoFailureCounts = new Map<string, number>();
  const autoInFlight = new Set<string>();
  let autoScope: Scope.Closeable | null = null;
  const inFlight = new Map<string, InFlightEntry>();
  const settledResults = new Map<string, SettledEntry>();

  const getState = (threadId: string): CompactionControlState =>
    states.get(threadId) ?? IDLE_COMPACTION_STATE;

  const lookupSession = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map((threadOption) => Option.getOrUndefined(threadOption)?.session ?? null),
      Effect.catch(() => Effect.succeed(null)),
    );

  const lookupCapabilities = (
    session: {
      readonly providerName: string | null;
      readonly providerInstanceId?: ProviderInstanceId;
    } | null,
  ) => {
    if (!session || !isProviderDiscoveryKind(session.providerName)) return Effect.succeed(null);
    return providerDiscoveryService
      .getComposerCapabilities({
        provider: session.providerName,
        ...(session.providerInstanceId !== undefined
          ? { instanceId: session.providerInstanceId }
          : {}),
      })
      .pipe(
        Effect.map((result) => result.compaction ?? null),
        Effect.catch(() => Effect.succeed(null)),
      );
  };

  const buildRuntimeStatus = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = yield* lookupSession(threadId);
      const capabilities = yield* lookupCapabilities(session);
      return deriveThreadCompactionRuntimeStatus({
        provider: session?.providerName ?? null,
        capabilities,
        providerAutoEnabled: providerAutoEnabled.get(threadId),
        nativeTrigger: providerService.getNativeCompactionTrigger
          ? yield* providerService
              .getNativeCompactionTrigger(threadId)
              .pipe(Effect.orElseSucceed(() => undefined))
          : undefined,
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
    result?: ProviderCompactionResult,
  ) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const base = {
        threadId,
        requestFingerprint:
          "requestId" in event.payload
            ? (inFlight.get(event.payload.requestId)?.fingerprint ?? null)
            : null,
        result: result ?? null,
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
            trigger:
              previous.status === "running" || previous.status === "pending"
                ? previous.trigger
                : "manual",
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
            trigger:
              previous.status === "running" || previous.status === "pending"
                ? previous.trigger
                : "manual",
            failureKind: event.payload.failureKind,
            beforeUsage: previous.status === "running" ? (previous.beforeUsage ?? null) : null,
            startedAt: previous.status === "running" ? previous.startedAt : null,
            requestedAt: previous.status === "pending" ? previous.requestedAt : null,
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
        yield* operations.upsert(row);
      }
      return row;
    });

  const applyEvent = (
    threadId: ThreadId,
    event: CompactionLifecycleInput,
    result?: ProviderCompactionResult,
  ): Effect.Effect<CompactionControlState, PersistenceSqlError> =>
    Effect.gen(function* () {
      const previous = getState(threadId);
      const next = compactionReducer(previous, event);
      if (next === previous) return previous;
      // Persist before committing the in-memory transition so a failed
      // durable write leaves the previous control state observable.
      const row = yield* persistOperation(threadId, next, event, previous, result);
      states.set(threadId, next);
      const summary = row === null ? null : compactionSummaryFromOperation(row);
      if (summary !== null) {
        lastCompactions.set(threadId, summary);
      }
      yield* publishStatus(threadId, next);
      return next;
    });

  // In-memory-only transition used when the durable write itself is the
  // failure: the control state must still reflect the outcome even though no
  // row could be persisted.
  const applyEventInMemory = (threadId: ThreadId, event: CompactionLifecycleInput) =>
    Effect.gen(function* () {
      const next = compactionReducer(getState(threadId), event);
      states.set(threadId, next);
      yield* publishStatus(threadId, next);
      return next;
    });

  const applyEventBestEffort = (threadId: ThreadId, event: CompactionLifecycleInput) =>
    applyEvent(threadId, event).pipe(
      Effect.catch((error) =>
        Effect.logWarning("compaction operation persistence failed", {
          threadId,
          detail: error.detail,
        }).pipe(Effect.as(getState(threadId))),
      ),
    );

  const settle = (
    requestId: string,
    fingerprint: string,
    exit:
      | { readonly _tag: "success"; readonly result: ProviderCompactionResult }
      | { readonly _tag: "failure"; readonly error: ProviderServiceError },
  ) =>
    Effect.gen(function* () {
      const entry = inFlight.get(requestId);
      inFlight.delete(requestId);
      if (exit._tag === "success") {
        settledResults.set(requestId, { fingerprint, result: exit.result });
        // Bound the settled-result memory: evict the oldest entries once the
        // capacity is exceeded so the map cannot grow for the server lifetime.
        while (settledResults.size > SETTLED_RESULTS_CAPACITY) {
          const oldest = settledResults.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          settledResults.delete(oldest);
        }
        if (entry !== undefined) {
          yield* Deferred.succeed(entry.deferred, exit.result);
        }
      } else if (entry !== undefined) {
        yield* Deferred.fail(entry.deferred, exit.error);
      }
    });

  const runOperation = (
    input: ProviderCompactionRequest,
  ): Effect.Effect<ProviderCompactionResult, ProviderServiceError> =>
    Effect.gen(function* () {
      const fingerprint = fingerprintCompactionRequest(input);
      const beforeUsage = latestUsage.get(input.threadId);
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();
      // Persist the running state before the provider call so a crash between
      // the two is visible to startup reconciliation. A failed durable write
      // must abort the operation: the provider effect is irreversible, so it
      // may only execute after the running row is durable.
      const startPersist = yield* applyEvent(input.threadId, {
        type: "thread.compaction-started",
        payload: {
          requestId: input.requestId,
          owner: "synara",
          trigger: input.trigger,
          ...(beforeUsage !== undefined ? { beforeUsage } : {}),
          createdAt: startedAt,
        },
      }).pipe(
        Effect.map(() => ({ _tag: "ok" as const })),
        Effect.catch((error) => Effect.succeed({ _tag: "err" as const, error })),
      );
      if (startPersist._tag === "err") {
        const persistError = new ProviderCompactionPersistenceError({
          operation: "CompactionReactor.start",
          detail: startPersist.error.message,
          outcomeKnown: true,
          cause: startPersist.error,
        });
        yield* applyEventInMemory(input.threadId, {
          type: "thread.compaction-failed",
          payload: {
            requestId: input.requestId,
            outcomeKnown: true,
            retryable: true,
            failureKind: "persistence-failure",
            detail: persistError.detail,
            createdAt: new Date().toISOString(),
          },
        });
        yield* settle(input.requestId, fingerprint, { _tag: "failure", error: persistError });
        return yield* Effect.fail(persistError);
      }
      latestUsage.delete(input.threadId);
      const outcome = yield* providerService.compactThread(input).pipe(
        Effect.map((result) => ({ _tag: "ok" as const, result })),
        Effect.catch((error) => Effect.succeed({ _tag: "err" as const, error })),
      );
      if (outcome._tag === "ok") {
        const afterUsage = latestUsage.get(input.threadId);
        const completePersist = yield* applyEvent(
          input.threadId,
          {
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
          },
          outcome.result,
        ).pipe(
          Effect.map(() => ({ _tag: "ok" as const })),
          Effect.catch((error) => Effect.succeed({ _tag: "err" as const, error })),
        );
        if (completePersist._tag === "err") {
          // The provider compacted but the completed row could not be made
          // durable; the operation must surface as uncertain, never as a
          // clean completion.
          const persistError = new ProviderCompactionPersistenceError({
            operation: "CompactionReactor.complete",
            detail: completePersist.error.message,
            outcomeKnown: false,
            cause: completePersist.error,
          });
          yield* applyEventInMemory(input.threadId, {
            type: "thread.compaction-failed",
            payload: {
              requestId: input.requestId,
              outcomeKnown: false,
              retryable: false,
              failureKind: "persistence-failure",
              detail: persistError.detail,
              createdAt: new Date().toISOString(),
            },
          });
          yield* settle(input.requestId, fingerprint, { _tag: "failure", error: persistError });
          return yield* Effect.fail(persistError);
        }
        yield* settle(input.requestId, fingerprint, { _tag: "success", result: outcome.result });
        return outcome.result;
      }
      const error = outcome.error;
      const outcomeKnown = outcomeKnownForError(error);
      const failPersist = yield* applyEvent(input.threadId, {
        type: "thread.compaction-failed",
        payload: {
          requestId: input.requestId,
          outcomeKnown,
          retryable: outcomeKnown,
          failureKind: error._tag,
          detail: error.message,
          createdAt: new Date().toISOString(),
        },
      }).pipe(
        Effect.map(() => ({ _tag: "ok" as const })),
        Effect.catch((persistError) => Effect.succeed({ _tag: "err" as const, persistError })),
      );
      if (failPersist._tag === "err") {
        // The failed row could not be made durable; hold the thread in an
        // explicit uncertain state so restart reconciliation and operators
        // can see the unresolved operation.
        yield* Effect.logWarning("compaction terminal persistence failed", {
          threadId: input.threadId,
          detail: failPersist.persistError.detail,
        });
        yield* applyEventInMemory(input.threadId, {
          type: "thread.compaction-failed",
          payload: {
            requestId: input.requestId,
            outcomeKnown: false,
            retryable: false,
            failureKind: "persistence-failure",
            detail: failPersist.persistError.message,
            createdAt: new Date().toISOString(),
          },
        });
      }
      yield* settle(input.requestId, fingerprint, { _tag: "failure", error });
      return yield* Effect.fail(error);
    });

  const validate = (input: ProviderCompactionRequest) =>
    Effect.gen(function* () {
      if (
        input.trigger === "synara-auto" &&
        autoOptionsFromSettings(settings.get(input.threadId)) === null
      ) {
        return yield* failValidation("Automatic compaction was disabled before the request began.");
      }
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
        .getComposerCapabilities({
          provider: session.providerName,
          ...(session.providerInstanceId !== undefined
            ? { instanceId: session.providerInstanceId }
            : {}),
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const manualMode = capabilities?.compaction?.manual.mode;
      if (manualMode !== "same-session" && manualMode !== "session-rollover") {
        return yield* failValidation(
          `Provider '${session.providerName}' does not support manual compaction.`,
        );
      }
      if (input.expectedLifecycleGeneration !== undefined) {
        // Fail closed: the request is explicitly guarding against a stale
        // provider lifecycle, so an unreadable or absent authoritative
        // generation is a refusal, not permission to compact.
        const runtime = yield* sessionRuntimeRepository
          .getByThreadId({ threadId: input.threadId })
          .pipe(
            Effect.mapError(
              (error) =>
                new ProviderValidationError({
                  operation: "CompactionReactor.request",
                  issue: `Could not verify the lifecycle generation for thread '${input.threadId}': ${error.message}`,
                  cause: error,
                }),
            ),
          );
        const currentGeneration = Option.getOrUndefined(runtime)?.lifecycleGeneration;
        if (currentGeneration === undefined) {
          return yield* failValidation(
            `No authoritative lifecycle generation is recorded for thread '${input.threadId}'.`,
          );
        }
        if (currentGeneration !== input.expectedLifecycleGeneration) {
          return yield* failValidation(
            `Stale lifecycle generation for thread '${input.threadId}'.`,
          );
        }
      }
      return session;
    });

  const request: CompactionReactorShape["request"] = (input) =>
    Effect.gen(function* () {
      // Dedupe by requestId: a repeated request joins the existing operation,
      // but only when its payload fingerprint matches the original request.
      const fingerprint = fingerprintCompactionRequest(input);
      const settled = settledResults.get(input.requestId);
      if (settled !== undefined) {
        if (settled.fingerprint !== fingerprint) {
          return yield* failValidation(
            `Request id '${input.requestId}' was already used for a different compaction request.`,
          );
        }
        return settled.result;
      }
      const existing = inFlight.get(input.requestId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          return yield* failValidation(
            `Request id '${input.requestId}' is already in flight for a different compaction request.`,
          );
        }
        return yield* Deferred.await(existing.deferred);
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
      if (admittedThreads.has(input.threadId)) {
        return yield* failValidation(
          `A compaction request is already being admitted for thread '${input.threadId}'.`,
        );
      }
      const deferred = Deferred.makeUnsafe<ProviderCompactionResult, ProviderServiceError>();
      admittedThreads.add(input.threadId);
      inFlight.set(input.requestId, { fingerprint, deferred });
      return yield* Effect.gen(function* () {
        const persisted = Option.getOrUndefined(
          yield* operations.getByRequestId(input.requestId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderCompactionPersistenceError({
                  operation: "CompactionReactor.request",
                  detail: cause.message,
                  outcomeKnown: true,
                  cause,
                }),
            ),
          ),
        );
        if (persisted !== undefined) {
          if (persisted.requestFingerprint !== fingerprint) {
            return yield* failValidation(
              `Request id '${input.requestId}' was already used for a different compaction request.`,
            );
          }
          if (persisted.status === "completed" && persisted.result != null) {
            yield* settle(input.requestId, fingerprint, {
              _tag: "success",
              result: persisted.result,
            });
            return persisted.result;
          }
          return yield* failValidation(
            `Request id '${input.requestId}' has a durable ${persisted.status} outcome; use a new request only after reviewing the operation.`,
          );
        }
        const session = yield* validate(input);
        if (session.activeTurnId != null) {
          const ready = Deferred.makeUnsafe<void, ProviderServiceError>();
          pendingWaiters.set(input.threadId, { request: input, ready });
          // Defer behind the active turn; the turn-completion runtime event
          // promotes the pending request. The pending row must be durable
          // before the request may wait: an in-memory-only pending request
          // would silently disappear on restart.
          const pendingPersist = yield* applyEvent(input.threadId, {
            type: "thread.compaction-requested",
            payload: {
              requestId: input.requestId,
              trigger: input.trigger,
              ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
              createdAt: new Date().toISOString(),
            },
          }).pipe(
            Effect.map(() => ({ _tag: "ok" as const })),
            Effect.catch((error) => Effect.succeed({ _tag: "err" as const, error })),
          );
          if (pendingPersist._tag === "err") {
            const persistError = new ProviderCompactionPersistenceError({
              operation: "CompactionReactor.request",
              detail: pendingPersist.error.message,
              outcomeKnown: true,
              cause: pendingPersist.error,
            });
            yield* applyEventInMemory(input.threadId, {
              type: "thread.compaction-failed",
              payload: {
                requestId: input.requestId,
                outcomeKnown: true,
                retryable: true,
                failureKind: "persistence-failure",
                detail: persistError.detail,
                createdAt: new Date().toISOString(),
              },
            });
            yield* settle(input.requestId, fingerprint, { _tag: "failure", error: persistError });
            return yield* Effect.fail(persistError);
          }
          yield* Deferred.await(ready);
          yield* validate(input);
          return yield* runOperation(input);
        }
        return yield* runOperation(input);
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            admittedThreads.delete(input.threadId);
            pendingWaiters.delete(input.threadId);
            const entry = inFlight.get(input.requestId);
            if (entry === undefined || Exit.isSuccess(exit)) return;
            const current = getState(input.threadId);
            if (current.status === "pending" || current.status === "running") {
              yield* applyEventBestEffort(input.threadId, {
                type: "thread.compaction-failed",
                payload: {
                  requestId: input.requestId,
                  outcomeKnown: current.status === "pending",
                  retryable: current.status === "pending",
                  failureKind: "request-interrupted",
                  detail: "Compaction request ended before its result was confirmed.",
                  createdAt: new Date().toISOString(),
                },
              });
            }
            inFlight.delete(input.requestId);
            yield* Deferred.failCause(entry.deferred, exit.cause);
          }),
        ),
      );
    });

  const suspendAutoCompaction = (threadId: ThreadId, reason: string, detail?: string) =>
    Effect.gen(function* () {
      const disabled = { ...settings.get(threadId), autoEnabled: false };
      yield* operations.setSettings(threadId, disabled).pipe(Effect.orDie);
      settings.set(threadId, disabled);
      yield* applyEventBestEffort(threadId, {
        type: "thread.compaction-suspended",
        payload: {
          reason,
          ...(detail !== undefined ? { detail } : {}),
          createdAt: new Date().toISOString(),
        },
      });
    });

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
      if (autoOptionsFromSettings(settings.get(threadId)) === null) return;
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
      const session = yield* lookupSession(threadId);
      const capability = yield* lookupCapabilities(session);
      if (capability === null) return;
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
      yield* Deferred.succeed(waiter.ready, undefined);
    });

  const handleProviderNativeStarted = (event: ProviderRuntimeEvent, requestId: string) =>
    Effect.gen(function* () {
      const state = getState(event.threadId);
      if (
        state.status === "running" ||
        state.status === "pending" ||
        admittedThreads.has(event.threadId)
      ) {
        return;
      }
      nativePasses.set(event.threadId, { requestId, event });
      const beforeUsage = latestUsage.get(event.threadId);
      latestUsage.delete(event.threadId);
      yield* applyEventBestEffort(event.threadId, {
        type: "thread.compaction-started",
        payload: {
          requestId,
          owner: "provider",
          trigger:
            event.type === "item.started"
              ? (event.payload.compactionTrigger ?? "provider-auto")
              : "provider-auto",
          ...(beforeUsage !== undefined ? { beforeUsage } : {}),
          createdAt: event.createdAt,
        },
      });
    });

  const handleProviderNativeCompleted = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const state = getState(event.threadId);
      const pass = nativePasses.get(event.threadId);
      if (
        state.status !== "running" ||
        state.owner !== "provider" ||
        pass === undefined ||
        pass.requestId !== state.requestId ||
        pass.event.provider !== event.provider ||
        pass.event.lifecycleGeneration !== event.lifecycleGeneration ||
        pass.event.providerInstanceId !== event.providerInstanceId ||
        (pass.event.itemId !== undefined &&
          event.itemId !== undefined &&
          pass.event.itemId !== event.itemId)
      ) {
        return;
      }
      nativePasses.delete(event.threadId);
      if (event.type !== "item.completed" || event.payload.status !== "completed") {
        yield* applyEventBestEffort(event.threadId, {
          type: "thread.compaction-failed",
          payload: {
            requestId: state.requestId,
            outcomeKnown: true,
            retryable: true,
            failureKind: "provider-compaction-failed",
            detail:
              event.type === "item.completed"
                ? (event.payload.detail ?? "Provider compaction failed or was cancelled.")
                : "Provider compaction was interrupted.",
            createdAt: event.createdAt,
          },
        });
        return;
      }
      const afterUsage = latestUsage.get(event.threadId);
      yield* applyEventBestEffort(event.threadId, {
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
      if (event.payload.usage.compactsAutomatically !== undefined)
        providerAutoEnabled.set(event.threadId, event.payload.usage.compactsAutomatically);
      yield* maybeAutoCompact(event.threadId);
      return;
    }
    if (event.type === "session.exited" || event.type === "turn.aborted") {
      if (event.type === "session.exited") {
        latestUsage.delete(event.threadId);
        providerAutoEnabled.delete(event.threadId);
      }
      yield* handleProviderNativeCompleted(event);
      const pending = pendingWaiters.get(event.threadId);
      if (pending)
        yield* Deferred.fail(
          pending.ready,
          new ProviderValidationError({
            operation: "CompactionReactor.request",
            issue: "The provider session or active turn was interrupted before compaction began.",
          }),
        );
      return;
    }
    if (event.type === "turn.completed") {
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
    for (const entry of yield* operations.listSettings())
      settings.set(entry.threadId, entry.settings);
    // Hydrate lastCompaction from settled durable rows so the first status
    // emission after a restart carries the previous pass.
    const settled = yield* operations.listSettled();
    for (const operation of settled) {
      const summary = compactionSummaryFromOperation(operation);
      if (summary !== null) {
        lastCompactions.set(operation.threadId, summary);
        states.set(
          operation.threadId,
          operation.status === "uncertain"
            ? {
                status: "uncertain",
                requestId: operation.requestId,
                detail: operation.detail ?? "The previous provider outcome remains unknown.",
                since: operation.updatedAt,
              }
            : IDLE_COMPACTION_STATE,
        );
        if (operation.trigger === "synara-auto" && operation.status === "completed") {
          const completedAt = Date.parse(operation.completedAt ?? operation.updatedAt);
          if (Number.isFinite(completedAt))
            lastAutoCompactionAt.set(operation.threadId, completedAt);
        }
      }
    }
    const unsettled = yield* operations.listUnsettled();
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
      yield* applyEventBestEffort(threadId, {
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
      yield* reconcile.pipe(Effect.orDie);
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => {
          switch (event.type) {
            case "session.exited":
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
    Effect.gen(function* () {
      yield* operations.setSettings(input.threadId, input.settings).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderCompactionPersistenceError({
              operation: "CompactionReactor.setThreadSettings",
              detail: cause.message,
              outcomeKnown: true,
              cause,
            }),
        ),
      );
      settings.set(input.threadId, input.settings);
      const pending = pendingWaiters.get(input.threadId);
      if (!input.settings.autoEnabled && pending?.request.trigger === "synara-auto") {
        yield* Deferred.fail(
          pending.ready,
          new ProviderValidationError({
            operation: "CompactionReactor.request",
            issue: "Automatic compaction was disabled before the request began.",
          }),
        );
      }
      // Re-applying settings is the manual resume action: it clears an
      // auto-compaction suspension and resets the failure streak.
      autoFailureCounts.delete(input.threadId);
      const state = getState(input.threadId);
      if (state.status === "suspended") {
        states.set(input.threadId, IDLE_COMPACTION_STATE);
      }
      yield* publishStatus(input.threadId, getState(input.threadId));
    });

  return {
    start,
    drain: worker.drain,
    request,
    getControlState,
    setThreadSettings,
  } satisfies CompactionReactorShape;
});

/** Reactor layer without its repository dependencies, for tests that inject failing repositories. */
export const CompactionReactorBase = Layer.effect(CompactionReactor, make);

export const CompactionReactorLive = CompactionReactorBase.pipe(
  Layer.provide(ThreadCompactionOperationRepositoryLive),
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);
