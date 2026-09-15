import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureAntigravityStatusline,
  parseAntigravityStatusline,
  readAntigravityStatusline,
  storeAntigravityStatusline,
} from "../antigravityStatusline";
import { antigravityUsageFetcher } from "./antigravity";

const NOW_MS = Date.parse("2026-09-15T12:00:00.000Z");
const tempDirs: string[] = [];

function makeContext(homeDir: string, stateDir: string) {
  return {
    homeDir,
    stateDir,
    env: {},
    platform: "linux" as const,
    nowMs: NOW_MS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseAntigravityStatusline", () => {
  it("normalizes documented snake-case quota maps", () => {
    const snapshot = parseAntigravityStatusline(
      {
        plan_tier: "google_ai_pro",
        quota: {
          "gemini-2.5-pro": {
            remaining_fraction: 0.4,
            reset_time: "2026-09-16T00:00:00Z",
          },
          "gemini-2.5-flash": {
            remaining_fraction: 0.8,
          },
        },
      },
      { nowMs: NOW_MS },
    );

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Google Ai Pro");
    expect(snapshot.limits).toEqual([
      {
        window: "Pro",
        usedPercent: 60,
        resetsAt: "2026-09-16T00:00:00.000Z",
      },
      { window: "Flash", usedPercent: 20 },
    ]);
  });

  it("accepts bucket arrays and reports missing quota windows", () => {
    expect(
      parseAntigravityStatusline(
        { quota: { buckets: [{ modelId: "gemini-pro", remainingFraction: 0.5 }] } },
        { nowMs: NOW_MS },
      ).limits,
    ).toEqual([{ window: "Pro", usedPercent: 50 }]);
    expect(parseAntigravityStatusline({ quota: {} }, { nowMs: NOW_MS }).status).toBe("error");
  });

  it("rejects malformed and partial status-line payloads without throwing", async () => {
    const stateDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-statusline-"));
    tempDirs.push(stateDir);
    await expect(readAntigravityStatusline(stateDir, NOW_MS)).resolves.toBeNull();
    expect(parseAntigravityStatusline({ model: "missing-quota" }, { nowMs: NOW_MS }).status).toBe(
      "error",
    );
  });

  it("marks old status-line data stale without changing its update time", () => {
    const snapshot = parseAntigravityStatusline(
      { quota: { pro: { remaining_fraction: 0.5 } } },
      { nowMs: NOW_MS, receivedAtMs: NOW_MS - 16 * 60 * 1000 },
    );
    expect(snapshot.stale).toBe(true);
    expect(snapshot.updatedAt).toBe(new Date(NOW_MS - 16 * 60 * 1000).toISOString());
  });
});

describe("Antigravity status-line bridge", () => {
  it("writes and reads successive status-line updates", async () => {
    const stateDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-statusline-"));
    tempDirs.push(stateDir);
    await storeAntigravityStatusline(
      stateDir,
      { quota: { pro: { remaining_fraction: 0.75 } } },
      NOW_MS,
    );
    await storeAntigravityStatusline(
      stateDir,
      { quota: { pro: { remaining_fraction: 0.25 } } },
      NOW_MS + 1_000,
    );

    const snapshot = await readAntigravityStatusline(stateDir, NOW_MS + 1_000);
    expect(snapshot?.limits[0]?.usedPercent).toBe(75);
    expect(
      JSON.parse(
        readFileSync(
          nodePath.join(stateDir, "provider-usage", "antigravity-statusline.json"),
          "utf8",
        ),
      ),
    ).toHaveProperty("payload");
  });

  it("does not overwrite a user's custom status-line command", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-home-"));
    const stateDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-state-"));
    tempDirs.push(homeDir, stateDir);
    const settingsPath = nodePath.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(nodePath.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "my-status" } }),
    );

    const result = await ensureAntigravityStatusline(makeContext(homeDir, stateDir));
    expect(result.configured).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toContain("my-status");
  });

  it("adds its receiver without replacing unrelated Antigravity settings", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-home-"));
    const stateDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-state-"));
    tempDirs.push(homeDir, stateDir);
    const settingsPath = nodePath.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(nodePath.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: "gemini-pro", permissions: { mode: "ask" } }),
    );

    const result = await ensureAntigravityStatusline(makeContext(homeDir, stateDir));
    expect(result.configured).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(settings.model).toBe("gemini-pro");
    expect(settings.permissions).toEqual({ mode: "ask" });
    expect(settings.statusLine).toMatchObject({ type: "command" });
  });

  it("uses only status-line state and never reads credential files", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-home-"));
    const stateDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-state-"));
    tempDirs.push(homeDir, stateDir);
    const snapshot = await antigravityUsageFetcher.fetch(makeContext(homeDir, stateDir));
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.source).toBe("antigravity-cli-statusline");
  });
});
