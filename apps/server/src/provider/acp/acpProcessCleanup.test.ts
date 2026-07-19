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

describe("acpProcessCleanup", () => {
  it("terminates tracked descendants and exits on SIGTERM", async () => {
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
    reader.close();

    expect(Number.isFinite(childPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    // Give the subprocess a moment to finish installing its signal handlers.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      proc.on("close", (code, signal) => resolve([code, signal]));
      proc.kill("SIGTERM");
    });

    expect(signal).toBe("SIGTERM");
    expect(code).toBeNull();
    expect(isAlive(childPid)).toBe(false);
  });
});
