// FILE: acpProcessCleanup.ts
// Purpose: Track ACP child PIDs and expose synchronous cleanup so the
// application's shutdown owner (NodeRuntime.runMain teardown) can terminate
// descendants before the process exits.
// Layer: Provider ACP runtime

import { execSync } from "node:child_process";

const isWindows = process.platform === "win32";

const trackedPids = new Set<number>();

function killProcessTree(pid: number, force: boolean): void {
  if (isWindows) {
    try {
      // /T terminates the process and any child processes started by it.
      execSync(`taskkill ${force ? "/F " : ""}/T /PID ${pid}`, {
        stdio: "ignore",
        timeout: 500,
      });
    } catch {
      // process may already be gone, or taskkill is unavailable.
    }
    return;
  }

  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // process may already be gone
  }
  if (!force) {
    try {
      // Best-effort synchronous cleanup of any immediate children so they
      // are not reparented to init when the parent exits.
      execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`, {
        stdio: "ignore",
        timeout: 500,
      });
    } catch {
      // ignore
    }
  }
}

export function killTrackedProcesses(): void {
  const pids = [...trackedPids];
  trackedPids.clear();
  for (const pid of pids) {
    killProcessTree(pid, false);
    killProcessTree(pid, true);
  }
}

export function trackAcpProcess(pid: number): void {
  trackedPids.add(pid);
}

export function untrackAcpProcess(pid: number): void {
  trackedPids.delete(pid);
}
