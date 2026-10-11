import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { didProcessFailToSpawn } from "./processSpawnOutcome";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

/** The daemon owns POSIX groups, including descendants after the leader exits. */
export async function terminateOwnedPosixProcessGroup(
  child: ChildProcess,
  graceMs: number,
): Promise<void> {
  if (didProcessFailToSpawn(child)) return;
  if (process.platform === "win32")
    throw new Error("Owned POSIX process groups require a POSIX host");
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Cannot verify provider exit without an owned process PID");
  }
  let rootExited = child.exitCode !== null || child.signalCode !== null;
  const onExit = () => {
    rootExited = true;
  };
  child.once("exit", onExit);
  try {
    signalGroup(pid, "SIGTERM");
    const forceAt = Date.now() + graceMs;
    const deadline = forceAt + 2_000;
    let forced = false;
    for (;;) {
      const exists = groupExists(pid);
      if (rootExited && !exists) return;
      if (Date.now() >= deadline) throw new Error(`Provider process group ${pid} exit is unproven`);
      if (!forced && Date.now() >= forceAt) {
        if (exists) signalGroup(pid, "SIGKILL");
        forced = true;
      }
      await delay(25);
    }
  } finally {
    child.removeListener("exit", onExit);
  }
}
