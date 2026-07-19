// FILE: acpProcessCleanup.ts
// Purpose: Track ACP child PIDs and expose synchronous cleanup so the
// application's shutdown owner (NodeRuntime.runMain teardown) can terminate
// descendants before the process exits.
// Layer: Provider ACP runtime

import { execSync } from "node:child_process";

const trackedPids = new Set<number>();

export function killTrackedProcesses(): void {
  const pids = [...trackedPids];
  trackedPids.clear();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // process may already be gone
    }
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
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process may already be gone
    }
  }
}

export function trackAcpProcess(pid: number): void {
  trackedPids.add(pid);
}

export function untrackAcpProcess(pid: number): void {
  trackedPids.delete(pid);
}
