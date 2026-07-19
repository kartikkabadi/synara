import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readReadyLine(
  reader: readline.Interface,
  proc: ReturnType<typeof spawn>,
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
    const proc = spawn(bunExe, [fixture], {
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
});
