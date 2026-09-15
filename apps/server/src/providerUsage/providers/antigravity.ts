import {
  ANTIGRAVITY_STATUSLINE_SOURCE,
  ensureAntigravityStatusline,
  readAntigravityStatusline,
} from "../antigravityStatusline";
import { unsupportedSnapshot } from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

function noDataSnapshot(ctx: ProviderUsageContext, detail: string) {
  return unsupportedSnapshot("antigravity", ctx.nowMs, ANTIGRAVITY_STATUSLINE_SOURCE, detail);
}

export const antigravityUsageFetcher: ProviderUsageFetcher = {
  provider: "antigravity",
  async cacheKey(ctx) {
    const stateDir = ctx.stateDir?.trim();
    if (!stateDir) return `${ctx.homeDir}:no-state`;
    return `statusline:${stateDir}`;
  },
  async fetch(ctx) {
    const stateDir = ctx.stateDir?.trim();
    if (!stateDir) {
      return noDataSnapshot(ctx, "Antigravity quota is unavailable without Synara state.");
    }

    const configuration = await ensureAntigravityStatusline(ctx);
    const snapshot = await readAntigravityStatusline(stateDir, ctx.nowMs);
    if (snapshot) return snapshot;
    if (!configuration.configured) {
      return noDataSnapshot(
        ctx,
        `${configuration.reason} Configure a compatible status-line command to share quota with Synara.`,
      );
    }
    return noDataSnapshot(
      ctx,
      "No Antigravity status-line quota has been received. Open an Antigravity session to refresh it.",
    );
  },
};
