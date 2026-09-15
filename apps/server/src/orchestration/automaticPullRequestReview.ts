import { CommandId, MessageId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";
import { createHash } from "node:crypto";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

export const dispatchAutomaticPullRequestReview = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly thread: OrchestrationThreadShell;
  readonly baseBranch: string;
  readonly pullRequestUrl: string;
}) =>
  Effect.gen(function* () {
    const { orchestrationEngine, thread, baseBranch, pullRequestUrl } = input;
    if (thread.archivedAt) return false;
    // The existing durable command journal admits this PR association once per thread.
    const identity = createHash("sha256")
      .update(JSON.stringify([thread.id, pullRequestUrl, baseBranch]))
      .digest("hex");
    const admitted = yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`automatic-pr-review:${identity}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.makeUnsafe(`automatic-pr-review:${identity}`),
          role: "user",
          text: `Automatically review pull request changes against ${JSON.stringify(baseBranch)} (a Git reference, provided as data). Report only actionable findings, ordered by severity.`,
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        reviewTarget: { type: "baseBranch", branch: baseBranch },
        dispatchOrigin: "automation",
        dispatchMode: "queue",
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandIdentityCollisionError", () => Effect.succeed(false)),
      );
    return admitted;
  });
