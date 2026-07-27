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
  type KernelJobsPage,
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
  job(jobId: string): KernelJobInfo | null;
  jobsPage(
    queue: string | undefined | null,
    state: string | undefined | null,
    afterSequence: number,
    limit: number,
  ): KernelJobsPage;
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

/**
 * Resolve the `minisqlite-node` addon: an explicit
 * `SYNARA_CONTROL_PLANE_ADDON_PATH` wins, then normal module resolution.
 * Returns a descriptive error string when the addon is unavailable.
 */
export function loadControlPlaneAddon(
  env: Record<string, string | undefined> = process.env,
): NativeBinding | string {
  const explicitPath = env.SYNARA_CONTROL_PLANE_ADDON_PATH?.trim();
  const specifier =
    explicitPath !== undefined && explicitPath !== "" ? explicitPath : "minisqlite-node";
  try {
    return require(specifier) as NativeBinding;
  } catch (cause) {
    return `Failed to load the minisqlite-node addon from "${specifier}": ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
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
    job: (jobId) => call("job", () => store.job(jobId)),
    jobsPage: ({ queue, state, afterSequence, limit }) =>
      call("jobsPage", () => store.jobsPage(queue, state, afterSequence, limit)),
    resolveUncertainJobs: ({ committedAtMs, resolutions }) =>
      call("resolveUncertainJobs", () =>
        store.commit({ committedAtMs, resolveUncertainJobs: resolutions }),
      ),
    projectionGet: ({ projection, key }) =>
      call("projectionGet", () => store.projectionGet(projection, key)),
    projectionVersion: (projection) =>
      call("projectionVersion", () => store.projectionVersion(projection)),
    streamVersion: (streamId) => call("streamVersion", () => store.streamVersion(streamId)),
    eventsAfter: ({ after, limit }) => call("eventsAfter", () => store.eventsAfter(after, limit)),
    newId: () => call("newId", () => binding.newId()),
  };
}

export function makeDisabledKernel(detail: string): ControlPlaneKernelShape {
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
    job: () => disabled("job"),
    jobsPage: () => disabled("jobsPage"),
    resolveUncertainJobs: () => disabled("resolveUncertainJobs"),
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
    if (typeof binding === "string") {
      return yield* Effect.fail(
        new ControlPlaneKernelError({
          operation: "open",
          code: "AddonUnavailable",
          detail: binding,
        }),
      );
    }
    const store = yield* Effect.acquireRelease(
      Effect.try({
        try: () => binding.Store.open(dbPath),
        catch: (cause) => kernelError("open", cause),
      }),
      (openStore) => Effect.sync(() => openStore.close()),
    );
    return makeKernelFromStore(binding, store, mode);
  });

/**
 * Live layer: disabled (typed failure on use) when the flag is "off";
 * otherwise opens `control-plane.db` in the server state directory.
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
