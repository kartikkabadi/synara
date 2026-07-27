import type { ThreadLoop, ThreadTurnPurpose } from "@synara/contracts";
import { LoopActivationId } from "@synara/contracts";
import { LOOP_FIXTURE_ACTIVATION_ID, makeLoop } from "@synara/shared/loopTestFixtures";
import { describe, expect, it } from "vitest";

import { classifyLoopTurnAuthority } from "./queuedTurnAuthority.ts";

function purposeFor(iteration: number, activationId = LOOP_FIXTURE_ACTIVATION_ID) {
  return {
    kind: "loop-iteration",
    activationId,
    iteration,
  } as ThreadTurnPurpose;
}

function threadWith(
  loop: ThreadLoop | null,
  overrides: Partial<{ deletedAt: string | null; archivedAt: string | null }> = {},
) {
  return {
    deletedAt: null,
    archivedAt: null,
    loop,
    ...overrides,
  };
}

describe("classifyLoopTurnAuthority", () => {
  it("authorizes a turn matching the live activation and iteration", () => {
    const result = classifyLoopTurnAuthority({
      thread: threadWith(makeLoop({ iteration: 2 })),
      purpose: purposeFor(2),
    });
    expect(result).toBe("authorized");
  });

  it("is stale when the thread is missing, deleted, or archived", () => {
    const loop = makeLoop({ iteration: 2 });
    expect(classifyLoopTurnAuthority({ thread: undefined, purpose: purposeFor(2) })).toBe(
      "stale_activation",
    );
    expect(
      classifyLoopTurnAuthority({
        thread: threadWith(loop, { deletedAt: "2026-07-19T12:00:00.000Z" }),
        purpose: purposeFor(2),
      }),
    ).toBe("stale_activation");
    expect(
      classifyLoopTurnAuthority({
        thread: threadWith(loop, { archivedAt: "2026-07-19T12:00:00.000Z" }),
        purpose: purposeFor(2),
      }),
    ).toBe("stale_activation");
  });

  it("is stale when the loop is off or the activation differs", () => {
    expect(
      classifyLoopTurnAuthority({
        thread: threadWith(makeLoop({ active: false, iteration: 2 })),
        purpose: purposeFor(2),
      }),
    ).toBe("stale_activation");
    expect(
      classifyLoopTurnAuthority({
        thread: threadWith(makeLoop({ iteration: 2 })),
        purpose: purposeFor(2, LoopActivationId.makeUnsafe("activation-other")),
      }),
    ).toBe("stale_activation");
  });

  it("reports an iteration mismatch on the live activation", () => {
    expect(
      classifyLoopTurnAuthority({
        thread: threadWith(makeLoop({ iteration: 3 })),
        purpose: purposeFor(2),
      }),
    ).toBe("iteration_mismatch");
  });
});
