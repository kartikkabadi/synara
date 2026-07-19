/**
 * Devin ACP support - builds the Devin stdio command and resolves auth.
 *
 * Devin sessions use on-demand authentication: they try stored CLI credentials first,
 * and only call authenticate (browser PKCE) when the agent explicitly rejects session
 * creation as unauthenticated.
 *
 * @module DevinAcpSupport
 */
import { Effect, Layer, Scope, ServiceMap } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpErrorsRuntime from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import { buildAcpSpawnEnv } from "./acpSpawnEnv.ts";

export interface DevinAcpRuntimeSettings {
  readonly binaryPath?: string;
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings | null | undefined;
}

export const DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID = "windsurf-api-key";
export const DEVIN_BROWSER_LOGIN_AUTH_METHOD_ID = "browser_login";
export const DEVIN_API_KEY_ENV_KEYS = ["WINDSURF_API_KEY"] as const;

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath?.trim() || "devin",
    args: ["acp"],
    cwd,
    env: buildAcpSpawnEnv({ extraPrefixes: ["DEVIN_", "WINDSURF_"] }),
  };
}

function availableAuthMethodIds(
  initializeResult: EffectAcpSchema.InitializeResponse,
): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export function hasDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEVIN_API_KEY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

export const resolveDevinAcpAuthMethodId = (
  initializeResult: EffectAcpSchema.InitializeResponse,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasApiKey = hasDevinApiKeyEnv(env);

    if (hasApiKey && authMethodIds.has(DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID)) {
      return DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID;
    }
    // Prefer the interactive flow when no API key is available. Selecting the
    // advertised API-key method without a key makes on-demand recovery fail
    // before the usable browser-login method gets a chance to run.
    if (authMethodIds.has(DEVIN_BROWSER_LOGIN_AUTH_METHOD_ID)) {
      return DEVIN_BROWSER_LOGIN_AUTH_METHOD_ID;
    }

    return yield* new EffectAcpErrorsRuntime.AcpRequestError({
      code: -32602,
      errorMessage: "Devin ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: hasApiKey
          ? "Devin did not advertise Windsurf API key authentication."
          : "Run `devin auth login`, or set WINDSURF_API_KEY.",
      },
    });
  });

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd),
        resolveAuthMethodId: resolveDevinAcpAuthMethodId,
        authenticateMeta: { headless: true },
        authPolicy: "on-demand",
        clientCapabilities: {
          ...input.clientCapabilities,
          elicitation: { form: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });
