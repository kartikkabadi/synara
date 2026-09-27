import { CommandId, MessageId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

export const dispatchAutomaticPullRequestReview = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly thread: OrchestrationThreadShell;
  readonly baseBranch: string;
}) =>
  Effect.gen(function* () {
    const { orchestrationEngine, thread, baseBranch } = input;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`automatic-pr-review:${randomUUID()}`),
      threadId: thread.id,
      message: {
        messageId: MessageId.makeUnsafe(`automatic-pr-review:${randomUUID()}`),
        role: "user",
        text: `Automatically review pull request changes against ${baseBranch}. Report only actionable findings, ordered by severity.`,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      reviewTarget: { type: "baseBranch", branch: baseBranch },
      dispatchOrigin: "automation",
      dispatchMode: "queue",
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date().toISOString(),
    });
    return true;
  });
