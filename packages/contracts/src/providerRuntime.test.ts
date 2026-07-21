import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ProviderCompactionRequest,
  ProviderCompactionResult,
  ProviderRuntimeEvent,
  type ProviderRuntimeEventType,
} from "./providerRuntime";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("includes turn.steered in the exported event type", () => {
    const eventType: ProviderRuntimeEventType = "turn.steered";
    expect(eventType).toBe("turn.steered");
  });

  it("decodes turn.tasks.updated for task-list rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.tasks.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        tasks: [
          { task: "Define event union", status: "completed" },
          { task: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.tasks.updated");
    if (parsed.type !== "turn.tasks.updated") {
      throw new Error("expected turn.tasks.updated");
    }
    expect(parsed.payload.tasks).toHaveLength(2);
    expect(parsed.payload.tasks[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          usedPercent: 15.6255,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
    expect(parsed.payload.usage.usedPercent).toBe(15.6255);
    expect(parsed.payload.usage.context).toBeUndefined();
    expect(parsed.payload.usage.cumulative).toBeUndefined();
    expect(parsed.payload.usage.lastTurn).toBeUndefined();
  });

  it("decodes thread token usage snapshots with nested V2 claims", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-2",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          totalProcessedTokens: 748126,
          context: {
            usedTokens: 31251,
            maxTokens: 200000,
            usedPercent: 15.6255,
            measurement: "provider-reported",
            confidence: "exact",
          },
          cumulative: {
            inputTokens: 700000,
            outputTokens: 48126,
            totalProcessedTokens: 748126,
          },
          lastTurn: {
            inputTokens: 30000,
            outputTokens: 1251,
            durationMs: 43567,
            toolUses: 25,
          },
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.context?.measurement).toBe("provider-reported");
    expect(parsed.payload.usage.context?.confidence).toBe("exact");
    expect(parsed.payload.usage.cumulative?.totalProcessedTokens).toBe(748126);
    expect(parsed.payload.usage.lastTurn?.toolUses).toBe(25);
  });

  it("rejects nested context claims with unknown measurement labels", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: "event-token-usage-3",
        provider: "claudeAgent",
        createdAt: "2026-02-28T00:00:06.000Z",
        threadId: "thread-1",
        payload: {
          usage: {
            usedTokens: 31251,
            context: {
              usedTokens: 31251,
              measurement: "guessed",
              confidence: "exact",
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe("ProviderCompactionRequest", () => {
  const decodeRequest = Schema.decodeUnknownSync(ProviderCompactionRequest);

  it("decodes a manual request with instructions", () => {
    const parsed = decodeRequest({
      requestId: "compact-req-1",
      threadId: "thread-1",
      trigger: "manual",
      instructions: "Keep the migration plan",
      expectedLifecycleGeneration: "gen-1",
    });
    expect(parsed.trigger).toBe("manual");
    expect(parsed.instructions).toBe("Keep the migration plan");
  });

  it("decodes a synara-auto request without optional fields", () => {
    const parsed = decodeRequest({
      requestId: "compact-req-2",
      threadId: "thread-2",
      trigger: "synara-auto",
    });
    expect(parsed.trigger).toBe("synara-auto");
    expect(parsed.instructions).toBeUndefined();
  });

  it("rejects unknown triggers", () => {
    expect(() =>
      decodeRequest({ requestId: "r", threadId: "t", trigger: "provider-auto" }),
    ).toThrow();
  });
});

describe("ProviderCompactionResult", () => {
  const decodeResult = Schema.decodeUnknownSync(ProviderCompactionResult);

  it("decodes each result kind", () => {
    expect(decodeResult({ kind: "same-session" }).kind).toBe("same-session");
    const rollover = decodeResult({
      kind: "session-rollover",
      resumeCursor: "cursor-1",
      providerThreadId: "provider-thread-1",
    });
    expect(rollover.kind).toBe("session-rollover");
    expect(decodeResult({ kind: "runtime-restart-required", resumeCursor: "cursor-2" }).kind).toBe(
      "runtime-restart-required",
    );
  });

  it("requires a resume cursor for session rollover", () => {
    expect(() => decodeResult({ kind: "session-rollover" })).toThrow();
  });
});
