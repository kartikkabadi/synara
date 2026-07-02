import { describe, expect, it } from "vitest";

import {
  buildReviewPrompt,
  buildSubagentsPrompt,
  canOfferForkSlashCommand,
  canOfferReviewSlashCommand,
  canOfferSideSlashCommand,
  filterComposerSlashCommands,
  getAvailableComposerSlashCommands,
  hasProviderNativeSlashCommand,
  isBuiltInComposerSlashCommand,
  nativeReviewDispatchable,
  parseComposerSlashInvocation,
  parseComposerSlashInvocationForCommands,
  parseFastSlashCommandAction,
  parseForkSlashCommandArgs,
  parseGoalSlashCommand,
  parseLoopSlashCommand,
  shouldHideProviderNativeCommandFromComposerMenu,
} from "./composerSlashCommands";

describe("composerSlashCommands", () => {
  it("recognizes built-in slash commands", () => {
    expect(isBuiltInComposerSlashCommand("review")).toBe(true);
    expect(isBuiltInComposerSlashCommand("fast")).toBe(true);
    expect(isBuiltInComposerSlashCommand("automation")).toBe(true);
    expect(isBuiltInComposerSlashCommand("unknown")).toBe(false);
  });

  it("filters slash commands by query", () => {
    expect(filterComposerSlashCommands("rev").map((entry) => entry.command)).toEqual(["review"]);
    expect(filterComposerSlashCommands("fast").map((entry) => entry.command)).toEqual(["fast"]);
    expect(filterComposerSlashCommands("auto").map((entry) => entry.command)).toEqual([
      "automation",
    ]);
  });

  it("ranks slash command name matches before description-only matches", () => {
    expect(
      filterComposerSlashCommands("mode", ["fast", "default", "model"]).map(
        (entry) => entry.command,
      ),
    ).toEqual(["model", "fast", "default"]);
  });

  it("parses /goal subcommands and objectives", () => {
    expect(parseGoalSlashCommand("")).toEqual({ kind: "status" });
    expect(parseGoalSlashCommand("status")).toEqual({ kind: "status" });
    expect(parseGoalSlashCommand("pause")).toEqual({ kind: "pause" });
    expect(parseGoalSlashCommand("resume")).toEqual({ kind: "resume" });
    expect(parseGoalSlashCommand("clear")).toEqual({ kind: "clear" });
    expect(parseGoalSlashCommand("complete")).toEqual({ kind: "complete" });
    expect(parseGoalSlashCommand("Migrate the auth module")).toEqual({
      kind: "create",
      objective: "Migrate the auth module",
      tokenBudget: null,
    });
    expect(parseGoalSlashCommand("Migrate the auth module --budget 5000")).toEqual({
      kind: "create",
      objective: "Migrate the auth module",
      tokenBudget: 5000,
    });
    expect(parseGoalSlashCommand("Ship it --budget=100")).toEqual({
      kind: "create",
      objective: "Ship it",
      tokenBudget: 100,
    });
  });

  it("parses /loop subcommands and create form", () => {
    expect(parseLoopSlashCommand("")).toEqual({ kind: "status" });
    expect(parseLoopSlashCommand("status")).toEqual({ kind: "status" });
    expect(parseLoopSlashCommand("pause")).toEqual({ kind: "pause" });
    expect(parseLoopSlashCommand("resume")).toEqual({ kind: "resume" });
    expect(parseLoopSlashCommand("clear")).toEqual({ kind: "clear" });
    expect(parseLoopSlashCommand("5m find and fix bugs")).toEqual({
      kind: "create",
      prompt: "find and fix bugs",
      intervalSeconds: 300,
    });
    expect(parseLoopSlashCommand("1h rebuild the index")).toEqual({
      kind: "create",
      prompt: "rebuild the index",
      intervalSeconds: 3600,
    });
    // Case-insensitive lifecycle keywords.
    expect(parseLoopSlashCommand("PAUSE")).toEqual({ kind: "pause" });
  });

  it("returns an invalid create action when the interval is missing or malformed", () => {
    expect(parseLoopSlashCommand("find and fix bugs")).toEqual({
      kind: "create",
      prompt: "",
      intervalSeconds: 0,
    });
    expect(parseLoopSlashCommand("5m")).toEqual({
      kind: "create",
      prompt: "",
      intervalSeconds: 0,
    });
    expect(parseLoopSlashCommand("5 find and fix bugs")).toEqual({
      kind: "create",
      prompt: "",
      intervalSeconds: 0,
    });
  });

  it("offers /loop to non-Claude providers", () => {
    const codexCommands = getAvailableComposerSlashCommands({
      provider: "codex",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      canOfferSideCommand: true,
    });
    expect(codexCommands).toContain("loop");
  });

  it("offers /goal to non-Claude providers but not Claude (which has a native /goal)", () => {
    const codexCommands = getAvailableComposerSlashCommands({
      provider: "codex",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      canOfferSideCommand: true,
    });
    expect(codexCommands).toContain("goal");

    const claudeCommands = getAvailableComposerSlashCommands({
      provider: "claudeAgent",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      canOfferSideCommand: true,
    });
    expect(claudeCommands).not.toContain("goal");
  });

  it("parses slash invocations with optional arguments", () => {
    expect(parseComposerSlashInvocation("/review current diff")).toEqual({
      command: "review",
      args: "current diff",
    });
    expect(parseComposerSlashInvocation("/fast")).toEqual({
      command: "fast",
      args: "",
    });
    expect(parseComposerSlashInvocation("/side is this safe?")).toEqual({
      command: "side",
      args: "is this safe?",
    });
    expect(parseComposerSlashInvocation("/automation every 6h check the page")).toEqual({
      command: "automation",
      args: "every 6h check the page",
    });
    expect(parseComposerSlashInvocation("review")).toBeNull();
  });

  it("does not parse app slash commands that are shadowed by provider-native commands", () => {
    expect(parseComposerSlashInvocationForCommands("/fast", ["clear", "model"])).toBeNull();
    expect(parseComposerSlashInvocationForCommands("/clear", ["clear", "model"])).toEqual({
      command: "clear",
      args: "",
    });
  });

  it("parses /fast actions", () => {
    expect(parseFastSlashCommandAction("/fast")).toBe("toggle");
    expect(parseFastSlashCommandAction("/fast on")).toBe("on");
    expect(parseFastSlashCommandAction("/fast off")).toBe("off");
    expect(parseFastSlashCommandAction("/fast status")).toBe("status");
    expect(parseFastSlashCommandAction("/fast maybe")).toBe("invalid");
    expect(parseFastSlashCommandAction("/review")).toBeNull();
  });

  it("parses /fork target shorthand only", () => {
    expect(parseForkSlashCommandArgs("")).toEqual({
      target: null,
      invalid: false,
    });
    expect(parseForkSlashCommandArgs("local")).toEqual({
      target: "local",
      invalid: false,
    });
    expect(parseForkSlashCommandArgs("  worktree  ")).toEqual({
      target: "worktree",
      invalid: false,
    });
    expect(parseForkSlashCommandArgs("follow up on the bug")).toEqual({
      target: null,
      invalid: true,
    });
    expect(parseForkSlashCommandArgs("local continue here")).toEqual({
      target: null,
      invalid: true,
    });
  });

  it("only offers /fork for an otherwise empty default composer", () => {
    expect(
      canOfferForkSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "default",
      }),
    ).toBe(true);

    expect(
      canOfferForkSlashCommand({
        prompt: "hello",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "default",
      }),
    ).toBe(false);

    expect(
      canOfferForkSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "plan",
      }),
    ).toBe(false);
  });

  it("only offers /side for a main-thread empty default composer", () => {
    expect(
      canOfferSideSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "default",
        isSidechat: false,
      }),
    ).toBe(true);

    expect(
      canOfferSideSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "default",
        isSidechat: true,
      }),
    ).toBe(false);
  });

  it("only offers /review for an otherwise empty composer", () => {
    expect(
      canOfferReviewSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
      }),
    ).toBe(true);

    expect(
      canOfferReviewSlashCommand({
        prompt: "",
        imageCount: 1,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
      }),
    ).toBe(false);
  });

  it("builds slash-command canned prompts", () => {
    expect(buildSubagentsPrompt("")).toContain("Run subagents");
    expect(buildSubagentsPrompt("Already there")).toContain("Already there\n\nRun subagents");
    expect(buildReviewPrompt({ target: "changes" })).toContain("uncommitted changes");
    expect(buildReviewPrompt({ target: "base-branch" })).toContain("base branch");
  });

  it("filters app slash commands when a provider exposes the same command natively", () => {
    const availableCommands = getAvailableComposerSlashCommands({
      provider: "codex",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      canOfferSideCommand: true,
      providerNativeCommandNames: ["fast", "/model", "status"],
    });

    expect(availableCommands).not.toContain("fast");
    expect(availableCommands).not.toContain("model");
    expect(availableCommands).not.toContain("status");
    expect(hasProviderNativeSlashCommand("codex", ["/fast", "model"], "fast")).toBe(true);
    expect(hasProviderNativeSlashCommand("codex", ["/fast", "model"], "/model")).toBe(true);
  });

  it("keeps app-level /review available for codex even when native review exists", () => {
    const availableCommands = getAvailableComposerSlashCommands({
      provider: "codex",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      canOfferSideCommand: true,
      providerNativeCommandNames: ["review"],
    });

    expect(availableCommands).toContain("review");
    expect(shouldHideProviderNativeCommandFromComposerMenu("codex", "review")).toBe(true);
    expect(shouldHideProviderNativeCommandFromComposerMenu("codex", "status")).toBe(false);
  });

  it("routes opencode /review to the text fallback (ACP silent-drop, #218)", () => {
    // opencode exposes `review` in its native command list, but its ACP agent silently
    // drops `/`-prefixed prompts for unrecognized slash commands (opencode #27528). The
    // native command cannot be dispatched via ACP, so nativeReviewDispatchable must return
    // false for opencode — this makes /review fall through to the text fallback prompt
    // (not `/`-prefixed, processed as a normal coding request).
    expect(nativeReviewDispatchable("opencode")).toBe(false);
    // All other providers that expose `review` can dispatch it (Codex via startReview
    // JSON-RPC; others via ACP when their parser handles it).
    expect(nativeReviewDispatchable("codex")).toBe(true);
    expect(nativeReviewDispatchable("claudeAgent")).toBe(true);
    expect(nativeReviewDispatchable("cursor")).toBe(true);
    expect(nativeReviewDispatchable("gemini")).toBe(true);
    expect(nativeReviewDispatchable("grok")).toBe(true);
    expect(nativeReviewDispatchable("kilo")).toBe(true);
    expect(nativeReviewDispatchable("pi")).toBe(true);
  });

  it("keeps app-level /automation available even if a provider exposes a native collision", () => {
    const availableCommands = getAvailableComposerSlashCommands({
      provider: "gemini",
      supportsFastSlashCommand: false,
      canOfferCompactCommand: false,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      canOfferSideCommand: true,
      providerNativeCommandNames: ["automation"],
    });

    expect(availableCommands).toContain("automation");
    expect(shouldHideProviderNativeCommandFromComposerMenu("gemini", "automation")).toBe(true);
  });

  it("only exposes the app-level /side command for claude", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "claudeAgent",
        supportsFastSlashCommand: true,
        canOfferCompactCommand: true,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        canOfferSideCommand: true,
      }),
    ).toEqual(["side", "automation"]);
  });

  it("only offers /compact when Codex compaction is available", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "codex",
        supportsFastSlashCommand: true,
        canOfferCompactCommand: true,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        canOfferSideCommand: true,
      }),
    ).toContain("compact");

    expect(
      getAvailableComposerSlashCommands({
        provider: "codex",
        supportsFastSlashCommand: true,
        canOfferCompactCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        canOfferSideCommand: true,
      }),
    ).not.toContain("compact");
  });

  it("exposes shared app slash commands for gemini", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "gemini",
        supportsFastSlashCommand: false,
        canOfferCompactCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        canOfferSideCommand: true,
      }),
    ).toEqual([
      "clear",
      "model",
      "plan",
      "default",
      "review",
      "fork",
      "side",
      "status",
      "subagents",
      "automation",
      "goal",
      "loop",
    ]);
  });

  it("treats claude aliases like /fork as provider-native collisions", () => {
    expect(hasProviderNativeSlashCommand("claudeAgent", ["branch", "model"], "fork")).toBe(true);
    expect(hasProviderNativeSlashCommand("claudeAgent", ["clear"], "reset")).toBe(true);
  });
});
