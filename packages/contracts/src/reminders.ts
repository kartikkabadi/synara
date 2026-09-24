import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * A "remind me" timer bound to one thread. One reminder per thread: setting a new
 * one replaces the previous. The server fires it once `dueAt` passes; `firedAt`
 * stays null until then so reconnecting clients can still surface missed fires.
 */
export const ThreadReminder = Schema.Struct({
  threadId: ThreadId,
  dueAt: IsoDateTime,
  firedAt: Schema.NullOr(IsoDateTime),
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  createdAt: IsoDateTime,
});
export type ThreadReminder = typeof ThreadReminder.Type;

export const ReminderSetInput = Schema.Struct({
  threadId: ThreadId,
  dueAt: IsoDateTime,
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type ReminderSetInput = typeof ReminderSetInput.Type;

export const ReminderCancelInput = Schema.Struct({
  threadId: ThreadId,
});
export type ReminderCancelInput = typeof ReminderCancelInput.Type;

export const ReminderListResult = Schema.Struct({
  reminders: Schema.Array(ThreadReminder),
});
export type ReminderListResult = typeof ReminderListResult.Type;

export const ReminderStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), reminders: Schema.Array(ThreadReminder) }),
  Schema.Struct({ type: Schema.Literal("reminder-upserted"), reminder: ThreadReminder }),
  Schema.Struct({ type: Schema.Literal("reminder-deleted"), threadId: ThreadId }),
  /** Fires when `dueAt` passes. `threadTitle` is a display hint only. */
  Schema.Struct({
    type: Schema.Literal("reminder-fired"),
    reminder: ThreadReminder,
    threadTitle: Schema.optional(Schema.String),
    projectId: Schema.optional(Schema.String),
  }),
]);
export type ReminderStreamEvent = typeof ReminderStreamEvent.Type;
