import { describe, expect, it } from "vitest";

import {
  getComposerTraitSelection,
  hasVisibleComposerTraitControls,
  planComposerEffortChange,
  resolveComposerEffortLadderIndex,
} from "./composerTraits";

describe("planComposerEffortChange", () => {
  it("rewrites the prompt for prompt-injected levels", () => {
    const selection = getComposerTraitSelection("claudeAgent", "claude-opus-4-8", "", undefined);

    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "",
        value: "ultrathink",
      }),
    ).toEqual({ kind: "prompt", prompt: "Ultrathink:\n" });
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "Fix the flaky test",
        value: "ultrathink",
      }),
    ).toEqual({ kind: "prompt", prompt: "Ultrathink:\nFix the flaky test" });
  });

  it("ignores changes while Ultrathink pins the effort and for unknown values", () => {
    const pinned = getComposerTraitSelection(
      "claudeAgent",
      "claude-opus-4-8",
      "Ultrathink:\nGo",
      undefined,
    );
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection: pinned,
        prompt: "Ultrathink:\nGo",
        value: "low",
      }),
    ).toBeNull();

    const free = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);
    expect(
      planComposerEffortChange({ provider: "codex", selection: free, prompt: "", value: "turbo" }),
    ).toBeNull();
    expect(
      planComposerEffortChange({ provider: "codex", selection: free, prompt: "", value: "" }),
    ).toBeNull();
  });
});

describe("resolveComposerEffortLadderIndex", () => {
  it("follows the selected effort and falls back to the first stop", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", {
      reasoningEffort: "high",
    });
    expect(resolveComposerEffortLadderIndex(selection)).toBe(
      selection.effortLevels.findIndex((level) => level.value === "high"),
    );
    expect(resolveComposerEffortLadderIndex({ ...selection, effort: "unknown" })).toBe(0);
  });

  it("rests on the prompt-injected stop while Ultrathink pins the ladder", () => {
    const selection = getComposerTraitSelection(
      "claudeAgent",
      "claude-opus-4-8",
      "Ultrathink:\nGo",
      undefined,
    );
    expect(selection.ultrathinkPromptControlled).toBe(true);
    expect(resolveComposerEffortLadderIndex(selection)).toBe(
      selection.effortLevels.findIndex((level) => level.value === "ultrathink"),
    );
  });
});

describe("getComposerTraitSelection Fusion controls", () => {
  it("keeps reasoning primary and exposes lead and sidekick selects", () => {
    const runtimeModel = {
      slug: "fusion",
      name: "Fusion",
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [
            { id: "medium", label: "Medium", isDefault: true as const },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "leadModel",
          label: "Lead model",
          type: "select" as const,
          options: [
            { id: "claude-fable-5-1", label: "Claude Fable 5.1", isDefault: true as const },
            { id: "gpt-6-sol", label: "GPT-6 Sol" },
          ],
        },
        {
          id: "sidekick",
          label: "Sidekick",
          type: "select" as const,
          options: [
            { id: "swe-2-medium", label: "SWE-2 Medium", isDefault: true as const },
            { id: "glm-5-2", label: "GLM-5.2 High" },
          ],
        },
        { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
      ],
      reasoningEffortLevels: [],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      promptInjectedEffortLevels: [],
      contextWindowOptions: [],
    };
    const selection = getComposerTraitSelection(
      "devin",
      "fusion",
      "",
      { sidekick: "glm-5-2" },
      runtimeModel,
    );
    expect(selection.effortLevels.map((level) => level.value)).toEqual(["medium", "high"]);
    expect(selection.extraSelects).toEqual([
      {
        id: "leadModel",
        label: "Lead model",
        value: "claude-fable-5-1",
        options: [
          { value: "claude-fable-5-1", label: "Claude Fable 5.1", isDefault: true },
          { value: "gpt-6-sol", label: "GPT-6 Sol" },
        ],
      },
      {
        id: "sidekick",
        label: "Sidekick",
        value: "glm-5-2",
        options: [
          { value: "swe-2-medium", label: "SWE-2 Medium", isDefault: true },
          { value: "glm-5-2", label: "GLM-5.2 High" },
        ],
      },
    ]);
    expect(hasVisibleComposerTraitControls(selection)).toBe(true);
  });
});
