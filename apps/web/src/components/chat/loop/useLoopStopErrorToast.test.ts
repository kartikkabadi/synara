// FILE: useLoopStopErrorToast.test.ts
// Purpose: Guards the exceptional-stop toast policy (spec §14) — errors toast, routine stops don't.
// Layer: Pure logic tests

import {
  LoopActivationId,
  type LoopStopReason,
  type ThreadId,
  type ThreadLoop,
} from "@synara/contracts";
import { makeLoop as makeLoopFixture } from "@synara/shared/loopTestFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }

  let slots: HookSlot[] = [];
  let cursor = 0;

  const nextSlot = () => {
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useRef<T>(initialValue: T) {
      const slot = nextSlot();
      slot.value ??= { current: initialValue };
      return slot.value as { current: T };
    },
  };
});

vi.mock("react", () => ({
  useEffect: reactHarness.useEffect,
  useRef: reactHarness.useRef,
}));

import {
  resetLoopStopToastDedupeForTest,
  shouldToastLoopStop,
  useLoopStopErrorToast,
} from "./useLoopStopErrorToast";
import { formatLoopStopReasonShort } from "./presentation";

function makeLoop(overrides: Partial<ThreadLoop>): ThreadLoop {
  return makeLoopFixture({ activationId: "act-1", active: false, ...overrides });
}

describe("shouldToastLoopStop", () => {
  const stopped = makeLoop({ active: false, lastStopReason: "consecutive_errors" });

  it("toasts only on an observed active-to-stopped transition", () => {
    expect(
      shouldToastLoopStop(
        { activationId: LoopActivationId.makeUnsafe("act-1"), active: true },
        stopped,
      ),
    ).toBe(true);
  });

  it("does not toast for a loop already stopped on mount", () => {
    expect(shouldToastLoopStop(null, stopped)).toBe(false);
  });

  it("does not toast across different activations", () => {
    expect(
      shouldToastLoopStop(
        { activationId: LoopActivationId.makeUnsafe("act-0"), active: true },
        stopped,
      ),
    ).toBe(false);
  });

  it("does not toast while the loop is still active or has no reason", () => {
    expect(
      shouldToastLoopStop(
        { activationId: LoopActivationId.makeUnsafe("act-1"), active: true },
        makeLoop({ active: true, lastStopReason: null }),
      ),
    ).toBe(false);
    expect(
      shouldToastLoopStop(
        { activationId: LoopActivationId.makeUnsafe("act-1"), active: true },
        makeLoop({ active: false, lastStopReason: null }),
      ),
    ).toBe(false);
    expect(
      shouldToastLoopStop(
        { activationId: LoopActivationId.makeUnsafe("act-1"), active: true },
        null,
      ),
    ).toBe(false);
  });
});

describe("useLoopStopErrorToast", () => {
  const threadId = "thread-1" as ThreadId;

  beforeEach(() => {
    reactHarness.reset();
    resetLoopStopToastDedupeForTest();
  });

  function render(
    currentThreadId: ThreadId | null,
    loop: ThreadLoop | null,
    addToast: (toast: {
      title: string;
      description: string;
      tone: "error" | "warning";
      threadId: ThreadId | null;
    }) => void,
  ) {
    reactHarness.beginRender();
    useLoopStopErrorToast(currentThreadId, loop, addToast);
  }

  it.each(["consecutive_errors", "prompt_invalid", "thread_unrunnable"] as LoopStopReason[])(
    "toasts when an active loop stops with %s",
    (reason) => {
      const addToast = vi.fn();
      render(threadId, makeLoop({ active: true }), addToast);
      render(threadId, makeLoop({ active: false, lastStopReason: reason }), addToast);
      expect(addToast).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith({
        ...formatLoopStopReasonShort(reason),
        threadId,
      });
    },
  );

  it.each([
    "user_stop",
    "toggled_off",
    "budget_iterations",
    "budget_duration",
    "hard_cap",
  ] as LoopStopReason[])("stays quiet when an active loop stops with %s", (reason) => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: reason }), addToast);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("toasts a warning when a manual message replaces the loop", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(
      threadId,
      makeLoop({ active: false, lastStopReason: "replaced_by_manual_policy" }),
      addToast,
    );
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({
      ...formatLoopStopReasonShort("replaced_by_manual_policy"),
      threadId,
    });
    expect(addToast.mock.calls[0]?.[0]?.tone).toBe("warning");
  });

  it("stays quiet for a loop already stopped on first render", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("stays quiet when switching to a thread whose loop already stopped", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(
      "thread-2" as ThreadId,
      makeLoop({ active: false, lastStopReason: "consecutive_errors" }),
      addToast,
    );
    expect(addToast).not.toHaveBeenCalled();
  });

  it("stays quiet when a new activation appears already stopped", () => {
    const addToast = vi.fn();
    render(
      threadId,
      makeLoop({ active: true, activationId: LoopActivationId.makeUnsafe("act-1") }),
      addToast,
    );
    render(
      threadId,
      makeLoop({
        active: false,
        activationId: LoopActivationId.makeUnsafe("act-2"),
        lastStopReason: "consecutive_errors",
      }),
      addToast,
    );
    expect(addToast).not.toHaveBeenCalled();
  });

  it("toasts once per stop, not on subsequent renders", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    const stopped = makeLoop({ active: false, lastStopReason: "consecutive_errors" });
    render(threadId, stopped, addToast);
    render(threadId, stopped, addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it("toasts once when the same activation stops with the same reason twice", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it("toasts once across multiple mounted consumers observing the same stop", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    // A second mount (fresh hook state) replaying the same transition.
    reactHarness.reset();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it("toasts again for a new activation that stops with the same reason", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    render(
      threadId,
      makeLoop({ active: true, activationId: LoopActivationId.makeUnsafe("act-2") }),
      addToast,
    );
    render(
      threadId,
      makeLoop({
        active: false,
        activationId: LoopActivationId.makeUnsafe("act-2"),
        lastStopReason: "consecutive_errors",
      }),
      addToast,
    );
    expect(addToast).toHaveBeenCalledTimes(2);
  });
});
