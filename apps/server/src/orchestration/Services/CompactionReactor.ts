import { Effect, Scope, ServiceMap } from "effect";

export interface CompactionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class CompactionReactor extends ServiceMap.Service<
  CompactionReactor,
  CompactionReactorShape
>()("t3/orchestration/Services/CompactionReactor") {}
