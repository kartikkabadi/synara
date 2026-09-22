// FILE: provider/Layers/DevinCloudAdapter.ts
// Purpose: Devin Cloud provider adapter. Sessions run on Devin's cloud VMs and
// are driven over the v3 REST API (create session → post messages → poll the
// message log). When the installed Devin CLI supports `devin acp --cloud`, the
// ACP transport takes over; REST remains the zero-config fallback that works
// with the `devin auth login` credential.
// Layer: Provider adapter runtime

import {
  type ChatAttachment,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PubSub,
  Random,
  Result,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@synara/shared/githubRepository";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { makeAcpThreadLock } from "../acp/AcpAdapterSessionSupport.ts";
import { stampAcpRuntimeEventLifecycleGeneration } from "../acp/AcpCoreRuntimeEvents.ts";
import { detectDevinAcpCloudSupport } from "../acp/DevinAcpSupport.ts";
import {
  DevinRestError,
  isDevinSessionId,
  makeDevinRestClient,
  resolveDevinCloudAuth,
  type DevinCloudAuth,
  type DevinCloudMessage,
  type DevinCloudSession,
  type DevinRestClient,
} from "../devinCloud/DevinRestClient.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import { DevinCloudAdapter, type DevinCloudAdapterShape } from "../Services/DevinCloudAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderAdapterShape,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";

const PROVIDER = "devinCloud" as const;

// Spawn failures that mean the CLI rejected the flag despite the help
// probe (partial rollout, arg ordering) — auto mode falls back to REST.
const ACP_USAGE_ERROR_PATTERN =
  /unexpected argument|unknown option|unrecognized|invalid flag|no such option|not supported|insiders/iu;

const describeAdapterError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return [record.issue, record.detail, record.message, record.errorMessage]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
  }
  return String(error);
};

const isAcpUsageError = (error: unknown) =>
  ACP_USAGE_ERROR_PATTERN.test(describeAdapterError(error));
const RESUME_VERSION = 1;

// Poll cadence: tight while a turn is open or the remote session reports work,
// relaxed while it idles waiting for input.
const POLL_ACTIVE_MS = 1_500;
const POLL_IDLE_MS = 15_000;
// A turn needs at least a little remote evidence before waiting-style status
// details may settle it — the first poll can still see the pre-send snapshot.
const MIN_TURN_POLL_MS = 4_000;
// status_detail values that mean Devin finished responding and parked.
const TURN_COMPLETING_STATUS_DETAILS = new Set(["waiting_for_user", "finished", "inactivity"]);
const SESSION_WORKING_STATUS_DETAILS = new Set(["working", "resuming"]);
// `resuming` shows up as a top-level status on some paths, so treat it as
// active work in either field.
const SESSION_ACTIVE_STATUSES = new Set(["running", "resuming"]);
const SESSION_TERMINAL_STATUSES = new Set(["exit", "suspended"]);

type DevinCloudSessionState = "starting" | "ready" | "running" | "waiting" | "stopped" | "error";

interface DevinCloudSessionContext {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string | undefined;
  readonly scope: Scope.Scope;
  session: ProviderSession;
  stopped: boolean;
  readonly client: DevinRestClient;
  readonly orgId: string;
  readonly devinSessionId: string;
  readonly sessionUrl: string;
  readonly devinMode: string | undefined;
  readonly attachmentsDir: string;
  readonly seenEventIds: Set<string>;
  readonly turns: Array<{ readonly id: TurnId; items: Array<unknown> }>;
  pollFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  turnStartedAtMs: number;
  turnObservedActivity: boolean;
  lastRemoteStatus: string | undefined;
  lastRemoteStatusDetail: string | null | undefined;
  lastTitle: string | null;
  lastSessionState: DevinCloudSessionState | undefined;
}

function parseDevinCloudResume(resumeCursor: unknown): { sessionId: string } | undefined {
  if (typeof resumeCursor !== "object" || resumeCursor === null || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const cursor = resumeCursor as { schemaVersion?: unknown; sessionId?: unknown };
  if (
    cursor.schemaVersion === RESUME_VERSION &&
    typeof cursor.sessionId === "string" &&
    isDevinSessionId(cursor.sessionId)
  ) {
    return { sessionId: cursor.sessionId };
  }
  return undefined;
}

function toAdapterError(error: unknown): ProviderAdapterError {
  if (
    error instanceof ProviderAdapterValidationError ||
    error instanceof ProviderAdapterRequestError ||
    error instanceof ProviderAdapterSessionNotFoundError
  ) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: "devinCloud.rest",
    detail,
    cause: error,
  });
}

function restErrorDetail(error: DevinRestError): string {
  if (error.status === 401 || error.status === 403) {
    return "Devin Cloud credentials were rejected. Check the API key in Settings → Providers → Devin Cloud, or run `devin auth login`.";
  }
  if (error.status === 404) {
    return "The Devin Cloud session no longer exists.";
  }
  return error.message;
}

export interface DevinCloudAdapterLiveOptions {
  readonly resolveServerPassword?: (provider: "devinCloud") => Effect.Effect<string | undefined>;
  /** Probe for `devin acp --cloud` support; tests inject the answer. */
  readonly acpCloudSupported?: (binaryPath: string) => Effect.Effect<boolean, never>;
  /** Builds the wrapped ACP adapter (`devin acp --cloud` via DevinAdapter).
   *  Absent in tests that only exercise the REST path. */
  readonly makeAcpAdapter?: (input: {
    readonly binaryPath?: string | undefined;
  }) => Effect.Effect<
    ProviderAdapterShape<ProviderAdapterError>,
    ProviderAdapterError,
    Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | ServerConfig
  >;
  /** Credential resolution — tests inject a deterministic answer. */
  readonly resolveAuth?: (input: {
    readonly serverPassword?: string | undefined;
  }) => Effect.Effect<DevinCloudAuth | null>;
  /** REST client factory — tests inject a scripted client. */
  readonly makeClient?: (auth: DevinCloudAuth) => DevinRestClient;
  /** Poll cadence overrides for tests; production uses the module defaults. */
  readonly pollIntervals?: {
    readonly activeMs?: number;
    readonly idleMs?: number;
    readonly minTurnPollMs?: number;
  };
}

const makeDevinCloudAdapter = (options?: DevinCloudAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const makeClient = options?.makeClient ?? makeDevinRestClient;
    const pollActiveMs = options?.pollIntervals?.activeMs ?? POLL_ACTIVE_MS;
    const pollIdleMs = options?.pollIntervals?.idleMs ?? POLL_IDLE_MS;
    const minTurnPollMs = options?.pollIntervals?.minTurnPollMs ?? MIN_TURN_POLL_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverSettings = yield* ServerSettingsService;
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, DevinCloudSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    // ACP transport (`devin acp --cloud`): the wrapped DevinAdapter is built
    // lazily on the first ACP-selected session and owns those threadIds.
    let acpAdapter: ProviderAdapterShape<ProviderAdapterError> | undefined;
    let acpScope: Scope.Closeable | undefined;
    const acpThreadIds = new Set<ThreadId>();

    // Torn down when the adapter layer's scope closes.
    yield* Effect.addFinalizer(() =>
      acpScope === undefined ? Effect.void : Scope.close(acpScope, Exit.void),
    );
    const acpSupportCache = new Map<string, boolean>();

    const spawnAcpHelpProbe = (binaryPath: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const child = yield* childProcessSpawner.spawn(
          makeEffectProcessCommand(binaryPath, ["acp", "--help"], {
            env: buildProviderChildEnvironment({ provider: PROVIDER }),
          }),
        );
        const [stdout, stderr] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout }).pipe(Effect.map(({ text }) => text)),
            collectUint8StreamText({ stream: child.stderr }).pipe(Effect.map(({ text }) => text)),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return detectDevinAcpCloudSupport(`${stdout}\n${stderr}`);
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => false),
      );

    // The probe result is stable for the lifetime of a binary; cache per
    // resolved path so settings changes to the path re-probe naturally.
    const acpCloudSupportedFor = (binaryPath: string): Effect.Effect<boolean, never> =>
      Effect.suspend(() => {
        const cached = acpSupportCache.get(binaryPath);
        if (cached !== undefined) return Effect.succeed(cached);
        const probe = options?.acpCloudSupported ?? spawnAcpHelpProbe;
        return probe(binaryPath).pipe(
          Effect.tap((supported) => Effect.sync(() => acpSupportCache.set(binaryPath, supported))),
        );
      });

    const ensureAcpAdapter = (binaryPath: string | undefined) =>
      Effect.gen(function* () {
        if (acpAdapter) return acpAdapter;
        if (!options?.makeAcpAdapter) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session/start",
            issue: "Devin Cloud ACP transport is unavailable in this build.",
          });
        }
        // The wrapped adapter gets its own long-lived scope plus this
        // adapter's services, so its requirement never leaks into callers.
        const createdScope = yield* Scope.make("sequential");
        acpScope = createdScope;
        const adapter = yield* options
          .makeAcpAdapter({ binaryPath })
          .pipe(
            Effect.provideService(Scope.Scope, createdScope),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(ServerConfig, serverConfig),
          );
        acpAdapter = adapter;
        // Forward the wrapped adapter's events into the shared PubSub so
        // streamEvents subscribers see both transports on one stream.
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          PubSub.publish(runtimeEventPubSub, event),
        ).pipe(Effect.forkIn(createdScope));
        // Let the pump subscribe before callers see the adapter so the
        // first ACP events are not dropped by an empty PubSub.
        yield* Effect.sleep("50 millis");
        return adapter;
      });

    const acpFor = (threadId: ThreadId) => (acpThreadIds.has(threadId) ? acpAdapter : undefined);

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        runtimeEventPubSub,
        stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
      ).pipe(Effect.asVoid);

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const emitSessionState = (
      ctx: DevinCloudSessionContext,
      state: DevinCloudSessionState,
      reason?: string,
    ) =>
      Effect.gen(function* () {
        if (ctx.lastSessionState === state) return;
        ctx.lastSessionState = state;
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { state, ...(reason ? { reason } : {}) },
        });
      });

    // Complete Devin messages render as a single item.started + content.delta +
    // item.completed burst (the ACP text path); replayed user messages carry
    // their text in the item detail instead of a synthetic delta stream.
    const emitMessageItem = (
      ctx: DevinCloudSessionContext,
      message: DevinCloudMessage,
      turnId: TurnId | undefined,
    ) =>
      Effect.gen(function* () {
        const itemId = RuntimeItemId.makeUnsafe(`devincloud:${message.event_id}`);
        const isUser = message.source === "user";
        const itemType = isUser ? "user_message" : "assistant_message";
        const itemBase = {
          provider: PROVIDER,
          threadId: ctx.threadId,
          itemId,
          ...(turnId ? { turnId } : {}),
        };
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "item.started",
          ...itemBase,
          ...(yield* makeEventStamp()),
          payload: { itemType, status: "inProgress" },
        });
        if (isUser) {
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "item.completed",
            ...itemBase,
            ...(yield* makeEventStamp()),
            payload: { itemType, status: "completed", detail: message.message },
          });
          return;
        }
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "content.delta",
          ...itemBase,
          ...(yield* makeEventStamp()),
          payload: { streamKind: "assistant_text", delta: message.message },
        });
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "item.completed",
          ...itemBase,
          ...(yield* makeEventStamp()),
          payload: { itemType, status: "completed" },
        });
      });

    const completeActiveTurn = (
      ctx: DevinCloudSessionContext,
      state: "completed" | "failed" | "interrupted" | "cancelled",
      errorMessage?: string,
    ) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (!turnId) return;
        ctx.activeTurnId = undefined;
        ctx.turnObservedActivity = false;
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state,
            stopReason: null,
            ...(errorMessage ? { errorMessage } : {}),
          },
        });
      });

    const closeSession = (ctx: DevinCloudSessionContext, reason: string, recoverable: boolean) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.pollFiber) {
          // closeSession also runs inside the poll loop itself (remote exit /
          // 404); interrupting our own fiber would swallow the close events.
          if (Fiber.getCurrent() !== ctx.pollFiber) {
            yield* Fiber.interrupt(ctx.pollFiber);
          }
          ctx.pollFiber = undefined;
        }
        if (ctx.activeTurnId) {
          yield* completeActiveTurn(ctx, "cancelled", reason);
        }
        ctx.session = { ...ctx.session, status: "closed", updatedAt: yield* nowIso };
        yield* emitSessionState(ctx, "stopped");
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { reason, recoverable },
        });
      });

    const failSession = (ctx: DevinCloudSessionContext, detail: string) =>
      Effect.gen(function* () {
        ctx.session = {
          ...ctx.session,
          status: "error",
          lastError: detail,
          updatedAt: yield* nowIso,
        };
        yield* completeActiveTurn(ctx, "failed", detail);
        yield* emitSessionState(ctx, "error", detail);
      });

    const projectRemoteStatus = (ctx: DevinCloudSessionContext, remote: DevinCloudSession) =>
      Effect.gen(function* () {
        const statusChanged =
          remote.status !== ctx.lastRemoteStatus ||
          remote.status_detail !== ctx.lastRemoteStatusDetail;
        ctx.lastRemoteStatus = remote.status;
        ctx.lastRemoteStatusDetail = remote.status_detail;

        if (remote.title && remote.title !== ctx.lastTitle) {
          ctx.lastTitle = remote.title;
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "thread.metadata.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            payload: {
              name: remote.title,
              metadata: {
                sessionUrl: ctx.sessionUrl,
                pullRequests: (remote.pull_requests ?? []).map((pr) => pr.pr_url),
                acusConsumed: remote.acus_consumed,
              },
            },
          });
        }

        if (ctx.activeTurnId) {
          if (
            SESSION_ACTIVE_STATUSES.has(remote.status) ||
            (remote.status_detail !== null &&
              SESSION_WORKING_STATUS_DETAILS.has(remote.status_detail))
          ) {
            ctx.turnObservedActivity = true;
          }
          if (remote.status === "error") {
            yield* failSession(ctx, "Devin Cloud reported a session error.");
            return;
          }
          if (SESSION_TERMINAL_STATUSES.has(remote.status)) {
            yield* completeActiveTurn(
              ctx,
              "cancelled",
              `Devin Cloud session ${remote.status === "exit" ? "exited" : "was suspended"}.`,
            );
          } else if (
            remote.status_detail !== null &&
            TURN_COMPLETING_STATUS_DETAILS.has(remote.status_detail) &&
            (ctx.turnObservedActivity || Date.now() - ctx.turnStartedAtMs >= minTurnPollMs)
          ) {
            yield* completeActiveTurn(ctx, "completed");
          }
        }

        if (remote.status === "error") {
          yield* failSession(ctx, "Devin Cloud reported a session error.");
          return;
        }
        if (remote.status === "exit") {
          yield* closeSession(ctx, "Devin Cloud session exited.", true);
          return;
        }
        if (remote.status === "suspended") {
          yield* emitSessionState(ctx, "stopped", "Devin Cloud session is suspended.");
        } else if (SESSION_ACTIVE_STATUSES.has(remote.status)) {
          if (
            remote.status_detail !== null &&
            TURN_COMPLETING_STATUS_DETAILS.has(remote.status_detail)
          ) {
            yield* emitSessionState(ctx, "waiting", "Devin is waiting for input.");
          } else if (remote.status_detail === "waiting_for_approval") {
            yield* emitSessionState(
              ctx,
              "waiting",
              `Devin is waiting for approval — open ${ctx.sessionUrl} to approve.`,
            );
          } else {
            yield* emitSessionState(ctx, "running");
          }
        } else if (statusChanged) {
          yield* emitSessionState(ctx, "starting", `Devin Cloud session is ${remote.status}.`);
        }
      });

    const pollOnce = (ctx: DevinCloudSessionContext): Effect.Effect<void, DevinRestError> =>
      Effect.gen(function* () {
        const remote = yield* ctx.client.getSession(ctx.orgId, ctx.devinSessionId);
        // New devin messages are item evidence for the open turn before the
        // status projection can settle it, so drain messages first.
        let cursor: string | undefined;
        do {
          const page = yield* ctx.client.listMessages(ctx.orgId, ctx.devinSessionId, cursor);
          for (const message of page.items) {
            if (ctx.seenEventIds.has(message.event_id)) continue;
            ctx.seenEventIds.add(message.event_id);
            if (message.source !== "devin") continue;
            ctx.turnObservedActivity = true;
            yield* emitMessageItem(ctx, message, ctx.activeTurnId);
          }
          cursor = page.has_next_page ? (page.end_cursor ?? undefined) : undefined;
        } while (cursor !== undefined);
        yield* projectRemoteStatus(ctx, remote);
      });

    const pollLoop = (ctx: DevinCloudSessionContext): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        while (!ctx.stopped) {
          yield* pollOnce(ctx).pipe(
            Effect.catch((error) =>
              error.status === 404
                ? closeSession(ctx, "Devin Cloud session was deleted.", true)
                : error.status === 401 || error.status === 403
                  ? failSession(ctx, restErrorDetail(error))
                  : Effect.logWarning("devinCloud.poll_failed", {
                      threadId: ctx.threadId,
                      detail: error.message,
                    }),
            ),
          );
          if (ctx.stopped) return;
          const idle =
            ctx.activeTurnId === undefined &&
            (ctx.lastRemoteStatusDetail === null ||
              ctx.lastRemoteStatusDetail === undefined ||
              !SESSION_WORKING_STATUS_DETAILS.has(ctx.lastRemoteStatusDetail));
          yield* Effect.sleep(`${idle ? pollIdleMs : pollActiveMs} millis`);
        }
      });

    // Resume replays every stored message (both sides) so the transcript looks
    // like the session never left; live polls then skip already-seen ids.
    const replayHistory = (ctx: DevinCloudSessionContext) =>
      Effect.gen(function* () {
        let cursor: string | undefined;
        do {
          const page = yield* ctx.client.listMessages(ctx.orgId, ctx.devinSessionId, cursor);
          for (const message of page.items) {
            if (ctx.seenEventIds.has(message.event_id)) continue;
            ctx.seenEventIds.add(message.event_id);
            if (message.source !== "devin" && message.source !== "user") continue;
            yield* emitMessageItem(ctx, message, undefined);
          }
          cursor = page.has_next_page ? (page.end_cursor ?? undefined) : undefined;
        } while (cursor !== undefined);
      });

    const resolveAuthAndOrg = (
      operation: string,
      devinCloudSettings:
        | { readonly orgId: string; readonly serverPasswordConfigured: boolean }
        | undefined,
    ) =>
      Effect.gen(function* () {
        const serverPassword = options?.resolveServerPassword
          ? yield* options.resolveServerPassword(PROVIDER)
          : undefined;
        const auth = yield* options?.resolveAuth
          ? options.resolveAuth({ serverPassword })
          : Effect.tryPromise({
              try: () => resolveDevinCloudAuth({ serverPassword }),
              catch: () => null,
            }).pipe(Effect.orDie);
        if (!auth) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue:
              "No Devin credentials found. Add a Devin API key in Settings → Providers → Devin Cloud, or run `devin auth login`.",
          });
        }
        const configuredOrg = devinCloudSettings?.orgId.trim();
        if (configuredOrg) {
          return { auth, orgId: configuredOrg };
        }
        const client = makeClient(auth);
        const self = yield* client.getSelf().pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "self.get",
                detail: restErrorDetail(error),
              }),
          ),
        );
        return { auth, orgId: self.org_id };
      });

    // Cloud sessions need the repo in `owner/repo` form; derive it from the
    // thread cwd's `origin` remote. `.git/config` is read directly rather than
    // via `git remote get-url` so `url.insteadOf` rewrites (credential proxies)
    // don't produce URLs Devin's git integration doesn't understand. Non-git
    // or non-GitHub cwds start a prompt-only session instead of failing.
    const resolveSessionRepos = (cwd: string | undefined) =>
      cwd === undefined
        ? Effect.succeed(undefined)
        : fileSystem.readFileString(`${cwd}/.git/config`, "utf8").pipe(
            Effect.map((config) => {
              const originSection = /\[remote "origin"\]([^\[]*)/.exec(config)?.[1];
              const url = /^\s*url\s*=\s*(\S+)\s*$/m.exec(originSection ?? "")?.[1];
              const repo = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
              return repo ? [repo] : undefined;
            }),
            Effect.orElseSucceed(() => undefined),
          );

    const startRestSession = (
      input: ProviderSessionStartInput,
      auth: DevinCloudAuth,
      orgId: string,
      devinMode: string | undefined,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.gen(function* () {
        const sessionScope = yield* Scope.make("sequential");
        const client = makeClient(auth);
        const resume = parseDevinCloudResume(input.resumeCursor);
        const repos = resume ? undefined : yield* resolveSessionRepos(input.cwd);

        let remote: DevinCloudSession;
        let resumed = false;
        if (resume) {
          remote = yield* client.getSession(orgId, resume.sessionId).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.get",
                  detail: restErrorDetail(error),
                }),
            ),
            Effect.onError(() => Scope.close(sessionScope, Exit.void)),
          );
          resumed = true;
        } else {
          remote = yield* client
            .createSession(orgId, {
              prompt:
                "You are Devin, running in Devin Cloud via Synara. The user's first instruction arrives next.",
              ...(devinMode ? { devinMode } : {}),
              ...(repos ? { repos } : {}),
              tags: ["synara"],
              bypassApproval: input.runtimeMode !== "approval-required",
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.create",
                    detail: restErrorDetail(error),
                  }),
              ),
              Effect.onError(() => Scope.close(sessionScope, Exit.void)),
            );
        }

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "running",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(devinMode ? { model: devinMode } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: RESUME_VERSION,
            sessionId: remote.session_id,
          },
          createdAt: now,
          updatedAt: now,
        };

        const ctx: DevinCloudSessionContext = {
          threadId: input.threadId,
          lifecycleGeneration: input.lifecycleGeneration,
          scope: sessionScope,
          session,
          stopped: false,
          client,
          orgId,
          devinSessionId: remote.session_id,
          sessionUrl: remote.url,
          devinMode,
          attachmentsDir: serverConfig.attachmentsDir,
          seenEventIds: new Set(),
          turns: [],
          pollFiber: undefined,
          activeTurnId: undefined,
          turnStartedAtMs: 0,
          turnObservedActivity: false,
          lastRemoteStatus: remote.status,
          lastRemoteStatusDetail: remote.status_detail,
          lastTitle: remote.title,
          lastSessionState: undefined,
        };
        sessions.set(input.threadId, ctx);

        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: {
            resume: { resumed, sessionUrl: remote.url },
          },
        });
        yield* emitSessionState(
          ctx,
          "running",
          `Devin Cloud session is ${remote.status} — ${remote.url}`,
        );
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: remote.session_id },
        });
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "thread.metadata.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { metadata: { sessionUrl: remote.url } },
        });
        // The cloud session URL is the only place approvals can be answered
        // (REST can't), so it must be reachable from the transcript. No UI
        // consumes the sessionUrl metadata fields yet — emit one link item.
        const urlItemId = RuntimeItemId.makeUnsafe(`devincloud:session-url:${remote.session_id}`);
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          itemId: urlItemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          itemId: urlItemId,
          payload: {
            streamKind: "assistant_text",
            delta: `Devin Cloud session: ${remote.url}`,
          },
        });
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          itemId: urlItemId,
          payload: { itemType: "assistant_message", status: "completed" },
        });

        if (resumed) {
          yield* replayHistory(ctx).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "messages.list",
                  detail: restErrorDetail(error),
                }),
            ),
            Effect.onError(() =>
              Effect.gen(function* () {
                sessions.delete(input.threadId);
                yield* Scope.close(sessionScope, Exit.void);
              }),
            ),
          );
        }

        ctx.pollFiber = yield* pollLoop(ctx).pipe(Effect.forkIn(sessionScope));
        return session;
      });

    const startSession: DevinCloudAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              () =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "session/start",
                  issue: "Failed to read provider settings.",
                }),
            ),
          );
          const devinCloudSettings = settings.providers.devinCloud;
          const mode = devinCloudSettings?.mode ?? "auto";
          const providerOptions = input.providerOptions?.devinCloud;
          const binaryPath =
            providerOptions?.binaryPath?.trim() || devinCloudSettings.binaryPath?.trim() || "devin";

          const acpSupported = yield* acpCloudSupportedFor(binaryPath);
          if (mode === "acp" && !acpSupported) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/start",
              issue:
                "Devin Cloud mode is 'acp' but `devin acp --cloud` is unavailable in the installed Devin CLI. Update the CLI or switch the mode to auto/rest.",
            });
          }

          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const devinMode =
            modelSelection?.options?.mode ??
            (modelSelection?.model && modelSelection.model !== "auto"
              ? modelSelection.model
              : undefined);

          if (mode === "acp" || (mode === "auto" && acpSupported)) {
            if (!options?.makeAcpAdapter) {
              if (mode === "acp") {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "session/start",
                  issue: "Devin Cloud ACP transport is unavailable in this build.",
                });
              }
            } else {
              const adapter = yield* ensureAcpAdapter(binaryPath);
              const startResult = yield* adapter
                .startSession({
                  ...input,
                  provider: PROVIDER,
                  // The wrapped adapter reads binaryPath (and a best-effort
                  // model slug) out of providerOptions.devin.
                  providerOptions: {
                    devin: {
                      binaryPath,
                      ...(devinMode ? { model: devinMode } : {}),
                    },
                  },
                })
                .pipe(Effect.result);
              if (Result.isSuccess(startResult)) {
                acpThreadIds.add(input.threadId);
                return startResult.success;
              }
              if (mode === "acp" || !isAcpUsageError(startResult.failure)) {
                return yield* Effect.fail(startResult.failure);
              }
              yield* Effect.logWarning("devinCloud.acp_usage_fallback", {
                threadId: input.threadId,
                detail: describeAdapterError(startResult.failure),
              });
            }
          }

          const { auth, orgId } = yield* resolveAuthAndOrg("session/start", devinCloudSettings);
          return yield* startRestSession(input, auth, orgId, devinMode);
        }),
      );

    const buildMessageContent = (
      ctx: DevinCloudSessionContext,
      input: {
        readonly text: string | undefined;
        readonly attachments?: ReadonlyArray<ChatAttachment>;
      },
    ) =>
      Effect.gen(function* () {
        // Files upload through POST /v3/attachments; the message itself is
        // text-only. assistant-selection text is already in `input.text`.
        const attachmentUrls: string[] = [];
        const names: string[] = [];
        for (const attachment of input.attachments ?? []) {
          if (attachment.type !== "file" && attachment.type !== "image") continue;
          const storagePath = resolveProviderAttachmentPath({
            attachmentsDir: ctx.attachmentsDir,
            attachment,
          });
          if (!storagePath) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/prompt",
              issue: `Attachment '${attachment.id}' is unavailable for this message. Reattach the file and retry.`,
            });
          }
          const bytes = yield* fileSystem
            .readFile(storagePath)
            .pipe(Effect.mapError((cause) => toAdapterError(cause)));
          const uploaded = yield* ctx.client
            .uploadAttachment({
              name: attachment.name,
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
              bytes,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "attachment.upload",
                    detail: restErrorDetail(error),
                  }),
              ),
            );
          attachmentUrls.push(uploaded.url);
          names.push(attachment.name);
        }
        const text =
          names.length > 0
            ? `${input.text?.trim() ? `${input.text.trim()}\n\n` : ""}Attached: ${names.join(", ")}`
            : (input.text?.trim() ?? "");
        return { text, attachmentUrls };
      });

    const sendTurnImpl: DevinCloudAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.activeTurnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/prompt",
              issue:
                "Devin Cloud is still working on the previous message. Steer the running turn instead, or wait for it to finish.",
            });
          }
          const { text, attachmentUrls } = yield* buildMessageContent(ctx, {
            text: input.input,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
          if (!text.trim() && attachmentUrls.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/prompt",
              issue: "Cannot send an empty message to Devin Cloud.",
            });
          }
          const remote = yield* ctx.client
            .sendMessage(ctx.orgId, ctx.devinSessionId, {
              message: text,
              attachmentUrls,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "message.send",
                    detail: restErrorDetail(error),
                  }),
              ),
            );

          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          ctx.activeTurnId = turnId;
          ctx.turnStartedAtMs = Date.now();
          ctx.turnObservedActivity =
            SESSION_ACTIVE_STATUSES.has(remote.status) ||
            (remote.status_detail !== null &&
              SESSION_WORKING_STATUS_DETAILS.has(remote.status_detail));
          ctx.turns.push({ id: turnId, items: [] });

          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {},
          });
          yield* projectRemoteStatus(ctx, remote);
          return { threadId: ctx.threadId, turnId } satisfies ProviderTurnStartResult;
        }),
      );

    const steerTurnImpl: NonNullable<DevinCloudAdapterShape["steerTurn"]> = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (!ctx.activeTurnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/steer",
              issue: "There is no active Devin Cloud turn to steer.",
            });
          }
          const { text, attachmentUrls } = yield* buildMessageContent(ctx, {
            text: input.input,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
          if (!text.trim() && attachmentUrls.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/steer",
              issue: "Cannot send an empty steering message to Devin Cloud.",
            });
          }
          yield* ctx.client
            .sendMessage(ctx.orgId, ctx.devinSessionId, {
              message: text,
              attachmentUrls,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "message.send",
                    detail: restErrorDetail(error),
                  }),
              ),
            );
          const turnId = ctx.activeTurnId;
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "turn.steered",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { message: text, target: "turn" },
          });
          return { threadId: ctx.threadId, turnId } satisfies ProviderTurnStartResult;
        }),
      );

    const interruptTurn: DevinCloudAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!ctx.activeTurnId) return;
          if (turnId && ctx.activeTurnId !== turnId) return;
          // REST cannot interrupt a running Devin turn; detach the local turn
          // and let the remote run continue in the background.
          yield* completeActiveTurn(ctx, "interrupted");
        }),
      );

    const respondToRequest: DevinCloudAdapterShape["respondToRequest"] = (
      threadId,
      _requestId,
      _decision,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail:
            "Devin Cloud approvals cannot be answered over REST. Open the session in the Devin web app to approve.",
        });
      });

    const respondToUserInput: DevinCloudAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail:
            "Devin Cloud questions cannot be answered over REST. Open the session in the Devin web app to respond.",
        });
      });

    const stopSession: DevinCloudAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          // Detach only — never terminate the remote session implicitly.
          yield* closeSession(ctx, "Session detached.", true);
        }),
      );

    const listSessions: DevinCloudAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => Object.assign({}, ctx.session)),
      );

    const hasSession: DevinCloudAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread: DevinCloudAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: snapshotProviderTurns(ctx.turns),
          cwd: ctx.session.cwd ?? null,
        } satisfies ProviderThreadSnapshot;
      });

    const readExternalThread: NonNullable<DevinCloudAdapterShape["readExternalThread"]> = (input) =>
      Effect.gen(function* () {
        const bareId = input.externalThreadId.replace(/^devin-/u, "");
        if (!isDevinSessionId(bareId)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readExternalThread",
            issue: `'${input.externalThreadId}' is not a Devin session id.`,
          });
        }
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "readExternalThread",
                issue: "Failed to read provider settings.",
              }),
          ),
        );
        const { auth, orgId } = yield* resolveAuthAndOrg(
          "readExternalThread",
          settings.providers.devinCloud,
        );
        const client = makeClient(auth);
        yield* client.getSession(orgId, bareId).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.get",
                detail: restErrorDetail(error),
              }),
          ),
        );
        const items: Array<unknown> = [];
        let cursor: string | undefined;
        do {
          const page = yield* client.listMessages(orgId, bareId, cursor).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "messages.list",
                  detail: restErrorDetail(error),
                }),
            ),
          );
          items.push(...page.items);
          cursor = page.has_next_page ? (page.end_cursor ?? undefined) : undefined;
        } while (cursor !== undefined);
        return {
          threadId: ThreadId.makeUnsafe(`devincloud:${bareId}`),
          turns: [
            {
              id: TurnId.makeUnsafe("devincloud-external"),
              items,
            },
          ],
          cwd: input.cwd ?? null,
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: DevinCloudAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin Cloud does not support conversation rollback.",
        });
      });

    const didResumeSession: NonNullable<DevinCloudAdapterShape["didResumeSession"]> = (
      input,
      session,
    ) => {
      const wanted = parseDevinCloudResume(input.resumeCursor)?.sessionId;
      if (!wanted) return false;
      const cursor = session.resumeCursor as { sessionId?: unknown } | undefined;
      return cursor?.sessionId === wanted;
    };

    const getComposerCapabilities: NonNullable<
      DevinCloudAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<DevinCloudAdapterShape["listModels"]> = () =>
      Effect.succeed({
        models: [
          { slug: "auto", name: "Auto (org default)" },
          { slug: "normal", name: "Normal" },
          { slug: "fast", name: "Fast" },
          { slug: "lite", name: "Lite" },
          { slug: "ultra", name: "Ultra" },
          { slug: "fusion", name: "Fusion" },
        ],
        source: "devinCloud.static",
      } satisfies ProviderListModelsResult);

    const stopAll: DevinCloudAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        yield* Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
          discard: true,
        });
        if (acpAdapter) {
          yield* acpAdapter.stopAll();
        }
      });

    // Thread-scoped methods route to the transport that owns the thread:
    // acpThreadIds → the wrapped ACP adapter, everything else → REST.
    const route = <A>(
      threadId: ThreadId,
      rest: Effect.Effect<A, ProviderAdapterError>,
      acpCall: (
        adapter: ProviderAdapterShape<ProviderAdapterError>,
      ) => Effect.Effect<A, ProviderAdapterError>,
    ): Effect.Effect<A, ProviderAdapterError> => {
      const adapter = acpFor(threadId);
      return adapter ? acpCall(adapter) : rest;
    };

    const routedSendTurn: DevinCloudAdapterShape["sendTurn"] = (input) =>
      route(input.threadId, sendTurnImpl(input), (adapter) => adapter.sendTurn(input));

    const routedSteerTurn: NonNullable<DevinCloudAdapterShape["steerTurn"]> = (input) =>
      route(input.threadId, steerTurnImpl(input), (adapter) =>
        adapter.steerTurn !== undefined
          ? adapter.steerTurn(input)
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "steerTurn",
                detail: "Devin Cloud does not support turn steering on this transport.",
              }),
            ),
      );

    const routedInterruptTurn: DevinCloudAdapterShape["interruptTurn"] = (
      threadId,
      turnId,
      providerThreadId,
    ) =>
      route(threadId, interruptTurn(threadId, turnId, providerThreadId), (adapter) =>
        adapter.interruptTurn(threadId, turnId, providerThreadId),
      );

    const routedRespondToRequest: DevinCloudAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      route(threadId, respondToRequest(threadId, requestId, decision), (adapter) =>
        adapter.respondToRequest(threadId, requestId, decision),
      );

    const routedRespondToUserInput: DevinCloudAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      route(threadId, respondToUserInput(threadId, requestId, answers), (adapter) =>
        adapter.respondToUserInput(threadId, requestId, answers),
      );

    const routedStopSession: DevinCloudAdapterShape["stopSession"] = (threadId) => {
      const adapter = acpFor(threadId);
      if (adapter) {
        acpThreadIds.delete(threadId);
        return adapter.stopSession(threadId);
      }
      return stopSession(threadId);
    };

    const routedListSessions: DevinCloudAdapterShape["listSessions"] = () =>
      Effect.gen(function* () {
        const rest = yield* listSessions();
        const acp = acpAdapter ? yield* acpAdapter.listSessions() : [];
        return [...rest, ...acp];
      });

    const routedHasSession: DevinCloudAdapterShape["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        if (yield* hasSession(threadId)) return true;
        const adapter = acpFor(threadId);
        return adapter ? yield* adapter.hasSession(threadId) : false;
      });

    const routedReadThread: DevinCloudAdapterShape["readThread"] = (threadId) =>
      route(threadId, readThread(threadId), (adapter) => adapter.readThread(threadId));

    const routedRollbackThread: DevinCloudAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      route(threadId, rollbackThread(threadId, numTurns), (adapter) =>
        adapter.rollbackThread(threadId, numTurns),
      );

    const routedDidResumeSession: NonNullable<DevinCloudAdapterShape["didResumeSession"]> = (
      input,
      session,
    ) => {
      const adapter = acpFor(input.threadId);
      if (adapter?.didResumeSession) {
        return adapter.didResumeSession(input, session);
      }
      return didResumeSession(input, session);
    };

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
        supportsTurnSteering: true,
      },
      startSession,
      didResumeSession: routedDidResumeSession,
      sendTurn: routedSendTurn,
      steerTurn: routedSteerTurn,
      interruptTurn: routedInterruptTurn,
      respondToRequest: routedRespondToRequest,
      respondToUserInput: routedRespondToUserInput,
      stopSession: routedStopSession,
      listSessions: routedListSessions,
      hasSession: routedHasSession,
      readThread: routedReadThread,
      readExternalThread,
      rollbackThread: routedRollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      getComposerCapabilities,
      listModels,
    } satisfies DevinCloudAdapterShape;
  });

export function makeDevinCloudAdapterLive(options?: DevinCloudAdapterLiveOptions) {
  return Layer.effect(DevinCloudAdapter, makeDevinCloudAdapter(options));
}
