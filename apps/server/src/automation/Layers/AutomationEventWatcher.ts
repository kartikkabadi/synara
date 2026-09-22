import type {
  AutomationEventRunContext,
  AutomationEventTrigger,
  AutomationId,
} from "@synara/contracts";
import { Cause, Duration, Effect, Layer, Option } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubIssueListItem,
  type GitHubPullRequestListItem,
} from "../../git/Services/GitHubCli.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { resolveGitHubRepositories } from "../../pullRequests/repositoryResolution.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import {
  AutomationEventWatcher,
  type AutomationEventWatcherShape,
} from "../Services/AutomationEventWatcher.ts";

const DEFAULT_EVENT_POLL_INTERVAL_MS = 60_000;
const EVENT_LIST_LIMIT = 100;

interface WatchedTrigger {
  readonly automationId: AutomationId;
  readonly trigger: AutomationEventTrigger;
}

interface WatchedRepository {
  readonly repository: string;
  readonly cwd: string;
  readonly triggers: ReadonlyArray<WatchedTrigger>;
}

function prEventKey(repository: string, number: number): string {
  return `github:pr:${repository}:${number}`;
}

function issueEventKey(repository: string, number: number): string {
  return `github:issue:${repository}:${number}`;
}

/** Sentinel marking a repository's inbox as seeded even when the first poll lists nothing. */
function seedEventKey(repository: string): string {
  return `github:seed:${repository}`;
}

function actorMatches(filter: string | null | undefined, author: string | undefined): boolean {
  if (filter === null || filter === undefined || filter === "*") return true;
  return author !== undefined && author.toLowerCase() === filter.toLowerCase();
}

function branchMatches(filter: string | null | undefined, baseBranch: string | undefined): boolean {
  if (filter === null || filter === undefined || filter === "*") return true;
  return baseBranch !== undefined && baseBranch.toLowerCase() === filter.toLowerCase();
}

export interface AutomationEventWatcherLiveOptions {
  readonly intervalMs?: number;
}

export const makeAutomationEventWatcherLive = (options?: AutomationEventWatcherLiveOptions) =>
  Layer.effect(
    AutomationEventWatcher,
    Effect.gen(function* () {
      const automationService = yield* AutomationService;
      const automationRepository = yield* AutomationRepository;
      const github = yield* GitHubCli;
      const git = yield* GitCore;
      const projectionQuery = yield* ProjectionSnapshotQuery;
      const intervalMs = Math.max(5_000, options?.intervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS);

      const resolveWatchedRepositories = Effect.fn(function* () {
        const definitions = yield* automationService.listEventTriggeredDefinitions({
          includeDisabled: true,
        });
        const watched = new Map<string, WatchedRepository>();
        for (const definition of definitions) {
          const project = yield* projectionQuery
            .getProjectShellById(definition.projectId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isNone(project)) continue;
          const cwd = project.value.workspaceRoot;
          const projectRepositories = yield* resolveGitHubRepositories(git, cwd).pipe(
            Effect.map((inventory) => inventory.repositories.map((repo) => repo.nameWithOwner)),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
          );
          for (const trigger of definition.eventTriggers ?? []) {
            const repositories =
              trigger.repositories.length > 0 ? trigger.repositories : projectRepositories;
            for (const repository of repositories) {
              const key = repository.toLowerCase();
              const entry: WatchedTrigger = { automationId: definition.id, trigger };
              const existing = watched.get(key);
              watched.set(
                key,
                existing
                  ? { ...existing, triggers: [...existing.triggers, entry] }
                  : { repository, cwd, triggers: [entry] },
              );
            }
          }
        }
        return [...watched.values()];
      });

      /**
       * Dispatches one event to every matching trigger. "consumed" marks the event seen —
       * either a run was created or every trigger skipped it (disabled, pending proposal,
       * already claimed). "retry" leaves it unseen so the next poll re-attempts it; the
       * idempotent per-automation claim keeps already-dispatched triggers from re-running.
       */
      const dispatchEvent = (
        watchedRepository: WatchedRepository,
        context: AutomationEventRunContext,
      ) =>
        Effect.forEach(
          watchedRepository.triggers,
          ({ automationId, trigger }) =>
            trigger.event === context.event &&
            branchMatches(trigger.branch, context.baseBranch) &&
            actorMatches(trigger.actor, context.author)
              ? automationService.runEvent({ automationId, trigger, event: context }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("automation event dispatch failed", {
                      automationId,
                      eventKey: context.key,
                      error: error instanceof Error ? error.message : String(error),
                    }).pipe(
                      Effect.as({
                        status: "retry" as const,
                        reason: error instanceof Error ? error.message : String(error),
                      }),
                    ),
                  ),
                )
              : Effect.succeed({ status: "skipped" as const }),
          { concurrency: 3 },
        ).pipe(
          Effect.map((outcomes) =>
            outcomes.some((outcome) => outcome.status === "retry")
              ? ("retry" as const)
              : ("consumed" as const),
          ),
        );

      const markSeen = (repository: string, eventKeys: ReadonlyArray<string>, seenAt: string) =>
        automationRepository.insertAutomationSeenEvents({
          events: eventKeys.map((eventKey) => ({
            eventKey,
            source: "github" as const,
            repository,
            seenAt,
          })),
        });

      const pollRepository = (watchedRepository: WatchedRepository) =>
        Effect.gen(function* () {
          // Keys and seen rows use the canonical lowercase owner/name so differently
          // cased trigger entries share one dedup ledger.
          const repository = watchedRepository.repository.toLowerCase();
          const { cwd } = watchedRepository;
          const wantsPullRequests = watchedRepository.triggers.some(
            ({ trigger }) => trigger.event !== "issue_opened",
          );
          const wantsIssues = watchedRepository.triggers.some(
            ({ trigger }) => trigger.event === "issue_opened",
          );
          const viewer = wantsPullRequests
            ? yield* github.getViewerLogin({ cwd }).pipe(Effect.catch(() => Effect.succeed("")))
            : "";
          const pullRequests = wantsPullRequests
            ? yield* github
                .listRepositoryPullRequests({
                  cwd,
                  repository,
                  state: "open",
                  involvement: "all",
                  viewer,
                  limit: EVENT_LIST_LIMIT,
                })
                .pipe(Effect.map((batch) => batch.entries))
            : ([] as ReadonlyArray<GitHubPullRequestListItem>);
          const issues = wantsIssues
            ? yield* github.listRepositoryIssues({
                cwd,
                repository,
                state: "open",
                limit: EVENT_LIST_LIMIT,
              })
            : ([] as ReadonlyArray<GitHubIssueListItem>);

          const now = new Date().toISOString();
          const observedKeys = [
            ...pullRequests.map((pr) => prEventKey(repository, pr.number)),
            ...issues.map((issue) => issueEventKey(repository, issue.number)),
          ];

          const seeded = yield* automationRepository.hasAutomationSeenEventsForRepository({
            source: "github",
            repository,
          });
          // First sight of a repository seeds the inbox without firing: anything listed now
          // predates the watch and must not retro-dispatch runs. The sentinel persists the
          // seeded state even when the repo currently has no items.
          if (!seeded) {
            yield* markSeen(repository, [seedEventKey(repository), ...observedKeys], now);
            return;
          }

          const seenKeys = new Set(
            yield* automationRepository.listAutomationSeenEventKeys({
              source: "github",
              repository,
            }),
          );
          const events: AutomationEventRunContext[] = [];
          for (const pr of pullRequests) {
            const eventKey = prEventKey(repository, pr.number);
            if (seenKeys.has(eventKey)) continue;
            events.push({
              source: "github",
              event: pr.isDraft ? "draft_opened" : "pull_request_opened",
              key: eventKey,
              repository,
              itemNumber: pr.number,
              title: pr.title,
              url: pr.url,
              ...(pr.author !== null ? { author: pr.author.login } : {}),
              ...(pr.baseBranch ? { baseBranch: pr.baseBranch } : {}),
            });
          }
          for (const issue of issues) {
            const eventKey = issueEventKey(repository, issue.number);
            if (seenKeys.has(eventKey)) continue;
            events.push({
              source: "github",
              event: "issue_opened",
              key: eventKey,
              repository,
              itemNumber: issue.number,
              title: issue.title,
              url: issue.url,
              ...(issue.author !== null ? { author: issue.author.login } : {}),
            });
          }

          // Mark seen only after dispatch: events every trigger consumed go on the
          // ledger; an event any trigger failed or deferred on stays unseen and retries
          // on the next poll (its successful triggers are idempotent via their claims).
          const consumedKeys: Array<string> = [];
          for (const event of events) {
            const outcome = yield* dispatchEvent(watchedRepository, event);
            if (outcome === "consumed") {
              consumedKeys.push(event.key);
            }
          }
          if (consumedKeys.length > 0) {
            yield* markSeen(repository, consumedKeys, now);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation event repository poll failed", {
              repository: watchedRepository.repository,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );

      const runPass = Effect.gen(function* () {
        const watchedRepositories = yield* resolveWatchedRepositories().pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation event watcher resolution failed", {
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as([] as ReadonlyArray<WatchedRepository>)),
          ),
        );
        yield* Effect.forEach(watchedRepositories, pollRepository, { concurrency: 2 });
      });

      const start: AutomationEventWatcherShape["start"] = () =>
        Effect.forkScoped(
          Effect.forever(
            runPass.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("automation event watcher pass failed", {
                  cause: Cause.pretty(cause),
                }),
              ),
              Effect.andThen(Effect.sleep(Duration.millis(intervalMs))),
            ),
          ),
        ).pipe(Effect.asVoid);

      return { start } satisfies AutomationEventWatcherShape;
    }),
  );

export const AutomationEventWatcherLive = makeAutomationEventWatcherLive();
