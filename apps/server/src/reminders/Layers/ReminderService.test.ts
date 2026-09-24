// FILE: ReminderService.test.ts
// Purpose: Verifies reminder set/cancel/list flow and that due reminders publish
// exactly one reminder-fired event carrying thread context.
// Layer: Reminder service test
// Depends on: ReminderServiceLive with in-memory repository and snapshot-query fakes.

import { assert, it } from "@effect/vitest";
import { ThreadId, type ReminderStreamEvent, type ThreadReminder } from "@synara/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import type { AutomationRepositoryShape } from "../../persistence/Services/AutomationRepository.ts";
import { ReminderService } from "../Services/ReminderService.ts";
import { ReminderServiceLive } from "./ReminderService.ts";

function makeInMemoryReminderRepository() {
  const reminders = new Map<string, ThreadReminder>();
  return {
    reminders,
    repository: {
      listThreadReminders: () => Effect.succeed([...reminders.values()]),
      getThreadReminder: ({ threadId }: { threadId: string }) =>
        Effect.succeed(Option.fromNullishOr(reminders.get(threadId))),
      upsertThreadReminder: ({
        threadId,
        dueAt,
        note,
        now,
      }: {
        threadId: string;
        dueAt: string;
        note: string | null;
        now: string;
      }) =>
        Effect.sync(() => {
          const reminder = {
            threadId: ThreadId.makeUnsafe(threadId),
            dueAt,
            firedAt: null,
            ...(note !== null ? { note } : {}),
            createdAt: now,
          } satisfies ThreadReminder;
          reminders.set(threadId, reminder);
          return reminder;
        }),
      deleteThreadReminder: ({ threadId }: { threadId: string }) =>
        Effect.sync(() => {
          reminders.delete(threadId);
        }),
      listDueThreadReminders: ({ now, limit }: { now: string; limit: number }) =>
        Effect.succeed(
          [...reminders.values()]
            .filter((reminder) => reminder.firedAt === null && reminder.dueAt <= now)
            .slice(0, limit),
        ),
      markThreadReminderFired: ({ threadId, firedAt }: { threadId: string; firedAt: string }) =>
        Effect.sync(() => {
          const reminder = reminders.get(threadId);
          if (!reminder || reminder.firedAt !== null) {
            return Option.none<ThreadReminder>();
          }
          const fired = { ...reminder, firedAt };
          reminders.set(threadId, fired);
          return Option.some(fired);
        }),
    } as unknown as AutomationRepositoryShape,
  };
}

const projectionSnapshotQuery = {
  getThreadShellById: () =>
    Effect.succeed(Option.some({ title: "Deploy hotfix", projectId: "project-reminder" })),
} as unknown as ProjectionSnapshotQueryShape;

function makeLayer(repository: AutomationRepositoryShape) {
  return ReminderServiceLive.pipe(
    Layer.provide(Layer.succeed(AutomationRepository, repository)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
  );
}

it.effect("sets, lists, and cancels reminders with stream events", () =>
  Effect.gen(function* () {
    const { repository } = makeInMemoryReminderRepository();
    yield* Effect.gen(function* () {
      const service = yield* ReminderService;
      const collected: Array<ReminderStreamEvent["type"]> = [];
      const collector = service.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            collected.push(event.type);
          }),
        ),
        Effect.forkChild,
      );
      yield* collector;
      // Let the subscriber attach before any events publish; PubSub does not
      // replay to late subscribers.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const threadId = ThreadId.makeUnsafe("thread-reminder-crud");
      yield* service.set({
        threadId,
        dueAt: "2026-06-16T11:00:00.000Z",
        note: "Ping the thread",
      });
      assert.lengthOf((yield* service.list()).reminders, 1);

      yield* service.cancel({ threadId });
      assert.lengthOf((yield* service.list()).reminders, 0);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.deepStrictEqual(collected, ["reminder-upserted", "reminder-deleted"]);
    }).pipe(Effect.provide(makeLayer(repository)), Effect.scoped);
  }),
);

it.effect("fires a due reminder once with thread context", () =>
  Effect.gen(function* () {
    const { reminders, repository } = makeInMemoryReminderRepository();
    reminders.set("thread-reminder-due", {
      threadId: ThreadId.makeUnsafe("thread-reminder-due"),
      dueAt: "2000-01-01T00:00:00.000Z",
      firedAt: null,
      createdAt: "2000-01-01T00:00:00.000Z",
    });

    yield* Effect.gen(function* () {
      const service = yield* ReminderService;
      const firedFiber = yield* service.streamEvents.pipe(
        Stream.filter((event) => event.type === "reminder-fired"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* service.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const event = Option.getOrNull(yield* Fiber.join(firedFiber));
      assert.isNotNull(event);
      if (event?.type === "reminder-fired") {
        assert.strictEqual(event.threadTitle, "Deploy hotfix");
        assert.strictEqual(event.projectId, "project-reminder");
        assert.isNotNull(event.reminder.firedAt);
      }
      // The repository marks it fired, so a later poll cannot refire.
      assert.isNotNull(reminders.get("thread-reminder-due")?.firedAt);
    }).pipe(Effect.provide(makeLayer(repository)), Effect.scoped);
  }),
);
