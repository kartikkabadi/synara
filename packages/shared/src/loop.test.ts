// FILE: loop.test.ts
// Purpose: Unit tests for `/loop` command parsing.
// Layer: Shared runtime utility tests
// Depends on: Vitest and loop parser

import { describe, expect, it } from "vitest";

import {
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
  LOOP_PROMPT_MAX_INPUT_CHARS,
} from "@synara/contracts";

import { parseLoopCommand, validateLoopBudget } from "./loop";

describe("validateLoopBudget", () => {
  it("accepts a budget-less loop", () => {
    expect(validateLoopBudget({ maxIterations: null, durationSeconds: null })).toBeNull();
  });

  it("accepts in-range count and duration budgets", () => {
    expect(validateLoopBudget({ maxIterations: 1, durationSeconds: null })).toBeNull();
    expect(
      validateLoopBudget({ maxIterations: LOOP_MAX_COUNT_BUDGET, durationSeconds: null }),
    ).toBeNull();
    expect(validateLoopBudget({ maxIterations: null, durationSeconds: 1 })).toBeNull();
    expect(
      validateLoopBudget({ maxIterations: null, durationSeconds: LOOP_MAX_DURATION_SECONDS }),
    ).toBeNull();
  });

  it("rejects setting both budgets", () => {
    expect(validateLoopBudget({ maxIterations: 3, durationSeconds: 60 })).toEqual({
      field: "budget",
      reason: "both_set",
    });
  });

  it("rejects out-of-range budgets", () => {
    expect(validateLoopBudget({ maxIterations: 0, durationSeconds: null })).toEqual({
      field: "maxIterations",
      reason: "too_small",
    });
    expect(
      validateLoopBudget({ maxIterations: LOOP_MAX_COUNT_BUDGET + 1, durationSeconds: null }),
    ).toEqual({ field: "maxIterations", reason: "too_large" });
    expect(validateLoopBudget({ maxIterations: null, durationSeconds: 0 })).toEqual({
      field: "durationSeconds",
      reason: "too_small",
    });
    expect(
      validateLoopBudget({ maxIterations: null, durationSeconds: LOOP_MAX_DURATION_SECONDS + 1 }),
    ).toEqual({ field: "durationSeconds", reason: "too_large" });
  });
});

describe("parseLoopCommand", () => {
  it("returns null for text that is not a /loop command", () => {
    expect(parseLoopCommand("hello world")).toBeNull();
    expect(parseLoopCommand("/goal 10")).toBeNull();
  });

  it("parses bare /loop as no budget and no prompt", () => {
    expect(parseLoopCommand("/loop")).toEqual({
      kind: "valid",
      budget: null,
      prompt: null,
    });
    expect(parseLoopCommand("  /loop  ")).toEqual({
      kind: "valid",
      budget: null,
      prompt: null,
    });
  });

  it("parses /loop <count>", () => {
    expect(parseLoopCommand("/loop 10")).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 10 },
      prompt: null,
    });
  });

  it("parses /loop <count> <prompt>", () => {
    expect(parseLoopCommand("/loop 10 fix the failing tests")).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 10 },
      prompt: "fix the failing tests",
    });
  });

  it("parses /loop <duration>", () => {
    expect(parseLoopCommand("/loop 20m")).toEqual({
      kind: "valid",
      budget: { kind: "duration", seconds: 20 * 60 },
      prompt: null,
    });
    expect(parseLoopCommand("/loop 1h")).toEqual({
      kind: "valid",
      budget: { kind: "duration", seconds: 60 * 60 },
      prompt: null,
    });
    expect(parseLoopCommand("/loop 30s")).toEqual({
      kind: "valid",
      budget: { kind: "duration", seconds: 30 },
      prompt: null,
    });
  });

  it("parses /loop <duration> <prompt>", () => {
    expect(parseLoopCommand("/loop 20m keep addressing CI failures")).toEqual({
      kind: "valid",
      budget: { kind: "duration", seconds: 20 * 60 },
      prompt: "keep addressing CI failures",
    });
  });

  it("rejects a prompt without an explicit budget", () => {
    expect(parseLoopCommand("/loop fix the tests")).toEqual({
      kind: "invalid",
      reason: "missing_budget",
    });
  });

  it("preserves interior newlines in the prompt", () => {
    const result = parseLoopCommand("/loop 3 line one\n\nline two");
    expect(result).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 3 },
      prompt: "line one\n\nline two",
    });
  });

  it("rejects /loop 0", () => {
    expect(parseLoopCommand("/loop 0")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
  });

  it("rejects /loop with a count greater than the max budget", () => {
    expect(parseLoopCommand(`/loop ${LOOP_MAX_COUNT_BUDGET + 1}`)).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
  });

  it("accepts /loop with a count up to the max budget", () => {
    expect(parseLoopCommand(`/loop ${LOOP_MAX_COUNT_BUDGET}`)).toEqual({
      kind: "valid",
      budget: { kind: "count", value: LOOP_MAX_COUNT_BUDGET },
      prompt: null,
    });
    expect(parseLoopCommand("/loop 50 fix the tests")).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 50 },
      prompt: "fix the tests",
    });
  });

  it("rejects malformed durations", () => {
    expect(parseLoopCommand("/loop 10m5s")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
    expect(parseLoopCommand("/loop 1.5m")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
    expect(parseLoopCommand("/loop 2d")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
  });

  it("rejects negative counts", () => {
    expect(parseLoopCommand("/loop -3")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
  });

  it("rejects two budget tokens", () => {
    expect(parseLoopCommand("/loop 10 5m")).toEqual({
      kind: "invalid",
      reason: "ambiguous_second_budget",
    });
    expect(parseLoopCommand("/loop 5m 10")).toEqual({
      kind: "invalid",
      reason: "ambiguous_second_budget",
    });
  });

  it("treats a bare budget with trailing whitespace as a valid budget only", () => {
    expect(parseLoopCommand("/loop 10   ")).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 10 },
      prompt: null,
    });
    expect(parseLoopCommand("/loop 10 ")).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 10 },
      prompt: null,
    });
  });

  it("rejects a prompt that starts with /", () => {
    expect(parseLoopCommand("/loop /fix")).toEqual({
      kind: "invalid",
      reason: "prompt_starts_with_slash",
    });
    expect(parseLoopCommand("/loop 10 /fix")).toEqual({
      kind: "invalid",
      reason: "prompt_starts_with_slash",
    });
  });

  it("rejects a prompt longer than the canonical turn-input bound", () => {
    const tooLong = "x".repeat(LOOP_PROMPT_MAX_INPUT_CHARS + 1);
    expect(parseLoopCommand(`/loop ${tooLong}`)).toEqual({
      kind: "invalid",
      reason: "prompt_too_long",
    });
    expect(parseLoopCommand(`/loop 10 ${tooLong}`)).toEqual({
      kind: "invalid",
      reason: "prompt_too_long",
    });
  });

  it("rejects a duration larger than 24 hours", () => {
    expect(parseLoopCommand("/loop 25h")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
  });

  it("does not match similar-looking slash commands", () => {
    expect(parseLoopCommand("/loophole 10")).toBeNull();
    expect(parseLoopCommand("/loops 10")).toBeNull();
    expect(parseLoopCommand("/loopback")).toBeNull();
  });

  it("rejects malformed signed counts", () => {
    expect(parseLoopCommand("/loop +3")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
    expect(parseLoopCommand("/loop -3")).toEqual({
      kind: "invalid",
      reason: "invalid_budget",
    });
  });

  it("handles Unicode whitespace around the command", () => {
    expect(parseLoopCommand("\u00A0/loop 5\u00A0")).toEqual({
      kind: "valid",
      budget: { kind: "count", value: 5 },
      prompt: null,
    });
  });
});
