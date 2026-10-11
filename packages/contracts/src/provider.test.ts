import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts explicit per-thread computer control provisioning", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-computer",
      provider: "codex",
      enableComputerControl: true,
      runtimeMode: "full-access",
    });
    expect(parsed.enableComputerControl).toBe(true);
  });

  it("accepts an optional execution profile", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      runtimeMode: "full-access",
      executionProfile: {
        environmentId: "env-1",
        providerKind: "codex",
        remoteWorkspaceRoot: "/srv/repos/synara",
      },
    });
    expect(parsed.executionProfile?.environmentId).toBe("env-1");
    expect(parsed.executionProfile?.remoteWorkspaceRoot).toBe("/srv/repos/synara");
  });

  it("rejects an execution profile without a workspace root", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        runtimeMode: "full-access",
        executionProfile: { environmentId: "env-1", providerKind: "codex" },
      }),
    ).toThrow();
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "ultrathink",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.effort).toBe("ultrathink");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });
});
