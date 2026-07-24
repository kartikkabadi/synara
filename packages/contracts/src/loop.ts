import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas";

export const LOOP_DEFAULT_HARD_CAP = 100;
// Issue #49 final locked caps: explicit count budgets are 1..100 and are
// also capped by the default hard cap (100) so the two limits never diverge.
export const LOOP_MAX_COUNT_BUDGET = 100;
export const LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD = 3;
export const LOOP_MAX_DURATION_SECONDS = 24 * 60 * 60;
// Loop prompts are turn bodies; they share the canonical turn-input bound.
export const LOOP_PROMPT_MAX_INPUT_CHARS = 120_000;

export const LoopStopReason = Schema.Literals([
  "toggled_off",
  "user_stop",
  "budget_iterations",
  "budget_duration",
  "hard_cap",
  "consecutive_errors",
  "prompt_invalid",
  "thread_unrunnable",
  "attachments_not_supported",
  "replaced_by_manual_policy",
  "thread_archived",
  "thread_deleted",
]);
export type LoopStopReason = typeof LoopStopReason.Type;

export const LoopPrompt = TrimmedString.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(LOOP_PROMPT_MAX_INPUT_CHARS))
  .check(Schema.isPattern(/^[^/]/));
export type LoopPrompt = typeof LoopPrompt.Type;

// Stable identity for one loop activation. Branded so it cannot be confused
// with CommandId/TurnId even though it is derived from a command id.
export const LoopActivationId = TrimmedNonEmptyString.pipe(Schema.brand("LoopActivationId"));
export type LoopActivationId = typeof LoopActivationId.Type;

// Server-assigned marker on loop-owned turns. Never client-supplied.
export const ThreadTurnPurpose = Schema.Struct({
  kind: Schema.Literal("loop-iteration"),
  activationId: LoopActivationId,
  iteration: PositiveInt,
});
export type ThreadTurnPurpose = typeof ThreadTurnPurpose.Type;

export const ThreadLoop = Schema.Struct({
  active: Schema.Boolean,

  // Empty string means "armed, waiting for first prompt".
  prompt: Schema.String.check(Schema.isMaxLength(LOOP_PROMPT_MAX_INPUT_CHARS)),

  // Number of loop-owned turns accepted/dispatched in this activation.
  iteration: NonNegativeInt,

  // Explicit user count budget; null means none.
  maxIterations: Schema.NullOr(PositiveInt),

  // Absolute expiry instant for duration budget; null means none. Re-anchored
  // to server-now + durationSeconds on reconfigure.
  endsAt: Schema.NullOr(IsoDateTime),

  // Canonical configured duration budget in seconds; null means no duration
  // budget. Budget copy derives from this, never from endsAt - createdAt.
  durationSeconds: Schema.optional(Schema.NullOr(PositiveInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),

  // Always present. Default 100.
  hardCap: PositiveInt,

  // Consecutive terminal errors on loop-owned turns since last success.
  consecutiveErrors: NonNegativeInt,

  // Short redacted reason when auto-off happens; null otherwise.
  lastStopReason: Schema.NullOr(LoopStopReason),

  // Stable identity for this loop activation; used to scope settlement and
  // continuation command IDs so a reconfigured loop does not inherit stale
  // terminal events from a previous activation.
  activationId: LoopActivationId,

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadLoop = typeof ThreadLoop.Type;
