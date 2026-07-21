import { describe, expect, it } from "vitest";

import { isAbortLikeProviderErrorMessage } from "./abortErrorClassification.ts";

describe("isAbortLikeProviderErrorMessage", () => {
  it.each([
    "Aborted",
    "aborted.",
    "AbortError: The user aborted a request.",
    "The operation was aborted",
    "This operation was aborted",
    "Request was aborted",
    "signal is aborted without reason",
    "Turn aborted",
    "Interrupted by user.",
    "cancelled by user",
    "canceled by the user",
    "write_stdin failed: stdin is closed for this session",
  ])("classifies %j as abort-like", (message) => {
    expect(isAbortLikeProviderErrorMessage(message)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "boom",
    "Provider runtime error",
    "rate limit exceeded",
    "model output aborted the parser", // no cancellation subject phrasing
    "connection reset by peer",
  ])("does not classify %j as abort-like", (message) => {
    expect(isAbortLikeProviderErrorMessage(message)).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(isAbortLikeProviderErrorMessage(null)).toBe(false);
    expect(isAbortLikeProviderErrorMessage(undefined)).toBe(false);
  });
});
