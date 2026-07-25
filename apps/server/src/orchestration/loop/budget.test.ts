import { makeLoop } from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { isLoopBudgetExhausted, isLoopExpired } from "./budget.ts";

const NOW = new Date("2026-07-19T12:00:00.000Z").getTime();

describe("isLoopExpired", () => {
  it("never expires without a duration budget", () => {
    expect(isLoopExpired(makeLoop({ endsAt: null }), NOW)).toBe(false);
  });

  it("is not expired before endsAt", () => {
    expect(isLoopExpired(makeLoop({ endsAt: "2026-07-19T13:00:00.000Z" }), NOW)).toBe(false);
  });

  it("expires at and after endsAt", () => {
    expect(isLoopExpired(makeLoop({ endsAt: "2026-07-19T12:00:00.000Z" }), NOW)).toBe(true);
    expect(isLoopExpired(makeLoop({ endsAt: "2026-07-19T11:00:00.000Z" }), NOW)).toBe(true);
  });

  it("fails closed on an unparseable endsAt", () => {
    expect(isLoopExpired(makeLoop({ endsAt: "not-a-date" }), NOW)).toBe(true);
  });
});

describe("isLoopBudgetExhausted", () => {
  it("is exhausted at the explicit maxIterations", () => {
    expect(isLoopBudgetExhausted(makeLoop({ iteration: 5, maxIterations: 5 }))).toBe(true);
    expect(isLoopBudgetExhausted(makeLoop({ iteration: 4, maxIterations: 5 }))).toBe(false);
  });

  it("falls back to the hard cap without an explicit budget", () => {
    expect(isLoopBudgetExhausted(makeLoop({ iteration: 100, maxIterations: null }))).toBe(true);
    expect(isLoopBudgetExhausted(makeLoop({ iteration: 99, maxIterations: null }))).toBe(false);
  });

  it("caps an explicit budget at the hard cap", () => {
    expect(isLoopBudgetExhausted(makeLoop({ iteration: 100, maxIterations: 500 }))).toBe(true);
  });
});
