// FILE: provider/devinCloud/DevinRestClient.ts
// Purpose: Devin Cloud v3 REST API client over the SSRF-safe outboundHttp transport.
// Auth resolves through the shared Devin credential chain (settings key → env →
// `devin auth login` store) so any user logged into the Devin CLI needs no extra setup.
// Layer: Provider adapter transport

import {
  decodeOutboundJson,
  encodeOutboundMultipart,
  type OutboundHttpPolicy,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
  outboundHttp,
} from "@synara/shared/outboundHttp";
import { Effect, Schema } from "effect";

import { getDevinApiKeyEnv, readDevinStoredCredentials } from "../acp/DevinAcpSupport.ts";

export const DEVIN_CLOUD_API_BASE_URL = "https://api.devin.ai";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_JSON_REQUEST_BYTES = 256 * 1024;
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const JSON_LIMITS = { maxDepth: 64, maxNodes: 20_000 } as const;

const SESSION_ID_PATTERN = /^(?:devin-)?[0-9a-f]{32}$/u;

export class DevinRestError extends Schema.TaggedErrorClass<DevinRestError>()("DevinRestError", {
  operation: Schema.String,
  status: Schema.optional(Schema.Number),
  retryAfterMs: Schema.optional(Schema.Number),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    const status = this.status !== undefined ? ` (${this.status})` : "";
    return `Devin Cloud request failed in ${this.operation}${status}: ${this.detail}`;
  }
}

export const isDevinRestAuthFailure = (error: DevinRestError): boolean =>
  error.status === 401 || error.status === 403;

export const isDevinRestNotFound = (error: DevinRestError): boolean => error.status === 404;

export const isDevinRestRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

export interface DevinCloudAuth {
  readonly apiKey: string;
  readonly baseUrl: string;
}

/**
 * Resolve the API token Devin Cloud calls use, in priority order: the configured
 * provider secret, DEVIN_API_KEY/WINDSURF_API_KEY env, then the `devin auth login`
 * credential store. The CLI login token is accepted by v3 for user sessions.
 */
export async function resolveDevinCloudAuth(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly serverPassword?: string | undefined;
  readonly baseUrl?: string | undefined;
}): Promise<DevinCloudAuth | null> {
  const env = input.env ?? process.env;
  const stored = input.serverPassword
    ? undefined
    : await readDevinStoredCredentials(env, input.platform ?? process.platform);
  const apiKey = input.serverPassword?.trim() || getDevinApiKeyEnv(env) || stored?.apiKey;
  if (!apiKey) {
    return null;
  }
  return { apiKey, baseUrl: input.baseUrl?.trim() || DEVIN_CLOUD_API_BASE_URL };
}

export const DevinCloudSelf = Schema.Struct({
  principal_type: Schema.String,
  user_id: Schema.String,
  user_name: Schema.optional(Schema.NullOr(Schema.String)),
  org_id: Schema.String,
});
export type DevinCloudSelf = typeof DevinCloudSelf.Type;

export const DevinCloudPullRequest = Schema.Struct({
  pr_url: Schema.String,
});
export const DevinCloudSession = Schema.Struct({
  session_id: Schema.String,
  url: Schema.String,
  status: Schema.String,
  status_detail: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  devin_mode: Schema.NullOr(Schema.String),
  acus_consumed: Schema.Number,
  pull_requests: Schema.optional(Schema.Array(DevinCloudPullRequest)),
  structured_output: Schema.optional(Schema.Unknown),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  is_archived: Schema.Boolean,
});
export type DevinCloudSession = typeof DevinCloudSession.Type;

export const DevinCloudMessage = Schema.Struct({
  event_id: Schema.String,
  source: Schema.String,
  message: Schema.String,
  created_at: Schema.Number,
  username: Schema.optional(Schema.NullOr(Schema.String)),
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DevinCloudMessage = typeof DevinCloudMessage.Type;

export const DevinCloudMessagePage = Schema.Struct({
  items: Schema.Array(DevinCloudMessage),
  end_cursor: Schema.NullOr(Schema.String),
  has_next_page: Schema.Boolean,
});
export type DevinCloudMessagePage = typeof DevinCloudMessagePage.Type;

export const DevinCloudAttachment = Schema.Struct({
  attachment_id: Schema.String,
  name: Schema.String,
  url: Schema.String,
});
export type DevinCloudAttachment = typeof DevinCloudAttachment.Type;

export interface DevinCloudSessionCreateInput {
  readonly prompt: string;
  readonly title?: string;
  readonly repos?: ReadonlyArray<string> | undefined;
  readonly devinMode?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly bypassApproval?: boolean;
  readonly maxAcuLimit?: number;
}

export interface DevinRestClient {
  readonly getSelf: () => Effect.Effect<DevinCloudSelf, DevinRestError>;
  readonly createSession: (
    orgId: string,
    input: DevinCloudSessionCreateInput,
  ) => Effect.Effect<DevinCloudSession, DevinRestError>;
  readonly getSession: (
    orgId: string,
    sessionId: string,
  ) => Effect.Effect<DevinCloudSession, DevinRestError>;
  readonly sendMessage: (
    orgId: string,
    sessionId: string,
    input: { readonly message: string; readonly attachmentUrls?: ReadonlyArray<string> },
  ) => Effect.Effect<DevinCloudSession, DevinRestError>;
  readonly listMessages: (
    orgId: string,
    sessionId: string,
    cursor?: string,
  ) => Effect.Effect<DevinCloudMessagePage, DevinRestError>;
  readonly uploadAttachment: (input: {
    readonly name: string;
    readonly mimeType?: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<DevinCloudAttachment, DevinRestError>;
  readonly terminateSession: (
    orgId: string,
    sessionId: string,
  ) => Effect.Effect<DevinCloudSession, DevinRestError>;
}

const toRestError =
  (operation: string) =>
  (cause: unknown): DevinRestError =>
    cause instanceof DevinRestError
      ? cause
      : new DevinRestError({
          operation,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });

const isRetryableError = (error: DevinRestError): boolean =>
  error.status === undefined || isDevinRestRetryableStatus(error.status);

const parseRetryAfterMs = (headers: Headers): number | undefined => {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, Math.min(dateMs - Date.now(), 60_000)) : undefined;
};

/** Path parameters accept the bare id or the devin- prefixed form; normalize to prefixed. */
export function normalizeDevinSessionPathId(sessionId: string): string {
  return sessionId.startsWith("devin-") ? sessionId : `devin-${sessionId}`;
}

export function isDevinSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

const orgPath = (orgId: string) => `/v3/organizations/${encodeURIComponent(orgId)}`;
const sessionPath = (orgId: string, sessionId: string) =>
  `${orgPath(orgId)}/sessions/${encodeURIComponent(normalizeDevinSessionPathId(sessionId))}`;

export function makeDevinRestClient(
  auth: DevinCloudAuth,
  options?: {
    readonly request?: (input: OutboundHttpRequest) => Promise<OutboundHttpResponse>;
  },
): DevinRestClient {
  const baseUrl = auth.baseUrl.replace(/\/+$/u, "");
  const origin = new URL(baseUrl).origin;
  const doRequest =
    options?.request ?? ((input: OutboundHttpRequest) => outboundHttp.request(input));

  const policyFor = (maxRequestBytes: number): OutboundHttpPolicy => ({
    service: "devin-cloud",
    allowedOrigins: [origin],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRequestBytes,
    maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
    maxRedirects: 0,
    maxConcurrent: 8,
    maxQueued: 64,
  });

  const requestJson = <A>(input: {
    readonly operation: string;
    readonly method: OutboundHttpRequest["method"];
    readonly path: string;
    readonly body?: unknown;
    readonly maxRequestBytes?: number;
    readonly extraHeaders?: Record<string, string>;
    readonly rawBody?: Uint8Array;
    readonly decode: (json: unknown) => A;
  }): Effect.Effect<A, DevinRestError> => {
    const attempt = Effect.tryPromise({
      try: async () => {
        const response = await doRequest({
          policy: policyFor(input.maxRequestBytes ?? MAX_JSON_REQUEST_BYTES),
          url: `${baseUrl}${input.path}`,
          ...(input.method ? { method: input.method } : {}),
          headers: {
            Authorization: `Bearer ${auth.apiKey}`,
            Accept: "application/json",
            ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...input.extraHeaders,
          },
          ...(input.rawBody !== undefined
            ? { body: input.rawBody }
            : input.body !== undefined
              ? { body: JSON.stringify(input.body) }
              : {}),
        });
        return response;
      },
      catch: toRestError(input.operation),
    }).pipe(
      Effect.flatMap((response) => {
        if (response.status < 200 || response.status >= 300) {
          let detail = `HTTP ${response.status}`;
          try {
            const text = new TextDecoder().decode(response.body).slice(0, 500);
            if (text.trim()) detail = text;
          } catch {
            // keep the status-only detail
          }
          const retryAfterMs = parseRetryAfterMs(response.headers);
          return Effect.fail(
            new DevinRestError({
              operation: input.operation,
              status: response.status,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
              detail,
            }),
          );
        }
        return Effect.try({
          try: () => input.decode(decodeOutboundJson(response, JSON_LIMITS)),
          catch: toRestError(input.operation),
        });
      }),
    );

    const loop = (attemptIndex: number): Effect.Effect<A, DevinRestError> =>
      attempt.pipe(
        Effect.catch((error) => {
          if (!isRetryableError(error) || attemptIndex >= MAX_ATTEMPTS - 1) {
            return Effect.fail(error);
          }
          const backoffMs = error.retryAfterMs ?? Math.min(250 * 2 ** attemptIndex, 10_000);
          return Effect.sleep(`${backoffMs} millis`).pipe(
            Effect.flatMap(() => loop(attemptIndex + 1)),
          );
        }),
      );
    return loop(0);
  };

  const decodeWith =
    <A>(schema: Schema.Top) =>
    (json: unknown): A =>
      Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>)(json) as A;

  const getSession: DevinRestClient["getSession"] = (orgId, sessionId) =>
    requestJson({
      operation: "session.get",
      method: "GET",
      path: sessionPath(orgId, sessionId),
      decode: decodeWith(DevinCloudSession),
    });

  const createSessionWithRepos = (
    orgId: string,
    input: DevinCloudSessionCreateInput,
  ): Effect.Effect<DevinCloudSession, DevinRestError> =>
    requestJson({
      operation: "session.create",
      method: "POST",
      path: `${orgPath(orgId)}/sessions`,
      body: {
        prompt: input.prompt,
        structured_output_required: false,
        ...(input.title ? { title: input.title } : {}),
        ...(input.repos && input.repos.length > 0 ? { repos: input.repos } : {}),
        ...(input.devinMode ? { devin_mode: input.devinMode } : {}),
        ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
        ...(input.bypassApproval === true ? { bypass_approval: true } : {}),
        ...(input.maxAcuLimit !== undefined ? { max_acu_limit: input.maxAcuLimit } : {}),
      },
      decode: decodeWith(DevinCloudSession),
    });

  return {
    getSelf: () =>
      requestJson({
        operation: "self.get",
        method: "GET",
        path: "/v3/self",
        decode: decodeWith(DevinCloudSelf),
      }),

    // Session creation retries once without `repos` when the org's git
    // integration rejects the repo list (400-class failure only).
    createSession: (orgId, input) =>
      createSessionWithRepos(orgId, input).pipe(
        Effect.catchIf(
          (error) =>
            input.repos !== undefined &&
            input.repos.length > 0 &&
            error.status !== undefined &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 401 &&
            error.status !== 403,
          () => createSessionWithRepos(orgId, { ...input, repos: undefined }),
        ),
      ),

    getSession,

    sendMessage: (orgId, sessionId, input) =>
      requestJson({
        operation: "message.send",
        method: "POST",
        path: `${sessionPath(orgId, sessionId)}/messages`,
        body: {
          message: input.message,
          ...(input.attachmentUrls && input.attachmentUrls.length > 0
            ? { attachment_urls: input.attachmentUrls }
            : {}),
        },
        decode: decodeWith(DevinCloudSession),
      }),

    listMessages: (orgId, sessionId, cursor) =>
      requestJson({
        operation: "messages.list",
        method: "GET",
        path: `${sessionPath(orgId, sessionId)}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        decode: decodeWith(DevinCloudMessagePage),
      }),

    uploadAttachment: (input) =>
      Effect.flatMap(
        Effect.try({
          try: () =>
            encodeOutboundMultipart(
              [
                {
                  name: "file",
                  filename: input.name,
                  ...(input.mimeType ? { contentType: input.mimeType } : {}),
                  body: input.bytes,
                },
              ],
              { maxBytes: MAX_ATTACHMENT_BYTES },
            ),
          catch: toRestError("attachment.upload"),
        }),
        (multipart) =>
          requestJson({
            operation: "attachment.upload",
            method: "POST",
            path: "/v3/attachments",
            rawBody: multipart.body,
            maxRequestBytes: MAX_ATTACHMENT_BYTES,
            extraHeaders: { "Content-Type": multipart.contentType },
            decode: decodeWith(DevinCloudAttachment),
          }),
      ),

    terminateSession: (orgId, sessionId) =>
      requestJson({
        operation: "session.terminate",
        method: "DELETE",
        path: sessionPath(orgId, sessionId),
        decode: decodeWith(DevinCloudSession),
      }),
  };
}
