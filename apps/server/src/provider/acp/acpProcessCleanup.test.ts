import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

import { killTrackedProcesses, trackAcpProcess } from "./acpProcessCleanup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readReadyLine(
  reader: readline.Interface,
  proc: ReturnType<typeof childProcess.spawn>,
): Promise<number> {
  const stderr: string[] = [];
  if (!proc.stderr) {
    throw new Error("Subprocess stderr is not available");
  }
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (data: string) => stderr.push(data));
  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ready ")) {
      return Number(trimmed.slice("ready ".length));
    }
  }
  throw new Error(`Subprocess did not report ready state. stderr: ${stderr.join("")}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describe("acpProcessCleanup", () => {
  it("kills tracked descendants after coordinated async shutdown completes", async () => {
    const fixture = path.join(__dirname, "acpProcessCleanup.subprocessTest.ts");
    const bunExe = (globalThis as unknown as { Bun?: { execPath: string } }).Bun?.execPath ?? "bun";
    const proc = childProcess.spawn(bunExe, [fixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!proc.stdout) {
      throw new Error("Subprocess stdout is not available");
    }

    const reader = readline.createInterface(proc.stdout);
    const childPid = await readReadyLine(reader, proc);
    expect(Number.isFinite(childPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    // Let NodeRuntime.runMain install its signal handlers before we SIGTERM.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const closePromise = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      proc.on("close", (code, signal) => resolve([code, signal]));
    });

    let finalizerDone = false;
    let teardownDone = false;
    const teardownPromise = new Promise<void>((resolve) => {
      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed === "finalizer done") {
          finalizerDone = true;
        } else if (trimmed === "teardown done") {
          teardownDone = true;
          resolve();
        }
      });
      reader.on("close", () => resolve());
    });

    proc.kill("SIGTERM");

    await teardownPromise;
    expect(finalizerDone).toBe(true);
    expect(teardownDone).toBe(true);

    const [code] = await closePromise;
    expect(code).not.toBeNull();

    reader.close();

    expect(await waitUntilDead(childPid, 2000)).toBe(true);
  });

  describe("killTrackedProcesses platform branches", () => {
    const originalPlatform = process.platform;
    let execSyncMock: ReturnType<typeof vi.fn>;
    let processKillSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      execSyncMock = vi.fn().mockImplementation(() => Buffer.from(""));
      processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock("node:child_process");
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    async function loadCleanupModule() {
      vi.resetModules();
      return import("./acpProcessCleanup");
    }

    it("uses taskkill /T and /F on Windows", async () => {
      vi.doMock("node:child_process", async () => ({
        ...(await import("node:child_process")),
        execSync: execSyncMock,
      }));
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      const { trackAcpProcess: track, killTrackedProcesses: kill } = await loadCleanupModule();

      track(12345);
      kill();

      expect(execSyncMock).toHaveBeenCalledWith("taskkill /T /PID 12345", {
        stdio: "ignore",
        timeout: 500,
      });
      expect(execSyncMock).toHaveBeenCalledWith("taskkill /F /T /PID 12345", {
        stdio: "ignore",
        timeout: 500,
      });
      expect(processKillSpy).not.toHaveBeenCalled();
    });

    it("uses SIGTERM, pkill, then SIGKILL on POSIX", async () => {
      vi.doMock("node:child_process", async () => ({
        ...(await import("node:child_process")),
        execSync: execSyncMock,
      }));

      const { trackAcpProcess: track, killTrackedProcesses: kill } = await loadCleanupModule();

      track(12345);
      kill();

      expect(processKillSpy).toHaveBeenCalledWith(12345, "SIGTERM");
      expect(processKillSpy).toHaveBeenCalledWith(12345, "SIGKILL");
      expect(execSyncMock).toHaveBeenCalledWith("pkill -TERM -P 12345 2>/dev/null || true", {
        stdio: "ignore",
        timeout: 500,
      });
      expect(execSyncMock).not.toHaveBeenCalledWith(
        expect.stringContaining("taskkill"),
        expect.anything(),
      );
    });

    it("does not throw when processes are already gone", async () => {
      vi.doMock("node:child_process", async () => ({
        ...(await import("node:child_process")),
        execSync: execSyncMock,
      }));
      execSyncMock.mockImplementation(() => {
        throw new Error("failed");
      });
      processKillSpy.mockImplementation(() => {
        throw new Error("ESRCH");
      });

      const { trackAcpProcess: track, killTrackedProcesses: kill } = await loadCleanupModule();

      track(12345);
      expect(() => kill()).not.toThrow();
    });
  });
});
