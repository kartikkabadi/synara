/**
 * ControlPlaneKernelLive - Live layer over the `minisqlite-node` napi binding.
 *
 * Opens a dedicated `control-plane.db` next to `state.sqlite` (no schema
 * entanglement with the existing migrations). The native addon is loaded
 * lazily and only when `SYNARA_CONTROL_PLANE_KERNEL` is "shadow" or "on":
 * with the default "off" the layer provides a disabled implementation whose
 * operations fail with a typed error, so the addon is never required at
 * runtime until the kernel path is enabled.
 *
 * Rollout is fail-closed: when the flag is "shadow" or "on" and the addon is
 * unavailable (`AddonUnavailable`) or does not expose the method surface the
 * kernel relies on (`AddonIncompatible`), layer construction fails with a
 * typed `ControlPlaneKernelError` instead of silently staying disabled.
 *
 * @module ControlPlaneKernelLive
 */
import { Effect, Layer } from "effect";
import { createRequire } from "node:module";
import path from "node:path";

import { ServerConfig, controlPlaneKernelMode } from "../../config.ts";
import {
  ControlPlaneKernel,
  ControlPlaneKernelError,
  type ControlPlaneKernelShape,
  type KernelClaimOutcome,
  type KernelCommitBatch,
  type KernelCommitReceipt,
  type KernelClaimRequest,
  type KernelJobInfo,
  type KernelLeaseExtensionReceipt,
  type KernelPersistedEvent,
  type KernelTransactionRecovery,
} from "../Services/ControlPlaneKernel.ts";

export const CONTROL_PLANE_DB_FILENAME = "control-plane.db";

interface NativeStore {
  close(): void;
  commit(batch: KernelCommitBatch): KernelCommitReceipt;
  claimJobs(request: KernelClaimRequest): KernelClaimOutcome;
  extendLease(
    jobId: string,
    leaseToken: string,
    newExpiryMs: number,
    nowMs: number,
  ): KernelLeaseExtensionReceipt;
  recoverClaim(transactionId: string, nowMs: number): KernelClaimOutcome;
  recoverTransaction(transactionId: string): KernelTransactionRecovery;
  jobs(
    queue: string | undefined | null,
    state: string | undefined | null,
    limit: number,
  ): Array<KernelJobInfo>;
  projectionGet(projection: string, key: Uint8Array): Uint8Array | null;
  projectionVersion(projection: string): number;
  streamVersion(streamId: string): number;
  eventsAfter(after: number, limit: number): Array<KernelPersistedEvent>;
}

interface NativeBinding {
  Store: { open(path: string, durability?: string | null): NativeStore };
  newId(): string;
}

const require = createRequire(import.meta.url);

const REQUIRED_STORE_METHODS = [
  "close",
  "commit",
  "claimJobs",
  "extendLease",
  "recoverClaim",
  "recoverTransaction",
  "jobs",
  "projectionGet",
  "projectionVersion",
  "streamVersion",
  "eventsAfter",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return (typeof value === "object" || typeof value === "function") && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Handshake, part 1: the addon module must export a `Store` with a callable
 * `open` and a callable `newId`. The napi module exposes no API-version
 * export (`minisqlite-node` is versioned via its package.json only), so the
 * method-set check below is the compatibility contract. Returns a detail
 * string naming what is missing, or null when the surface matches.
 */
export function bindingHandshakeFailure(binding: unknown): string | null {
  const record = asRecord(binding);
  if (record === undefined) {
    return "minisqlite-node addon export is not an object.";
  }
  const missing: Array<string> = [];
  if (typeof asRecord(record.Store)?.open !== "function") missing.push("Store.open");
  if (typeof record.newId !== "function") missing.push("newId");
  return missing.length > 0
    ? `minisqlite-node addon is missing required export(s): ${missing.join(", ")}.`
    : null;
}

/**
 * Handshake, part 2: the store instance returned by `Store.open` must expose
 * every method the kernel calls. Returns a detail string naming the missing
 * method(s), or null when the surface matches.
 */
export function storeHandshakeFailure(store: unknown): string | null {
  const record = asRecord(store);
  const missing =
    record === undefined
      ? [...REQUIRED_STORE_METHODS]
      : REQUIRED_STORE_METHODS.filter((name) => typeof record[name] !== "function");
  return missing.length > 0
    ? `minisqlite-node store is missing required method(s): ${missing.join(", ")}.`
    : null;
}

/** Typed load/handshake failure returned by {@link loadControlPlaneAddon}. */
export interface ControlPlaneAddonFailure {
  readonly code: "AddonUnavailable" | "AddonIncompatible";
  readonly detail: string;
}

export function isControlPlaneAddonFailure(
  result: NativeBinding | ControlPlaneAddonFailure,
): result is ControlPlaneAddonFailure {
  return "detail" in result;
}

/**
 * Resolve the `minisqlite-node` addon: an explicit
 * `SYNARA_CONTROL_PLANE_ADDON_PATH` wins, then normal module resolution.
 * Returns a typed failure when the addon cannot be loaded
 * (`AddonUnavailable`) or fails the export handshake (`AddonIncompatible`).
 */
export function loadControlPlaneAddon(
  env: Record<string, string | undefined> = process.env,
): NativeBinding | ControlPlaneAddonFailure {
  const explicitPath = env.SYNARA_CONTROL_PLANE_ADDON_PATH?.trim();
  const specifier =
    explicitPath !== undefined && explicitPath !== "" ? explicitPath : "minisqlite-node";
  let binding: unknown;
  try {
    binding = require(specifier);
  } catch (cause) {
    return {
      code: "AddonUnavailable",
      detail: `Failed to load the minisqlite-node addon from "${specifier}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  const failure = bindingHandshakeFailure(binding);
  if (failure !== null) {
    return { code: "AddonIncompatible", detail: failure };
  }
  // The single validated boundary cast: the export surface was checked above.
  return binding as NativeBinding;
}

function kernelError(operation: string, cause: unknown): ControlPlaneKernelError {
  const code =
    typeof (cause as { readonly code?: unknown } | null)?.code === "string"
      ? (cause as { readonly code: string }).code
      : "Unknown";
  return new ControlPlaneKernelError({
    operation,
    code,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function makeKernelFromStore(
  binding: NativeBinding,
  store: NativeStore,
  mode: "shadow" | "on",
): ControlPlaneKernelShape {
  const call = <A>(operation: string, run: () => A): Effect.Effect<A, ControlPlaneKernelError> =>
    Effect.try({ try: run, catch: (cause) => kernelError(operation, cause) });

  return {
    mode,
    commit: (batch) => call("commit", () => store.commit(batch)),
    claimJobs: (request) => call("claimJobs", () => store.claimJobs(request)),
    extendLease: ({ jobId, leaseToken, newExpiryMs, nowMs }) =>
      call("extendLease", () => store.extendLease(jobId, leaseToken, newExpiryMs, nowMs)),
    recoverClaim: ({ transactionId, nowMs }) =>
      call("recoverClaim", () => store.recoverClaim(transactionId, nowMs)),
    recoverTransaction: (transactionId) =>
      call("recoverTransaction", () => store.recoverTransaction(transactionId)),
    jobs: ({ queue, state, limit }) => call("jobs", () => store.jobs(queue, state, limit)),
    projectionGet: ({ projection, key }) =>
      call("projectionGet", () => store.projectionGet(projection, key)),
    projectionVersion: (projection) =>
      call("projectionVersion", () => store.projectionVersion(projection)),
    streamVersion: (streamId) => call("streamVersion", () => store.streamVersion(streamId)),
    eventsAfter: ({ after, limit }) => call("eventsAfter", () => store.eventsAfter(after, limit)),
    newId: () => call("newId", () => binding.newId()),
  };
}

function makeDisabledKernel(detail: string): ControlPlaneKernelShape {
  const disabled = (operation: string) =>
    Effect.fail(new ControlPlaneKernelError({ operation, code: "KernelDisabled", detail }));
  return {
    mode: "off",
    commit: () => disabled("commit"),
    claimJobs: () => disabled("claimJobs"),
    extendLease: () => disabled("extendLease"),
    recoverClaim: () => disabled("recoverClaim"),
    recoverTransaction: () => disabled("recoverTransaction"),
    jobs: () => disabled("jobs"),
    projectionGet: () => disabled("projectionGet"),
    projectionVersion: () => disabled("projectionVersion"),
    streamVersion: () => disabled("streamVersion"),
    eventsAfter: () => disabled("eventsAfter"),
    newId: () => disabled("newId"),
  };
}

/**
 * Open a kernel store at an explicit path. Used by the live layer and by
 * tests against a temp directory. Closes the store when the scope ends.
 */
export const makeControlPlaneKernelAtPath = (dbPath: string, mode: "shadow" | "on") =>
  Effect.gen(function* () {
    const binding = loadControlPlaneAddon();
    if (isControlPlaneAddonFailure(binding)) {
      return yield* Effect.fail(
        new ControlPlaneKernelError({
          operation: "open",
          code: binding.code,
          detail: binding.detail,
        }),
      );
    }
    const store = yield* Effect.acquireRelease(
      Effect.try({
        try: () => binding.Store.open(dbPath),
        catch: (cause) => kernelError("open", cause),
      }),
      (openStore) =>
        Effect.sync(() => {
          if (typeof asRecord(openStore)?.close === "function") openStore.close();
        }),
    );
    const storeFailure = storeHandshakeFailure(store);
    if (storeFailure !== null) {
      return yield* Effect.fail(
        new ControlPlaneKernelError({
          operation: "open",
          code: "AddonIncompatible",
          detail: storeFailure,
        }),
      );
    }
    return makeKernelFromStore(binding, store, mode);
  });

/**
 * Live layer: disabled (typed failure on use) when the flag is "off" — the
 * addon is never loaded in that mode. When the flag is "shadow" or "on" the
 * layer opens `control-plane.db` in the server state directory and fails
 * closed: an unavailable or incompatible addon fails layer construction
 * rather than silently downgrading to the disabled kernel.
 */
export const ControlPlaneKernelLive = Layer.effect(ControlPlaneKernel)(
  Effect.gen(function* () {
    const mode = controlPlaneKernelMode();
    if (mode === "off") {
      return makeDisabledKernel("SYNARA_CONTROL_PLANE_KERNEL is off.");
    }
    const config = yield* ServerConfig;
    return yield* makeControlPlaneKernelAtPath(
      path.join(config.stateDir, CONTROL_PLANE_DB_FILENAME),
      mode,
    );
  }),
);
