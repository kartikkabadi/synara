// FILE: RemoteAgentReconnector.ts
// Purpose: Reconnect loop for remote agent threads (#99 PR V). When a
//          transport disconnect is signalled, the thread is marked degraded
//          and reattach attempts are scheduled with exponential backoff
//          (1s, 2s, 4s, 8s, ... capped at 30s). The caller supplies the
//          install/reattach closures; this class only owns per-thread state,
//          scheduling, and cancellation.

import type {
  ExecutionEnvironmentConnectionStatus,
  RemoteAgentConnectionStatus,
} from "@synara/contracts";

import { RemoteAgentReconnectFailedError } from "../RemoteEnvironmentErrors";

export interface RemoteAgentStatusChange {
  readonly status: RemoteAgentConnectionStatus;
  readonly retryCount: number;
  readonly message?: string;
}

export interface RemoteAgentReconnectState {
  readonly status: ExecutionEnvironmentConnectionStatus;
  readonly attempt: number;
}

export interface RemoteAgentReconnectorOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

export interface RemoteAgentReconnectRequest {
  readonly threadId: string;
  /** Exit code of the dead transport, used when retries are exhausted. */
  readonly disconnectCode: number;
  /** Idempotent agent binary bootstrap, run before each reattach attempt. */
  readonly ensureInstalled: () => Promise<void>;
  /** Opens a fresh transport, rebinds the proxy, and sends agent/attach. */
  readonly reattach: () => Promise<void>;
  /** True once the thread exited or was killed; stops the loop. */
  readonly isSettled: () => boolean;
  /** Called when all attempts failed; the caller finalizes the thread. */
  readonly onExhausted: (error: RemoteAgentReconnectFailedError) => void;
  /** Observes client-facing status transitions of the reconnect loop. */
  readonly onStatusChange?: (change: RemoteAgentStatusChange) => void;
}

interface ThreadState {
  status: ExecutionEnvironmentConnectionStatus;
  attempt: number;
  active: boolean;
  cancelled: boolean;
  wake: (() => void) | undefined;
  timer: NodeJS.Timeout | undefined;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;

export class RemoteAgentReconnector {
  private readonly threads = new Map<string, ThreadState>();
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;

  constructor(options: RemoteAgentReconnectorOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  stateFor(threadId: string): RemoteAgentReconnectState | undefined {
    const state = this.threads.get(threadId);
    return state === undefined ? undefined : { status: state.status, attempt: state.attempt };
  }

  /** Starts the backoff loop for a disconnected thread (one loop per thread). */
  scheduleReconnect(request: RemoteAgentReconnectRequest): void {
    const existing = this.threads.get(request.threadId);
    if (existing?.active === true || request.isSettled()) return;
    const state: ThreadState = {
      status: "degraded",
      attempt: 0,
      active: true,
      cancelled: false,
      wake: undefined,
      timer: undefined,
    };
    this.threads.set(request.threadId, state);
    request.onStatusChange?.({
      status: "degraded",
      retryCount: 0,
      message: "transport disconnected",
    });
    void this.runLoop(request, state);
  }

  /** Marks the thread exited and stops any pending retries. */
  finalize(threadId: string): void {
    this.stop(threadId, "disconnected");
  }

  /** Cancels pending retries (user kill). */
  cancel(threadId: string): void {
    this.stop(threadId, "disconnected");
  }

  private stop(threadId: string, status: ExecutionEnvironmentConnectionStatus): void {
    const state = this.threads.get(threadId);
    if (state === undefined) return;
    state.cancelled = true;
    state.status = status;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    state.wake?.();
  }

  private async runLoop(request: RemoteAgentReconnectRequest, state: ThreadState): Promise<void> {
    let lastReason = "transport disconnected";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
      await this.sleep(state, delay);
      if (state.cancelled || request.isSettled()) {
        state.active = false;
        return;
      }
      state.attempt = attempt;
      state.status = "connecting";
      request.onStatusChange?.({ status: "reconnecting", retryCount: attempt });
      try {
        await request.ensureInstalled();
        await request.reattach();
        state.status = "connected";
        state.active = false;
        request.onStatusChange?.({ status: "connected", retryCount: attempt });
        return;
      } catch (cause) {
        lastReason = cause instanceof Error ? cause.message : String(cause);
        state.status = "degraded";
        request.onStatusChange?.({ status: "degraded", retryCount: attempt, message: lastReason });
      }
    }
    state.active = false;
    if (state.cancelled || request.isSettled()) return;
    state.status = "error";
    request.onStatusChange?.({
      status: "disconnected",
      retryCount: this.maxAttempts,
      message: lastReason,
    });
    request.onExhausted(
      new RemoteAgentReconnectFailedError({
        threadId: request.threadId,
        attempts: this.maxAttempts,
        reason: lastReason,
      }),
    );
  }

  private sleep(state: ThreadState, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      state.wake = () => {
        state.wake = undefined;
        resolve();
      };
      state.timer = setTimeout(() => {
        state.timer = undefined;
        state.wake = undefined;
        resolve();
      }, delayMs);
    });
  }
}
