import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { dispatchAutomaticPullRequestReview } from "./automaticPullRequestReview";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";

describe("dispatchAutomaticPullRequestReview", () => {
  it("queues a review turn using the thread provider and PR base branch", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const thread = {
      id: ThreadId.makeUnsafe("thread-review"),
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "local",
      interactionMode: "default",
      latestTurn: null,
      session: null,
    } as unknown as OrchestrationThreadShell;
    const orchestrationEngine = {
      dispatch: (command: Record<string, unknown>) =>
        Effect.sync(() => {
          commands.push(command);
        }),
    } as unknown as OrchestrationEngineShape;

    await Effect.runPromise(
      dispatchAutomaticPullRequestReview({
        orchestrationEngine,
        thread,
        baseBranch: "main",
      }),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: ThreadId.makeUnsafe("thread-review"),
      reviewTarget: { type: "baseBranch", branch: "main" },
      dispatchOrigin: "automation",
      dispatchMode: "queue",
    });
  });
});
