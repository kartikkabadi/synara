import { Effect, Scope, ServiceMap } from "effect";

export interface LoopReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  // Re-enqueue threads with active loops after a server restart so the reactor
  // recreates the wake-up fiber and resumes the interval. Same pattern as
  // GoalContinuationReactor.reconcile.
  readonly reconcile: (threadIds: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class LoopReactor extends ServiceMap.Service<LoopReactor, LoopReactorShape>()(
  "t3/orchestration/Services/LoopReactor",
) {}
