// FILE: acpProcessCleanup.ts
// Purpose: Ensure any ACP child processes started by AcpSessionRuntime are
// terminated when the Node process exits, even on SIGTERM/SIGINT where scope
// finalizers may not have time to complete.
// Layer: Provider ACP runtime

import { execSync } from "node:child_process";

const trackedPids = new Set<number>();
let installed = false;

function killTrackedProcesses(): void {
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
      // are not reparented to init when the parent is killed below.
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

function install(): void {
  if (installed) return;
  installed = true;
  // Node does not emit `exit` on SIGTERM/SIGINT, so register signal handlers
  // directly. Multiple listeners are allowed; this module only handles its own
  // tracked ACP children and does not call process.exit so the runtime can
  // continue its own shutdown sequence.
  process.on("SIGTERM", killTrackedProcesses);
  process.on("SIGINT", killTrackedProcesses);
  process.on("exit", killTrackedProcesses);
}

export function trackAcpProcess(pid: number): void {
  install();
  trackedPids.add(pid);
}

export function untrackAcpProcess(pid: number): void {
  trackedPids.delete(pid);
}
