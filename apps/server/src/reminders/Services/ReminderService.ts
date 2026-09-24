import type {
  ReminderCancelInput,
  ReminderListResult,
  ReminderSetInput,
  ReminderStreamEvent,
  ThreadReminder,
} from "@synara/contracts";
import { Effect, Schema, Scope, ServiceMap, Stream } from "effect";

export class ReminderServiceError extends Schema.TaggedErrorClass<ReminderServiceError>()(
  "ReminderServiceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ReminderServiceShape {
  readonly list: () => Effect.Effect<ReminderListResult, ReminderServiceError>;
  readonly set: (input: ReminderSetInput) => Effect.Effect<ThreadReminder, ReminderServiceError>;
  readonly cancel: (input: ReminderCancelInput) => Effect.Effect<void, ReminderServiceError>;
  readonly streamEvents: Stream.Stream<ReminderStreamEvent, ReminderServiceError>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ReminderService extends ServiceMap.Service<ReminderService, ReminderServiceShape>()(
  "synara/reminders/Services/ReminderService",
) {}
