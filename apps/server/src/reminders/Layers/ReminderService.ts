import type { ReminderStreamEvent, ThreadReminder } from "@synara/contracts";
import { Cause, Duration, Effect, Layer, Option, PubSub, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import {
  ReminderService,
  ReminderServiceError,
  type ReminderServiceShape,
} from "../Services/ReminderService.ts";

const REMINDER_POLL_INTERVAL_MS = 15_000;
const REMINDER_DUE_BATCH_LIMIT = 50;

const toReminderError = (operation: string) => (cause: unknown) =>
  new ReminderServiceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const ReminderServiceLive = Layer.effect(
  ReminderService,
  Effect.gen(function* () {
    const automationRepository = yield* AutomationRepository;
    const projectionQuery = yield* ProjectionSnapshotQuery;
    const events = yield* PubSub.unbounded<ReminderStreamEvent>();

    const publish = (event: ReminderStreamEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const list: ReminderServiceShape["list"] = () =>
      automationRepository.listThreadReminders().pipe(
        Effect.map((reminders) => ({ reminders })),
        Effect.mapError(toReminderError("list")),
      );

    const set: ReminderServiceShape["set"] = (input) =>
      automationRepository
        .upsertThreadReminder({
          threadId: input.threadId,
          dueAt: input.dueAt,
          note: input.note ?? null,
          now: new Date().toISOString(),
        })
        .pipe(
          Effect.mapError(toReminderError("set")),
          Effect.tap((reminder) => publish({ type: "reminder-upserted", reminder })),
        );

    const cancel: ReminderServiceShape["cancel"] = (input) =>
      automationRepository.deleteThreadReminder({ threadId: input.threadId }).pipe(
        Effect.mapError(toReminderError("cancel")),
        Effect.tap(() => publish({ type: "reminder-deleted", threadId: input.threadId })),
      );

    const fireReminder = (reminder: ThreadReminder) =>
      automationRepository
        .markThreadReminderFired({
          threadId: reminder.threadId,
          firedAt: new Date().toISOString(),
        })
        .pipe(
          // A None means another process fired it first; never double-publish.
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (fired) =>
                projectionQuery.getThreadShellById(reminder.threadId).pipe(
                  Effect.catch(() => Effect.succeed(Option.none())),
                  Effect.flatMap((threadOption) =>
                    publish({
                      type: "reminder-fired",
                      reminder: fired,
                      ...(Option.isSome(threadOption)
                        ? {
                            threadTitle: threadOption.value.title,
                            projectId: threadOption.value.projectId,
                          }
                        : {}),
                    }),
                  ),
                ),
            }),
          ),
        );

    const fireDueReminders = automationRepository
      .listDueThreadReminders({
        now: new Date().toISOString(),
        limit: REMINDER_DUE_BATCH_LIMIT,
      })
      .pipe(
        Effect.flatMap((due) => Effect.forEach(due, fireReminder, { concurrency: 3 })),
        Effect.asVoid,
      );

    const start: ReminderServiceShape["start"] = () =>
      Effect.forkScoped(
        Effect.forever(
          fireDueReminders.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("thread reminder pass failed", { cause: Cause.pretty(cause) }),
            ),
            Effect.andThen(Effect.sleep(Duration.millis(REMINDER_POLL_INTERVAL_MS))),
          ),
        ),
      ).pipe(Effect.asVoid);

    return {
      list,
      set,
      cancel,
      streamEvents: Stream.fromPubSub(events),
      start,
    } satisfies ReminderServiceShape;
  }),
);
