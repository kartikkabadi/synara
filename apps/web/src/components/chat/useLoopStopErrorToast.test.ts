// FILE: useLoopStopErrorToast.test.ts
// Purpose: Guards the exceptional-stop toast policy (spec §14) — errors toast, routine stops don't.
// Layer: Pure logic tests

import type { LoopStopReason, ThreadId, ThreadLoop } from "@synara/contracts";
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

import { shouldToastLoopStop, useLoopStopErrorToast } from "./useLoopStopErrorToast";
import { formatLoopStopReasonShort } from "./loopPresentation";

function makeLoop(overrides: Partial<ThreadLoop>): ThreadLoop {
  return {
    activationId: "act-1",
    active: false,
    prompt: "fix the tests",
    iteration: 3,
    maxIterations: 5,
    endsAt: null,
    hardCap: 100,
    consecutiveErrors: 0,
    lastStopReason: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:10:00.000Z",
    ...overrides,
  } as ThreadLoop;
}

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
    "replaced_by_manual_policy",
  ] as LoopStopReason[])("stays quiet when an active loop stops with %s", (reason) => {
    const addToast = vi.fn();
    render(threadId, makeLoop({ active: true }), addToast);
    render(threadId, makeLoop({ active: false, lastStopReason: reason }), addToast);
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
