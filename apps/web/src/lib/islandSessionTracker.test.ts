import { describe, expect, it } from "vitest";
import type { OrchestrationThreadShell } from "@synara/contracts";

import {
  aggregateIslandStatus,
  classifyIslandStatus,
  createShellThreadStore,
  deriveIslandSessions,
  findPopTransition,
  ISLAND_DONE_RETENTION_MS,
  islandRelativeTime,
  type IslandSession,
} from "./islandSessionTracker";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");

type LatestTurn = NonNullable<OrchestrationThreadShell["latestTurn"]>;

function makeTurn(
  state: LatestTurn["state"],
  overrides: Partial<Record<"requestedAt" | "startedAt" | "completedAt", string | null>> = {},
): LatestTurn {
  return {
    turnId: "turn-1",
    state,
    requestedAt: "2026-07-20T11:58:00.000Z",
    startedAt: "2026-07-20T11:58:01.000Z",
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  } as LatestTurn;
}

function makeThread(
  overrides: Partial<Record<keyof OrchestrationThreadShell, unknown>> = {},
): OrchestrationThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix flaky test",
    modelSelection: { provider: "codex", model: "gpt-5" },
    latestTurn: makeTurn("running"),
    archivedAt: null,
    updatedAt: "2026-07-20T11:58:01.000Z",
    ...overrides,
  } as OrchestrationThreadShell;
}

function makeSession(overrides: Partial<IslandSession> = {}): IslandSession {
  return {
    threadId: "thread-1",
    title: "Fix flaky test",
    provider: "codex",
    status: "working",
    lastActivityAt: "2026-07-20T11:58:01.000Z",
    ...overrides,
  };
}

describe("classifyIslandStatus", () => {
  it("classifies running turns as working", () => {
    expect(classifyIslandStatus(makeThread())).toBe("working");
  });

  it("prioritizes pending approvals over the turn state", () => {
    expect(classifyIslandStatus(makeThread({ hasPendingApprovals: true }))).toBe("needs-approval");
    expect(classifyIslandStatus(makeThread({ hasPendingUserInput: true }))).toBe("needs-approval");
    expect(classifyIslandStatus(makeThread({ hasActionableProposedPlan: true }))).toBe(
      "needs-approval",
    );
  });

  it("classifies completed turns as done", () => {
    const thread = makeThread({
      latestTurn: makeTurn("completed", { completedAt: "2026-07-20T11:55:00.000Z" }),
    });
    expect(classifyIslandStatus(thread)).toBe("done");
  });

  it("ignores archived, idle, interrupted, and errored threads", () => {
    expect(classifyIslandStatus(makeThread({ archivedAt: "2026-07-20T10:00:00.000Z" }))).toBeNull();
    expect(classifyIslandStatus(makeThread({ latestTurn: null }))).toBeNull();
    for (const state of ["interrupted", "error"] as const) {
      const thread = makeThread({ latestTurn: makeTurn(state, { startedAt: null }) });
      expect(classifyIslandStatus(thread)).toBeNull();
    }
  });
});

describe("deriveIslandSessions", () => {
  it("orders needs-approval first, then working, then done", () => {
    const sessions = deriveIslandSessions(
      [
        makeThread({
          id: "done",
          latestTurn: makeTurn("completed", { completedAt: "2026-07-20T11:55:00.000Z" }),
        }),
        makeThread({ id: "working" }),
        makeThread({ id: "approval", hasPendingApprovals: true }),
      ],
      NOW,
    );
    expect(sessions.map((session) => session.threadId)).toEqual(["approval", "working", "done"]);
  });

  it("drops done sessions older than the retention window", () => {
    const staleCompletedAt = new Date(NOW - ISLAND_DONE_RETENTION_MS - 1000).toISOString();
    const sessions = deriveIslandSessions(
      [
        makeThread({
          latestTurn: makeTurn("completed", {
            requestedAt: staleCompletedAt,
            startedAt: staleCompletedAt,
            completedAt: staleCompletedAt,
          }),
        }),
      ],
      NOW,
    );
    expect(sessions).toEqual([]);
  });
});

describe("aggregateIslandStatus", () => {
  it("returns the most urgent status", () => {
    expect(aggregateIslandStatus([])).toBeNull();
    expect(aggregateIslandStatus([makeSession({ status: "done" })])).toBe("done");
    expect(
      aggregateIslandStatus([
        makeSession({ status: "done" }),
        makeSession({ status: "working", threadId: "b" }),
      ]),
    ).toBe("working");
    expect(
      aggregateIslandStatus([
        makeSession({ status: "working" }),
        makeSession({ status: "needs-approval", threadId: "b" }),
      ]),
    ).toBe("needs-approval");
  });
});

describe("findPopTransition", () => {
  it("pops on a session newly needing approval", () => {
    expect(
      findPopTransition(
        [makeSession({ status: "working" })],
        [makeSession({ status: "needs-approval" })],
      ),
    ).toBe("needs-approval");
  });

  it("pops on a working session completing", () => {
    expect(
      findPopTransition([makeSession({ status: "working" })], [makeSession({ status: "done" })]),
    ).toBe("turn-completed");
  });

  it("stays quiet without a transition", () => {
    expect(findPopTransition([], [makeSession({ status: "working" })])).toBeNull();
    expect(
      findPopTransition(
        [makeSession({ status: "needs-approval" })],
        [makeSession({ status: "needs-approval" })],
      ),
    ).toBeNull();
    // A session that appears already-done (e.g. initial snapshot) must not pop.
    expect(findPopTransition([], [makeSession({ status: "done" })])).toBeNull();
  });

  it("does not pop for needs-approval sessions with no previous entry", () => {
    expect(findPopTransition([], [makeSession({ status: "needs-approval" })])).toBeNull();
  });
});

describe("createShellThreadStore", () => {
  it("replays events buffered between subscribe and the snapshot response", () => {
    const store = createShellThreadStore();
    const early = makeThread({ id: "early" });
    expect(store.handleStreamItem({ kind: "thread-upserted", sequence: 1, thread: early })).toBe(
      false,
    );
    expect(store.threads()).toEqual([]);
    expect(store.applySnapshot([makeThread({ id: "snapshot" })])).toBe(true);
    expect(store.threads().map((thread) => thread.id)).toEqual(["snapshot", "early"]);
  });

  it("drops buffered removals of snapshot threads on replay", () => {
    const store = createShellThreadStore();
    store.handleStreamItem({ kind: "thread-removed", sequence: 1, threadId: "gone" });
    store.applySnapshot([makeThread({ id: "gone" }), makeThread({ id: "kept" })]);
    expect(store.threads().map((thread) => thread.id)).toEqual(["kept"]);
  });

  it("ignores a fetched snapshot that arrives after a streamed snapshot", () => {
    const store = createShellThreadStore();
    expect(
      store.handleStreamItem({
        kind: "snapshot",
        snapshot: { sequence: 2, threads: [makeThread({ id: "streamed" })] },
      } as Parameters<typeof store.handleStreamItem>[0]),
    ).toBe(true);
    expect(store.applySnapshot([makeThread({ id: "stale" })])).toBe(false);
    expect(store.threads().map((thread) => thread.id)).toEqual(["streamed"]);
  });

  it("applies events directly once the snapshot has landed", () => {
    const store = createShellThreadStore();
    store.applySnapshot([]);
    expect(
      store.handleStreamItem({ kind: "thread-upserted", sequence: 1, thread: makeThread() }),
    ).toBe(true);
    expect(store.threads()).toHaveLength(1);
    expect(
      store.handleStreamItem({ kind: "thread-removed", sequence: 2, threadId: "thread-1" }),
    ).toBe(true);
    expect(store.threads()).toEqual([]);
  });
});

describe("islandRelativeTime", () => {
  it("formats compact relative times", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(islandRelativeTime("2026-01-01T11:59:40Z", now)).toBe("now");
    expect(islandRelativeTime("2026-01-01T11:58:00Z", now)).toBe("2m");
    expect(islandRelativeTime("2026-01-01T09:00:00Z", now)).toBe("3h");
    expect(islandRelativeTime("2025-12-30T12:00:00Z", now)).toBe("2d");
    expect(islandRelativeTime("not-a-date", now)).toBe("now");
  });
});
