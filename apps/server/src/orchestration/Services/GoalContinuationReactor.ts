import { Effect, Scope, ServiceMap } from "effect";

export interface GoalContinuationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  // Re-enqueue threads with active goals after a server restart so continuations resume
  // without waiting for a manual message or session event. The reactor's per-thread
  // handler re-checks all guards (session idle, no pending input, plan mode, etc.) before
  // dispatching, so this is safe to call on any thread — non-goal or paused threads early
  // return. Stagger dispatches to avoid a load spike if multiple goals survived restart.
  readonly reconcile: (threadIds: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class GoalContinuationReactor extends ServiceMap.Service<
  GoalContinuationReactor,
  GoalContinuationReactorShape
>()("t3/orchestration/Services/GoalContinuationReactor") {}
