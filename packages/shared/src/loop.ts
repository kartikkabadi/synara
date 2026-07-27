// FILE: loop.ts
// Purpose: Parse `/loop` composer commands into a normalized arm/reconfigure payload.
// Layer: Shared runtime utility
// Depends on: No runtime dependencies.

import {
  LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD,
  LOOP_DEFAULT_HARD_CAP,
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
  LOOP_PROMPT_MAX_INPUT_CHARS,
} from "@synara/contracts";

export type LoopBudget = { kind: "count"; value: number } | { kind: "duration"; seconds: number };

export type LoopParseErrorReason =
  | "invalid_budget"
  | "missing_budget"
  | "ambiguous_second_budget"
  | "prompt_starts_with_slash"
  | "prompt_too_long";

export type LoopCommandParseResult =
  | { kind: "valid"; budget: LoopBudget | null; prompt: string | null }
  | { kind: "invalid"; reason: LoopParseErrorReason };

export type LoopBudgetValidationError =
  | { field: "budget"; reason: "both_set" }
  | { field: "maxIterations"; reason: "too_small" | "too_large" }
  | { field: "durationSeconds"; reason: "too_small" | "too_large" };

/**
 * Canonical server/web bounds for explicit loop budgets: count 1..100,
 * duration 1s..24h, and at most one of the two. Returns null when valid.
 */
export function validateLoopBudget(input: {
  maxIterations: number | null;
  durationSeconds: number | null;
}): LoopBudgetValidationError | null {
  if (input.maxIterations !== null && input.durationSeconds !== null) {
    return { field: "budget", reason: "both_set" };
  }
  if (input.maxIterations !== null) {
    if (input.maxIterations < 1) {
      return { field: "maxIterations", reason: "too_small" };
    }
    if (input.maxIterations > LOOP_MAX_COUNT_BUDGET) {
      return { field: "maxIterations", reason: "too_large" };
    }
  }
  if (input.durationSeconds !== null) {
    if (input.durationSeconds < 1) {
      return { field: "durationSeconds", reason: "too_small" };
    }
    if (input.durationSeconds > LOOP_MAX_DURATION_SECONDS) {
      return { field: "durationSeconds", reason: "too_large" };
    }
  }
  return null;
}

const COUNT_RE = /^[1-9][0-9]*$/;
const DURATION_RE = /^([1-9][0-9]*)(s|m|min|mins|h|hr|hrs)$/i;

function normalizeWhitespace(value: string): string {
  // Unicode whitespace trim; preserves interior newlines and spaces.
  return value.replace(/^\s+/, "").replace(/\s+$/, "");
}

function isCount(token: string): { valid: true; value: number } | { valid: false } {
  if (!COUNT_RE.test(token)) {
    return { valid: false };
  }
  const value = Number(token);
  if (value > LOOP_MAX_COUNT_BUDGET) {
    return { valid: false };
  }
  return { valid: true, value };
}

function isDuration(token: string): { valid: true; seconds: number } | { valid: false } {
  const match = DURATION_RE.exec(token);
  if (!match) {
    return { valid: false };
  }
  const rawValue = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  let seconds: number;
  if (unit === "s") {
    seconds = rawValue;
  } else if (unit.startsWith("m")) {
    seconds = rawValue * 60;
  } else {
    // h, hr, hrs
    seconds = rawValue * 60 * 60;
  }
  if (seconds < 1 || seconds > LOOP_MAX_DURATION_SECONDS) {
    return { valid: false };
  }
  return { valid: true, seconds };
}

function isBudgetToken(token: string): { valid: true; budget: LoopBudget } | { valid: false } {
  const count = isCount(token);
  if (count.valid) {
    return { valid: true, budget: { kind: "count", value: count.value } };
  }
  const duration = isDuration(token);
  if (duration.valid) {
    return { valid: true, budget: { kind: "duration", seconds: duration.seconds } };
  }
  return { valid: false };
}

/**
 * Tokenize on Unicode whitespace after the leading `/loop`.
 *
 * Supported forms (issue #49):
 * - `/loop`
 * - `/loop <count>`
 * - `/loop <duration>`
 * - `/loop <count> <prompt...>`
 * - `/loop <duration> <prompt...>`
 *
 * `/loop <prompt...>` without an explicit budget is intentionally rejected.
 * Reject malformed budgets, two consecutive budget tokens, empty/leading-slash prompts.
 */
export function parseLoopCommand(text: string): LoopCommandParseResult | null {
  const trimmed = text.trimStart();
  // `/loop` is the entire command word; require whitespace or end of string
  // after it so `/loophole` is not accepted as a loop command.
  const prefixMatch = /^\/loop(?:\s|$)/i.exec(trimmed);
  if (!prefixMatch) {
    return null;
  }

  // Trim leading and trailing whitespace after `/loop` so trailing spaces around
  // a bare budget token are not misread as an explicitly empty inline prompt.
  const commandArgs = normalizeWhitespace(trimmed.slice(prefixMatch[0].length));
  if (commandArgs.length === 0) {
    return { kind: "valid", budget: null, prompt: null };
  }

  // Find the first whitespace-delimited token to decide budget-vs-prompt.
  const firstTokenMatch = commandArgs.match(/^\S*/);
  if (!firstTokenMatch) {
    return { kind: "valid", budget: null, prompt: null };
  }

  const firstToken = firstTokenMatch[0]!;
  const rest = commandArgs.slice(firstToken.length);

  const budgetCheck = isBudgetToken(firstToken);

  if (!budgetCheck.valid) {
    // Any token that begins with a digit or sign and is not a valid budget is
    // treated as a malformed budget attempt and rejected.
    if (/^[-+]?\d/.test(firstToken)) {
      return { kind: "invalid", reason: "invalid_budget" };
    }

    // A prompt without an explicit count/duration budget is not part of the
    // locked issue #49 grammar. Validate it with the same server-side rules so
    // the parser reason matches the eventual server rejection.
    if (commandArgs[0] === "/") {
      return { kind: "invalid", reason: "prompt_starts_with_slash" };
    }
    if (commandArgs.length > LOOP_PROMPT_MAX_INPUT_CHARS) {
      return { kind: "invalid", reason: "prompt_too_long" };
    }
    return { kind: "invalid", reason: "missing_budget" };
  }

  // First token is a valid budget. The rest is the prompt.
  const normalizedRest = normalizeWhitespace(rest);
  if (rest.length > 0) {
    // The prompt cannot itself begin with something that would be parsed as a budget token,
    // because that would be an ambiguous second budget.
    const nextTokenMatch = rest.trimStart().match(/^\S*/);
    const nextToken = nextTokenMatch?.[0];
    if (nextToken && isBudgetToken(nextToken).valid) {
      return { kind: "invalid", reason: "ambiguous_second_budget" };
    }
    if (normalizedRest.length > LOOP_PROMPT_MAX_INPUT_CHARS) {
      return { kind: "invalid", reason: "prompt_too_long" };
    }
    if (normalizedRest.length > 0 && normalizedRest[0] === "/") {
      return { kind: "invalid", reason: "prompt_starts_with_slash" };
    }
  }

  const prompt = normalizedRest.length > 0 ? normalizedRest : null;

  return { kind: "valid", budget: budgetCheck.budget, prompt };
}

export {
  LOOP_DEFAULT_HARD_CAP,
  LOOP_DEFAULT_CONSECUTIVE_ERROR_THRESHOLD,
  LOOP_MAX_COUNT_BUDGET,
  LOOP_MAX_DURATION_SECONDS,
};
