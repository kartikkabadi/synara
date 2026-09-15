import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageSnapshot } from "@synara/contracts";

import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  isoFromString,
  titleCase,
} from "./parse";
import type { ProviderUsageContext } from "./types";

export const ANTIGRAVITY_STATUSLINE_SOURCE = "antigravity-cli-statusline";
const STATUSLINE_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_QUOTA_WINDOWS = 8;

interface StoredStatusline {
  readonly receivedAtMs: number;
  readonly payload: unknown;
}

function antigravityConfigDir(ctx: ProviderUsageContext): string {
  return ctx.env.GEMINI_CONFIG_DIR?.trim() || nodePath.join(ctx.homeDir, ".gemini");
}

export function antigravitySettingsPath(ctx: ProviderUsageContext): string {
  return nodePath.join(antigravityConfigDir(ctx), "antigravity-cli", "settings.json");
}

export function antigravityStatuslinePath(stateDir: string): string {
  return nodePath.join(stateDir, "provider-usage", "antigravity-statusline.json");
}

function statuslineCommand(stateDir: string): string {
  const executable = process.argv[0] ?? process.execPath;
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return "";
  }
  const quote = (value: string): string =>
    process.platform === "win32"
      ? `"${value.replaceAll('"', '\\"')}"`
      : `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(executable)} ${quote(entrypoint)} antigravity statusline --state-dir ${quote(stateDir)}`;
}

export async function ensureAntigravityStatusline(
  ctx: ProviderUsageContext,
): Promise<
  | { readonly configured: true; readonly changed: boolean }
  | { readonly configured: false; readonly reason: string }
> {
  const stateDir = ctx.stateDir?.trim();
  if (!stateDir) {
    return { configured: false, reason: "Synara state directory is unavailable." };
  }
  const command = statuslineCommand(stateDir);
  if (!command) {
    return { configured: false, reason: "Synara CLI entrypoint is unavailable." };
  }

  const settingsPath = antigravitySettingsPath(ctx);
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    const record = asRecord(parsed);
    if (record) settings = record;
  } catch {
    // A missing settings file is normal before the first Antigravity login.
  }

  const existingStatusLine = asRecord(settings.statusLine);
  const existingCommand = asString(existingStatusLine?.command);
  if (existingCommand && existingCommand !== command) {
    return {
      configured: false,
      reason: "Antigravity already has a custom status-line command.",
    };
  }
  if (existingCommand === command) {
    return { configured: true, changed: false };
  }

  const nextSettings = {
    ...settings,
    statusLine: {
      ...(existingStatusLine ?? {}),
      type: "command",
      command,
    },
  };
  const directory = nodePath.dirname(settingsPath);
  const tempPath = nodePath.join(
    directory,
    `.${nodePath.basename(settingsPath)}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(tempPath, `${JSON.stringify(nextSettings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, settingsPath);
    return { configured: true, changed: true };
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    return { configured: false, reason: "Could not update Antigravity status-line settings." };
  }
}

function quotaLabel(key: string, value: Record<string, unknown>): string {
  const model =
    asString(value.model) ??
    asString(value.model_id) ??
    asString(value.modelId) ??
    asString(value.display_name) ??
    asString(value.displayName) ??
    key;
  const lower = model.toLowerCase();
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("flash")) return "Flash";
  return titleCase(model.replaceAll("_", " "));
}

function quotaEntries(quota: unknown): Array<[string, Record<string, unknown>]> {
  const record = asRecord(quota);
  if (!record) return [];
  if (Array.isArray(record.buckets)) {
    return record.buckets.flatMap((bucket, index) => {
      const value = asRecord(bucket);
      return value ? [[String(index), value] as [string, Record<string, unknown>]] : [];
    });
  }
  return Object.entries(record).flatMap(([key, value]) => {
    const entry = asRecord(value);
    return entry ? [[key, entry] as [string, Record<string, unknown>]] : [];
  });
}

function snapshotFromPayload(payload: unknown, nowMs: number): ServerProviderUsageSnapshot {
  const record = asRecord(payload);
  const quota = record?.quota;
  const grouped = new Map<string, ServerProviderUsageLimit>();
  for (const [key, entry] of quotaEntries(quota)) {
    const remaining = asFiniteNumber(entry.remaining_fraction ?? entry.remainingFraction);
    const usedPercent =
      remaining === undefined ? undefined : clampPercent(Math.round((1 - remaining) * 100));
    const reset = isoFromString(entry.reset_time ?? entry.resetTime);
    if (usedPercent === undefined && !reset) continue;
    const window = quotaLabel(key, entry);
    const previous = grouped.get(window);
    grouped.set(window, {
      window,
      ...(usedPercent === undefined
        ? previous?.usedPercent === undefined
          ? {}
          : { usedPercent: previous.usedPercent }
        : { usedPercent: Math.max(usedPercent, previous?.usedPercent ?? 0) }),
      ...(reset ? { resetsAt: reset } : previous?.resetsAt ? { resetsAt: previous.resetsAt } : {}),
    });
  }

  const planTier = asString(record?.plan_tier ?? record?.planTier);
  return buildSnapshot({
    provider: "antigravity",
    nowMs,
    status: "ok",
    source: ANTIGRAVITY_STATUSLINE_SOURCE,
    limits: [...grouped.values()].slice(0, MAX_QUOTA_WINDOWS),
    ...(planTier ? { planName: titleCase(planTier.replaceAll("_", " ")) } : {}),
  });
}

export function parseAntigravityStatusline(
  payload: unknown,
  input: { readonly nowMs: number; readonly receivedAtMs?: number } = { nowMs: Date.now() },
): ServerProviderUsageSnapshot {
  const receivedAtMs = input.receivedAtMs ?? input.nowMs;
  const snapshot = snapshotFromPayload(payload, receivedAtMs);
  if (snapshot.limits.length === 0) {
    return {
      ...snapshot,
      status: "error",
      detail: "Antigravity status-line data did not include quota windows.",
    };
  }
  if (input.nowMs - receivedAtMs > STATUSLINE_MAX_AGE_MS) {
    return {
      ...snapshot,
      stale: true,
      detail: "Quota data is stale; open an Antigravity session to refresh it.",
    };
  }
  return snapshot;
}

export async function readAntigravityStatusline(
  stateDir: string,
  nowMs: number,
): Promise<ServerProviderUsageSnapshot | null> {
  try {
    const stored = JSON.parse(
      await readFile(antigravityStatuslinePath(stateDir), "utf8"),
    ) as StoredStatusline;
    if (
      !stored ||
      typeof stored.receivedAtMs !== "number" ||
      !Number.isFinite(stored.receivedAtMs)
    ) {
      return null;
    }
    return parseAntigravityStatusline(stored.payload, {
      nowMs,
      receivedAtMs: stored.receivedAtMs,
    });
  } catch {
    return null;
  }
}

export async function storeAntigravityStatusline(
  stateDir: string,
  payload: unknown,
  receivedAtMs = Date.now(),
): Promise<void> {
  const path = antigravityStatuslinePath(stateDir);
  const directory = nodePath.dirname(path);
  const tempPath = nodePath.join(directory, `.${nodePath.basename(path)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({ receivedAtMs, payload } satisfies StoredStatusline)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await rename(tempPath, path);
  } catch (cause) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw cause;
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseStatuslineJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
