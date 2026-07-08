import { describe, expect, it } from "vitest";

import { supportsRollback } from "./providerDiscoveryReactQuery.ts";

describe("supportsRollback", () => {
  it("is false while capabilities are still loading", () => {
    expect(supportsRollback(undefined)).toBe(false);
  });

  it("is false when the provider explicitly disables rollback", () => {
    expect(supportsRollback({ supportsRollback: false })).toBe(false);
  });

  it("defaults to true once capabilities have loaded without an explicit false", () => {
    expect(supportsRollback({})).toBe(true);
    expect(supportsRollback({ supportsRollback: true })).toBe(true);
  });
});
