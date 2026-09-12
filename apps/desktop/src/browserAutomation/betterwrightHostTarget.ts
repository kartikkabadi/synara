import type { WebContents } from "electron";
import type { BetterWrightOptions } from "betterwright";
import { openBetterwrightConnection } from "./betterwrightConnection";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";

type HostTarget = NonNullable<BetterWrightOptions["hostTarget"]>;

type OpenedConnection = Awaited<ReturnType<typeof openBetterwrightConnection>>;

export interface SynaraHostTarget extends HostTarget {
  run: NonNullable<HostTarget["run"]>;
  /** Immediately revoke every transport this adapter vended; callers race worker shutdown. */
  revokeAll(cancel?: boolean): Promise<void>;
}

/**
 * Synara's HostTarget adapter. Browser tabs share BROWSER_SESSION_PARTITION, so
 * upstream's createElectronHostTarget cannot lease them (it requires a dedicated
 * session for its guard proxy). Each connect() vends a fresh capability
 * transport, matching the per-worker lifecycle the client drives.
 */
export function synaraHostTarget(
  contents: WebContents,
  options: {
    uploadFiles?: readonly string[] | undefined;
    cookieImport?: boolean | undefined;
    expectAgentInput?: BrowserAutomationVisibleRuntime["expectAgentInput"] | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): SynaraHostTarget {
  const connections = new Set<OpenedConnection>();
  return {
    async connect() {
      if (options.signal?.aborted) throw new Error("Browser control was interrupted.");
      const connection = await openBetterwrightConnection(
        contents,
        undefined,
        options.uploadFiles ?? [],
        options.cookieImport ?? false,
        options.expectAgentInput,
      );
      connections.add(connection);
      return {
        provider: connection.provider,
        get closed() {
          return connection.closed;
        },
        close: async () => {
          connections.delete(connection);
          await connection.close(false);
        },
      };
    },
    async run(operation) {
      if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
      const throttled = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      try {
        return await operation(options.signal);
      } finally {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled);
      }
    },
    revokeAll(cancel = true) {
      return Promise.all([...connections].map((connection) => connection.close(cancel))).then(
        () => undefined,
      );
    },
  };
}
