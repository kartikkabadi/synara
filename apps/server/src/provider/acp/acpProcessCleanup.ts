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

function onSigterm(): void {
  // Remove this listener so the re-raised signal restores the default
  // process-exit behavior after cleanup; other listeners (e.g. the runtime's
  // coordinated shutdown) are still invoked in this dispatch.
  process.removeListener("SIGTERM", onSigterm);
  killTrackedProcesses();
  process.nextTick(() => process.kill(process.pid, "SIGTERM"));
}

function onSigint(): void {
  process.removeListener("SIGINT", onSigint);
  killTrackedProcesses();
  process.nextTick(() => process.kill(process.pid, "SIGINT"));
}

function install(): void {
  if (installed) return;
  installed = true;
  // Node does not emit `exit` on SIGTERM/SIGINT, so register signal handlers
  // directly. We deliberately re-raise the signal after cleanup so we do not
  // suppress the default process-termination behavior that supervisors rely on.
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("exit", killTrackedProcesses);
}

export function trackAcpProcess(pid: number): void {
  install();
  trackedPids.add(pid);
}

export function untrackAcpProcess(pid: number): void {
  trackedPids.delete(pid);
}
