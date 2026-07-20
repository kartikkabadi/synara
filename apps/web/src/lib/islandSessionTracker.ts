// FILE: islandSessionTracker.ts
// Purpose: Derives island session rows and aggregate status from orchestration shell threads.
// Layer: Web island logic (pure)

import type { OrchestrationThreadShell } from "@synara/contracts";

export type IslandSessionStatus = "working" | "needs-approval" | "done";

export interface IslandSession {
  threadId: string;
  title: string;
  provider: string;
  status: IslandSessionStatus;
  lastActivityAt: string;
}

// Completed sessions stay listed briefly so "done" is glanceable, then drop off.
export const ISLAND_DONE_RETENTION_MS = 30 * 60 * 1000;

const STATUS_PRIORITY: Record<IslandSessionStatus, number> = {
  "needs-approval": 0,
  working: 1,
  done: 2,
};

export function classifyIslandStatus(thread: OrchestrationThreadShell): IslandSessionStatus | null {
  if (thread.archivedAt) return null;
  if (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    thread.hasActionableProposedPlan === true
  ) {
    return "needs-approval";
  }
  const turn = thread.latestTurn;
  if (!turn) return null;
  if (turn.state === "running") return "working";
  if (turn.state === "completed") return "done";
  return null;
}

export function deriveIslandSessions(
  threads: readonly OrchestrationThreadShell[],
  nowMs: number,
): IslandSession[] {
  const sessions: IslandSession[] = [];
  for (const thread of threads) {
    const status = classifyIslandStatus(thread);
    if (!status) continue;
    const lastActivityAt =
      thread.latestTurn?.completedAt ??
      thread.latestTurn?.startedAt ??
      thread.latestTurn?.requestedAt ??
      thread.updatedAt;
    if (status === "done") {
      const completedAtMs = Date.parse(lastActivityAt);
      if (Number.isFinite(completedAtMs) && nowMs - completedAtMs > ISLAND_DONE_RETENTION_MS) {
        continue;
      }
    }
    sessions.push({
      threadId: thread.id,
      title: thread.title,
      provider: thread.modelSelection.provider,
      status,
      lastActivityAt,
    });
  }
  return sessions.toSorted(
    (left, right) =>
      STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
      Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
  );
}

export function aggregateIslandStatus(
  sessions: readonly IslandSession[],
): IslandSessionStatus | null {
  let aggregate: IslandSessionStatus | null = null;
  for (const session of sessions) {
    if (!aggregate || STATUS_PRIORITY[session.status] < STATUS_PRIORITY[aggregate]) {
      aggregate = session.status;
    }
  }
  return aggregate;
}

// Detects transitions that should auto-pop the island: a session newly needing
// approval or a working session finishing its turn.
export function findPopTransition(
  previous: readonly IslandSession[],
  next: readonly IslandSession[],
): "needs-approval" | "turn-completed" | null {
  const previousByThread = new Map(previous.map((session) => [session.threadId, session.status]));
  let completed = false;
  for (const session of next) {
    const before = previousByThread.get(session.threadId);
    if (session.status === "needs-approval" && before !== "needs-approval") {
      return "needs-approval";
    }
    if (session.status === "done" && before !== undefined && before !== "done") {
      completed = true;
    }
  }
  return completed ? "turn-completed" : null;
}
