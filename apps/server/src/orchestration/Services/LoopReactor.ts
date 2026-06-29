import { Effect, Scope, ServiceMap } from "effect";

export interface LoopReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class LoopReactor extends ServiceMap.Service<
  LoopReactor,
  LoopReactorShape
>()("t3/orchestration/Services/LoopReactor") {}
