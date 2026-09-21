import { Effect, Scope, ServiceMap } from "effect";

export interface AutomationEventWatcherShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AutomationEventWatcher extends ServiceMap.Service<
  AutomationEventWatcher,
  AutomationEventWatcherShape
>()("synara/automation/Services/AutomationEventWatcher") {}
