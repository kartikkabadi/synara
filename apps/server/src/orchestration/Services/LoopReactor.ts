/**
 * LoopReactor - Coordinates automatic continuation for thread-local `/loop` mode.
 *
 * Listens to orchestration domain events and dispatches `thread.loop.continue`
 * when a loop-owned turn settles or a loop is armed.
 *
 * @module LoopReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

/**
 * LoopReactorShape - Service API for loop continuation lifecycle.
 */
export interface LoopReactorShape {
  /**
   * Start the loop continuation reactor.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /**
   * Restore active loops after startup turn reconciliation.
   *
   * This is called once the projection has been bootstrapped and any stuck
   * turns from the previous process have been reconciled.
   */
  readonly restoreActiveLoops: Effect.Effect<void, never>;
}

/**
 * LoopReactor - Service tag for loop continuation coordination.
 */
export class LoopReactor extends ServiceMap.Service<LoopReactor, LoopReactorShape>()(
  "synara/orchestration/Services/LoopReactor",
) {}
