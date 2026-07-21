// FILE: useLoopStopErrorToast.test.ts
// Purpose: Guards the exceptional-stop toast policy (spec §14) — errors toast, routine stops don't.
// Layer: Pure logic tests

import type { ThreadId, ThreadLoop } from "@synara/contracts";
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
  getLoopStopErrorToastCopy,
  shouldToastLoopStop,
  useLoopStopErrorToast,
} from "./useLoopStopErrorToast";

function makeLoop(overrides: Partial<ThreadLoop>): ThreadLoop {
  return makeLoopFixture({ activationId: "act-1", active: false, ...overrides });
}

describe("getLoopStopErrorToastCopy", () => {
  it("returns copy only for exceptional stop reasons", () => {
    expect(getLoopStopErrorToastCopy("consecutive_errors")).toEqual({
      title: "Loop stopped after repeated errors",
      description: "Review the latest error before restarting.",
    });
    expect(getLoopStopErrorToastCopy("prompt_invalid")).not.toBeNull();
    expect(getLoopStopErrorToastCopy("thread_unrunnable")).not.toBeNull();
  });

  it("stays quiet for routine lifecycle stops", () => {
    expect(getLoopStopErrorToastCopy("budget_iterations")).toBeNull();
    expect(getLoopStopErrorToastCopy("budget_duration")).toBeNull();
    expect(getLoopStopErrorToastCopy("user_stop")).toBeNull();
    expect(getLoopStopErrorToastCopy("toggled_off")).toBeNull();
    expect(getLoopStopErrorToastCopy("hard_cap")).toBeNull();
    expect(getLoopStopErrorToastCopy("replaced_by_manual_policy")).toBeNull();
  });
});

describe("shouldToastLoopStop", () => {
  const stopped = makeLoop({ active: false, lastStopReason: "consecutive_errors" });

  it("toasts only on an observed active-to-stopped transition", () => {
    expect(shouldToastLoopStop({ activationId: "act-1", active: true }, stopped)).toBe(true);
  });

  it("does not toast for a loop already stopped on mount", () => {
    expect(shouldToastLoopStop(null, stopped)).toBe(false);
  });

  it("does not toast across different activations", () => {
    expect(shouldToastLoopStop({ activationId: "act-0", active: true }, stopped)).toBe(false);
  });

  it("does not toast while the loop is still active or has no reason", () => {
    expect(
      shouldToastLoopStop(
        { activationId: "act-1", active: true },
        makeLoop({ active: true, lastStopReason: null }),
      ),
    ).toBe(false);
    expect(
      shouldToastLoopStop(
        { activationId: "act-1", active: true },
        makeLoop({ active: false, lastStopReason: null }),
      ),
    ).toBe(false);
    expect(shouldToastLoopStop({ activationId: "act-1", active: true }, null)).toBe(false);
  });
});

describe("useLoopStopErrorToast", () => {
  const threadId = "thread-1" as ThreadId;

  beforeEach(() => {
    reactHarness.reset();
  });

  function render(
    currentThreadId: ThreadId | null,
    loop: ThreadLoop | null,
    addToast: (toast: { title: string; description: string; threadId: ThreadId | null }) => void,
  ) {
    reactHarness.beginRender();
    useLoopStopErrorToast(currentThreadId, loop, addToast);
  }

  // Which reasons toast is owned by the getLoopStopErrorToastCopy tests; the
  // hook tests only cover transition wiring.
  it("toasts when an active loop stops with an exceptional reason", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "consecutive_errors" }), addToast);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({
      ...getLoopStopErrorToastCopy("consecutive_errors"),
      threadId,
    });
  });

  it("stays quiet when an active loop stops with a routine reason", () => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: "user_stop" }), addToast);
    expect(addToast).not.toHaveBeenCalled();
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
    render(threadId, makeLoop({ active: true, activationId: "act-1" }), addToast);
    render(
      threadId,
      makeLoop({ active: false, activationId: "act-2", lastStopReason: "consecutive_errors" }),
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
});
