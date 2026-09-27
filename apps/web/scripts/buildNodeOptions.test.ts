import { describe, expect, it } from "vitest";
import { withHeapLimit } from "./buildNodeOptions.mjs";

describe("withHeapLimit", () => {
  it("appends the heap flag when NODE_OPTIONS is empty", () => {
    expect(withHeapLimit("", 6144)).toBe("--max-old-space-size=6144");
  });

  it("appends while preserving unrelated options", () => {
    expect(withHeapLimit("--enable-source-maps", 6144)).toBe(
      "--enable-source-maps --max-old-space-size=6144",
    );
  });

  it("keeps an existing dash-spelled heap flag", () => {
    expect(withHeapLimit("--max-old-space-size=2048", 6144)).toBe("--max-old-space-size=2048");
  });

  it("keeps an existing underscore-spelled heap flag", () => {
    expect(withHeapLimit("--max_old_space_size=2048", 6144)).toBe("--max_old_space_size=2048");
  });

  it("keeps a mixed-separator heap flag among other options", () => {
    expect(withHeapLimit("--enable-source-maps --max_old-space_size=2048", 6144)).toBe(
      "--enable-source-maps --max_old-space_size=2048",
    );
  });

  it("does not match the flag as a substring of another option", () => {
    expect(withHeapLimit("--some--max-old-space-size-lookalike=1", 6144)).toBe(
      "--some--max-old-space-size-lookalike=1 --max-old-space-size=6144",
    );
  });
});
