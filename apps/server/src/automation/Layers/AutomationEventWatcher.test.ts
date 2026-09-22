// FILE: AutomationEventWatcher.test.ts
// Purpose: Verifies the event watcher seeds a repository inbox on first poll,
// then dispatches runEvent only for newly seen items that pass trigger filters.
// Layer: Automation event watcher test
// Depends on: makeAutomationEventWatcherLive with in-memory fakes.

import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  ProjectId,
  type AutomationDefinition,
  type AutomationEventRunContext,
} from "@synara/contracts";
import { Duration, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { GitCore } from "../../git/Services/GitCore.ts";
import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import type {
  GitHubCliShape,
  GitHubIssueListItem,
  GitHubPullRequestListItem,
} from "../../git/Services/GitHubCli.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import type { AutomationRepositoryShape } from "../../persistence/Services/AutomationRepository.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import type { AutomationServiceShape } from "../Services/AutomationService.ts";
import { AutomationEventWatcher } from "../Services/AutomationEventWatcher.ts";
import { makeAutomationEventWatcherLive } from "./AutomationEventWatcher.ts";

const AUTOMATION_ID = AutomationId.makeUnsafe("automation-watcher");
const PROJECT_ID = ProjectId.makeUnsafe("project-watcher");

function makePr(number: number, isDraft = false): GitHubPullRequestListItem {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: { login: "octocat", avatarUrl: null, name: null, url: null },
    headBranch: `pr-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft,
    additions: 1,
    deletions: 0,
    createdAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z",
    reviewDecision: null,
    reviewRequestLogins: [],
    labels: [],
    mergeability: "mergeable",
    stack: null,
  };
}

function makeIssue(number: number): GitHubIssueListItem {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: { login: "hubot", avatarUrl: null, name: null, url: null },
    state: "open",
    createdAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z",
    labels: [],
  };
}

function makeSeenEventStore() {
  const seen = new Map<string, Set<string>>();
  return {
    seen,
    repository: {
      hasAutomationSeenEventsForRepository: ({
        source,
        repository,
      }: {
        source: string;
        repository: string;
      }) => Effect.succeed((seen.get(`${source}:${repository}`)?.size ?? 0) > 0),
      listAutomationSeenEventKeys: ({
        source,
        repository,
      }: {
        source: string;
        repository: string;
      }) => Effect.succeed([...(seen.get(`${source}:${repository}`) ?? new Set<string>())]),
      insertAutomationSeenEvents: ({
        events,
      }: {
        events: ReadonlyArray<{
          eventKey: string;
          source: string;
          repository: string;
          seenAt: string;
        }>;
      }) =>
        Effect.sync(() => {
          for (const event of events) {
            const key = `${event.source}:${event.repository}`;
            const bucket = seen.get(key) ?? new Set<string>();
            bucket.add(event.eventKey);
            seen.set(key, bucket);
          }
        }),
    } as unknown as AutomationRepositoryShape,
  };
}

it.effect("seeds on first poll, then fires runEvent only for new matching items", () =>
  Effect.gen(function* () {
    const pullRequests: GitHubPullRequestListItem[] = [makePr(1)];
    const issues: GitHubIssueListItem[] = [];
    const dispatched: Array<{ automationId: string; event: AutomationEventRunContext }> = [];

    const definition = {
      id: AUTOMATION_ID,
      projectId: PROJECT_ID,
      eventTriggers: [
        {
          id: "trigger-prs",
          source: "github",
          event: "pull_request_opened",
          repositories: ["acme/widgets"],
        },
        {
          id: "trigger-issues",
          source: "github",
          event: "issue_opened",
          repositories: ["acme/widgets"],
        },
      ],
    } as unknown as AutomationDefinition;

    const automationService = {
      listEventTriggeredDefinitions: () => Effect.succeed([definition]),
      runEvent: (input: { automationId: AutomationId; event: AutomationEventRunContext }) =>
        Effect.sync(() => {
          dispatched.push({ automationId: input.automationId, event: input.event });
          return { status: "dispatched", run: {} as never };
        }),
    } as unknown as AutomationServiceShape;

    const { repository: automationRepository, seen } = makeSeenEventStore();

    const github = {
      getViewerLogin: () => Effect.succeed("octocat"),
      listRepositoryPullRequests: () =>
        Effect.succeed({ entries: pullRequests, rawCount: pullRequests.length }),
      listRepositoryIssues: () => Effect.succeed(issues),
    } as unknown as GitHubCliShape;

    // A workspace with no readable git config resolves no extra repositories;
    // explicit trigger repositories carry the watch list.
    const git = {
      execute: () => Effect.succeed({ code: 1, stdout: "", stderr: "not a repository" }),
    } as unknown as GitCoreShape;

    const projectionQuery = {
      getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" })),
    } as unknown as ProjectionSnapshotQueryShape;

    const layer = makeAutomationEventWatcherLive({ intervalMs: 60_000 }).pipe(
      Layer.provide(Layer.succeed(AutomationService, automationService)),
      Layer.provide(Layer.succeed(AutomationRepository, automationRepository)),
      Layer.provide(Layer.succeed(GitHubCli, github)),
      Layer.provide(Layer.succeed(GitCore, git)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projectionQuery)),
    );

    yield* Effect.gen(function* () {
      const watcher = yield* AutomationEventWatcher;
      yield* watcher.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      // First poll: existing PR#1 is seeded, never dispatched.
      assert.lengthOf(dispatched, 0);
      const seenKeys = seen.get("github:acme/widgets");
      assert.isTrue(seenKeys?.has("github:seed:acme/widgets") ?? false);
      assert.isTrue(seenKeys?.has("github:pr:acme/widgets:1") ?? false);

      // Second poll: a new PR and a new issue each fire exactly once.
      pullRequests.push(makePr(2));
      issues.push(makeIssue(7));
      yield* TestClock.adjust(Duration.seconds(61));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepStrictEqual(dispatched.map(({ event }) => event.key).sort(), [
        "github:issue:acme/widgets:7",
        "github:pr:acme/widgets:2",
      ]);
      assert.isTrue(dispatched.every(({ automationId }) => automationId === AUTOMATION_ID));
      const prEvent = dispatched.find(
        ({ event }) => event.key === "github:pr:acme/widgets:2",
      )?.event;
      assert.strictEqual(prEvent?.event, "pull_request_opened");
      assert.strictEqual(prEvent?.title, "PR 2");
      assert.strictEqual(prEvent?.repository, "acme/widgets");

      // Third poll: nothing new — no additional dispatches.
      yield* TestClock.adjust(Duration.seconds(61));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.lengthOf(dispatched, 2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

it.effect("routes drafts to draft_opened and applies branch filters", () =>
  Effect.gen(function* () {
    const pullRequests: GitHubPullRequestListItem[] = [];
    const dispatched: AutomationEventRunContext[] = [];

    const definition = {
      id: AUTOMATION_ID,
      projectId: PROJECT_ID,
      eventTriggers: [
        {
          id: "trigger-drafts",
          source: "github",
          event: "draft_opened",
          repositories: ["acme/widgets"],
          branch: "release",
        },
        {
          id: "trigger-release-prs",
          source: "github",
          event: "pull_request_opened",
          repositories: ["acme/widgets"],
          branch: "release",
        },
      ],
    } as unknown as AutomationDefinition;

    const automationService = {
      listEventTriggeredDefinitions: () => Effect.succeed([definition]),
      runEvent: (input: { event: AutomationEventRunContext }) =>
        Effect.sync(() => {
          dispatched.push(input.event);
          return { status: "dispatched", run: {} as never };
        }),
    } as unknown as AutomationServiceShape;

    const { repository: automationRepository } = makeSeenEventStore();
    const github = {
      getViewerLogin: () => Effect.succeed("octocat"),
      listRepositoryPullRequests: () =>
        Effect.succeed({ entries: pullRequests, rawCount: pullRequests.length }),
      listRepositoryIssues: () => Effect.succeed([]),
    } as unknown as GitHubCliShape;
    const git = {
      execute: () => Effect.succeed({ code: 1, stdout: "", stderr: "not a repository" }),
    } as unknown as GitCoreShape;
    const projectionQuery = {
      getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" })),
    } as unknown as ProjectionSnapshotQueryShape;

    const layer = makeAutomationEventWatcherLive({ intervalMs: 60_000 }).pipe(
      Layer.provide(Layer.succeed(AutomationService, automationService)),
      Layer.provide(Layer.succeed(AutomationRepository, automationRepository)),
      Layer.provide(Layer.succeed(GitHubCli, github)),
      Layer.provide(Layer.succeed(GitCore, git)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projectionQuery)),
    );

    yield* Effect.gen(function* () {
      const watcher = yield* AutomationEventWatcher;
      yield* watcher.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      // A draft PR targeting release matches draft_opened; non-draft PRs targeting
      // main match neither trigger (both filter to base release).
      pullRequests.push({ ...makePr(11, true), baseBranch: "release" });
      pullRequests.push(makePr(10));
      pullRequests.push(makePr(12));
      yield* TestClock.adjust(Duration.seconds(61));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepStrictEqual(
        dispatched.map((event) => `${event.event}:${event.itemNumber}`),
        ["draft_opened:11"],
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

it.effect("leaves retried events unseen and redispatches them on the next poll", () =>
  Effect.gen(function* () {
    const pullRequests: GitHubPullRequestListItem[] = [makePr(1)];
    const dispatched: AutomationEventRunContext[] = [];
    let retrying = true;

    const definition = {
      id: AUTOMATION_ID,
      projectId: PROJECT_ID,
      eventTriggers: [
        {
          id: "trigger-prs",
          source: "github",
          event: "pull_request_opened",
          repositories: ["acme/widgets"],
        },
      ],
    } as unknown as AutomationDefinition;

    const automationService = {
      listEventTriggeredDefinitions: () => Effect.succeed([definition]),
      runEvent: (input: { event: AutomationEventRunContext }) =>
        Effect.sync(() => {
          dispatched.push(input.event);
          return retrying
            ? { status: "retry", reason: "provider disabled" }
            : { status: "dispatched", run: {} as never };
        }),
    } as unknown as AutomationServiceShape;

    const { repository: automationRepository, seen } = makeSeenEventStore();
    const github = {
      getViewerLogin: () => Effect.succeed("octocat"),
      listRepositoryPullRequests: () =>
        Effect.succeed({ entries: pullRequests, rawCount: pullRequests.length }),
      listRepositoryIssues: () => Effect.succeed([]),
    } as unknown as GitHubCliShape;
    const git = {
      execute: () => Effect.succeed({ code: 1, stdout: "", stderr: "not a repository" }),
    } as unknown as GitCoreShape;
    const projectionQuery = {
      getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" })),
    } as unknown as ProjectionSnapshotQueryShape;

    const layer = makeAutomationEventWatcherLive({ intervalMs: 60_000 }).pipe(
      Layer.provide(Layer.succeed(AutomationService, automationService)),
      Layer.provide(Layer.succeed(AutomationRepository, automationRepository)),
      Layer.provide(Layer.succeed(GitHubCli, github)),
      Layer.provide(Layer.succeed(GitCore, git)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projectionQuery)),
    );

    yield* Effect.gen(function* () {
      const watcher = yield* AutomationEventWatcher;
      yield* watcher.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      // First poll seeds PR#1. Second poll sees PR#2 but the dispatch is retried:
      // the event stays unseen and re-fires once the retry clears.
      pullRequests.push(makePr(2));
      yield* TestClock.adjust(Duration.seconds(61));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepStrictEqual(
        dispatched.map((event) => event.key),
        ["github:pr:acme/widgets:2"],
      );
      assert.isFalse(seen.get("github:acme/widgets")?.has("github:pr:acme/widgets:2") ?? false);

      retrying = false;
      yield* TestClock.adjust(Duration.seconds(61));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepStrictEqual(
        dispatched.map((event) => event.key),
        ["github:pr:acme/widgets:2", "github:pr:acme/widgets:2"],
      );
      assert.isTrue(seen.get("github:acme/widgets")?.has("github:pr:acme/widgets:2") ?? false);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);
