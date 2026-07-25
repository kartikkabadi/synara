// FILE: userTurnMarker.test.ts
// Purpose: Guards the marker-chip predicate shared by the transcript renderer
// and the timeline height estimator, including precedence between origins.
// Layer: Pure logic tests

import { describe, expect, it } from "vitest";
import { resolveUserTurnMarker } from "./userTurnMarker";

describe("resolveUserTurnMarker", () => {
  it("marks steered dispatches", () => {
    expect(resolveUserTurnMarker({ dispatchMode: "steer" })).toBe("steer");
    expect(resolveUserTurnMarker({ dispatchMode: "steer", dispatchOrigin: "user" })).toBe("steer");
  });

  it("leaves plain queued user messages unmarked", () => {
    expect(resolveUserTurnMarker({ dispatchMode: "queue", dispatchOrigin: "user" })).toBeNull();
    expect(resolveUserTurnMarker({})).toBeNull();
  });

  it("marks manual loop retargets as loop-steer", () => {
    expect(
      resolveUserTurnMarker({
        dispatchMode: "queue",
        dispatchOrigin: "user",
        purpose: { kind: "loop-iteration" },
      }),
    ).toBe("loop-steer");
  });

  it("leaves automatic loop iterations unmarked", () => {
    // Server-generated iterations carry the purpose but no user origin.
    expect(
      resolveUserTurnMarker({ dispatchMode: "queue", purpose: { kind: "loop-iteration" } }),
    ).toBeNull();
  });

  it("keeps server-origin precedence over loop and steer markers", () => {
    expect(
      resolveUserTurnMarker({
        dispatchOrigin: "automation",
        dispatchMode: "steer",
        purpose: { kind: "loop-iteration" },
      }),
    ).toBe("automation");
    expect(
      resolveUserTurnMarker({
        dispatchOrigin: "agent",
        dispatchMode: "steer",
        purpose: { kind: "loop-iteration" },
      }),
    ).toBe("agent");
  });
});
