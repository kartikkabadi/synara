// FILE: Island.tsx
// Purpose: Renderer for the always-on-top island overlay window: pill, hover preview, expanded rows.
// Layer: Web island UI
// Why: Runs in its own transparent BrowserWindow (see apps/desktop/src/island/), so it keeps its
//      own WebSocket shell subscription instead of relying on the main app shell.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
} from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type IslandDisplayContext,
  type IslandWindowState,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
  type ProviderKind,
} from "@synara/contracts";
import { islandShellMode, islandStateSize } from "@synara/shared/islandGeometry";

import { ensureNativeApi } from "~/nativeApi";
import {
  aggregateIslandStatus,
  createShellThreadStore,
  deriveIslandSessions,
  findPopTransition,
  islandRelativeTime,
  sortIslandSessions,
  type IslandSession,
  type IslandSessionStatus,
} from "~/lib/islandSessionTracker";
import { XIcon } from "~/lib/icons";
import { cn, isMacPlatform } from "~/lib/utils";

import { IslandOrb, orbStateForStatus } from "./IslandOrb";
import "./island.css";

const AUTO_POP_MS = 4_000;
const EXPANDED_IDLE_COLLAPSE_MS = 13_000;
// Pointer must dwell before the hover state opens, so a quick pass-through
// never flashes the preview.
export const HOVER_OPEN_DELAY_MS = 120;
// Pointer leaving hover doesn't collapse until this grace elapses, so a brief
// exit + re-enter keeps the preview open.
export const HOVER_EXIT_GRACE_MS = 150;
// Fallback unmount for the leaving layer: the layer normally unmounts on its
// leave animation's end event; this timer only catches a missing event (e.g.
// the tab losing rendering). Longer than any morph so it never cuts early.
const CONTENT_LEAVE_FALLBACK_MS = 600;
// Drives done-session pruning and relative timestamps between shell events.
const CLOCK_TICK_MS = 30_000;

// Dev-only visual harness: set `localStorage["island.mockSessions"] = "1"` to
// swap in fake rows so the populated layouts can be exercised without live
// agents. Dead code in production builds (import.meta.env.DEV is false).
const USE_MOCK_SESSIONS =
  import.meta.env.DEV &&
  typeof localStorage !== "undefined" &&
  localStorage.getItem("island.mockSessions") === "1";

const MOCK_SESSIONS: readonly IslandSession[] = [
  {
    threadId: "mock-1",
    title: "refactor-auth-middleware",
    provider: "codex",
    status: "working",
    lastActivityAt: new Date(Date.now() - 40_000).toISOString(),
  },
  {
    threadId: "mock-2",
    title: "fix-transcript-scroll",
    provider: "claudeAgent",
    status: "needs-approval",
    lastActivityAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
  {
    threadId: "mock-3",
    title: "island-visual-iteration",
    provider: "opencode",
    status: "done",
    lastActivityAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  },
];

let reducedMotionQuery: MediaQueryList | null = null;
function prefersReducedMotion(): boolean {
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery.matches;
}

// The window is pre-sized to the expanded bounds and only this inner container
// animates, using the same sizing as the Electron window.
function innerSize(
  state: IslandWindowState,
  context: IslandDisplayContext | null,
  sessionCount: number,
) {
  const notch = context?.notch ?? null;
  return islandStateSize(state, islandShellMode(notch), notch, sessionCount);
}

const STATUS_LABEL: Record<IslandSessionStatus, string> = {
  working: "Working…",
  "needs-approval": "Needs approval",
  done: "Done",
};

// Global-shortcut hint for the expanded header; the display context from the
// main process is authoritative, with the browser platform as a pre-load
// fallback. Only an explicit mac signal yields ⌘ — Windows/Linux must never
// show mac glyphs.
export function shortcutHint(context: IslandDisplayContext | null): string {
  let isMac = false;
  if (context) {
    isMac = context.platform === "macos";
  } else if (typeof navigator !== "undefined") {
    const uaData = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
    isMac = isMacPlatform(uaData?.platform ?? navigator.platform ?? "");
  }
  // Windows/Linux users read "Shift", not the mac ⇧ glyph.
  return isMac ? "\u2318\u21e7I" : "Ctrl+Shift+I";
}

function providerLabel(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider as ProviderKind] ?? provider;
}

// data-island-platform value: contract platform names → renderer attribute.
function platformAttribute(context: IslandDisplayContext | null): string {
  const platform = context?.platform ?? "other";
  if (platform === "macos") return "darwin";
  if (platform === "windows") return "win32";
  return platform;
}

export function Island() {
  const [context, setContext] = useState<IslandDisplayContext | null>(null);
  const [threads, setThreads] = useState<readonly OrchestrationThreadShell[]>([]);
  const [uiState, setUiState] = useState<IslandWindowState>("collapsed");
  const [popped, setPopped] = useState(false);
  const sessionsRef = useRef<readonly IslandSession[]>([]);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Mock rows go through the same priority sort as live sessions so the
  // headline and row order never disagree.
  const sessions = useMemo(
    () =>
      USE_MOCK_SESSIONS ? sortIslandSessions(MOCK_SESSIONS) : deriveIslandSessions(threads, nowMs),
    [threads, nowMs],
  );
  const aggregate = aggregateIslandStatus(sessions);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.documentElement.style.colorScheme = "dark";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    void window.islandBridge?.getContext().then((value) => setContext(value ?? null));
  }, []);

  useEffect(() => {
    return () => {
      if (popTimerRef.current) clearTimeout(popTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
      if (hoverExitTimerRef.current) clearTimeout(hoverExitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const api = ensureNativeApi();
    const store = createShellThreadStore();
    const disposeShellEvents = api.orchestration.onShellEvent(
      (item: OrchestrationShellStreamItem) => {
        if (store.handleStreamItem(item)) setThreads(store.threads());
      },
    );
    void api.orchestration.subscribeShell();
    void api.orchestration.getShellSnapshot().then((snapshot) => {
      if (store.applySnapshot(snapshot.threads)) setThreads(store.threads());
    });
    return () => {
      disposeShellEvents();
      void api.orchestration.unsubscribeShell();
    };
  }, []);

  // Auto-pop on needs-approval / turn-completed transitions: the island enters
  // the hover preview for AUTO_POP_MS, then returns to collapsed. The geometry
  // morph is the only motion.
  useEffect(() => {
    const transition = findPopTransition(sessionsRef.current, sessions);
    sessionsRef.current = sessions;
    if (!transition) return;
    setPopped(true);
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
    popTimerRef.current = setTimeout(() => setPopped(false), AUTO_POP_MS);
  }, [sessions]);

  // Expanded panel collapses after a period without pointer/key activity.
  const armIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setUiState("collapsed"), EXPANDED_IDLE_COLLAPSE_MS);
  }, []);

  useEffect(() => {
    if (uiState === "expanded") armIdleTimer();
    else if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, [uiState, armIdleTimer]);

  // Escape closes the expanded panel; any key inside it resets the idle timer.
  useEffect(() => {
    if (uiState !== "expanded") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUiState("collapsed");
        return;
      }
      armIdleTimer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [uiState, armIdleTimer]);

  // Global shortcut toggles arrive from the main process as requests; the
  // renderer owns the displayed state and computes the next one so a stale
  // main-process state can never invert the toggle.
  useEffect(() => {
    return window.islandBridge?.onToggleExpanded(() => {
      setPopped(false);
      setUiState((current) => (current === "expanded" ? "collapsed" : "expanded"));
    });
  }, []);

  const clearHoverTimers = useCallback(() => {
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
    if (hoverExitTimerRef.current) clearTimeout(hoverExitTimerRef.current);
    hoverExitTimerRef.current = null;
  }, []);

  const applyState = useCallback(
    (state: IslandWindowState) => {
      clearHoverTimers();
      setUiState(state);
    },
    [clearHoverTimers],
  );

  const onPointerEnter = useCallback(() => {
    void window.islandBridge?.setIgnoreMouse(false);
    if (hoverExitTimerRef.current) {
      clearTimeout(hoverExitTimerRef.current);
      hoverExitTimerRef.current = null;
    }
    if (uiState === "expanded") {
      armIdleTimer();
      return;
    }
    if (uiState === "hover" || hoverOpenTimerRef.current) return;
    hoverOpenTimerRef.current = setTimeout(() => {
      hoverOpenTimerRef.current = null;
      setUiState((current) => (current === "collapsed" ? "hover" : current));
    }, HOVER_OPEN_DELAY_MS);
  }, [uiState, armIdleTimer]);

  // Pointer leave collapses the hover preview only (after the exit grace);
  // the expanded panel closes exclusively via close button, shortcut, row
  // activation, or the inactivity timeout.
  const onPointerLeave = useCallback(() => {
    void window.islandBridge?.setIgnoreMouse(true);
    if (hoverOpenTimerRef.current) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (uiState !== "hover" && !popped) return;
    if (hoverExitTimerRef.current) clearTimeout(hoverExitTimerRef.current);
    hoverExitTimerRef.current = setTimeout(() => {
      hoverExitTimerRef.current = null;
      setPopped(false);
      setUiState((current) => (current === "hover" ? "collapsed" : current));
    }, HOVER_EXIT_GRACE_MS);
  }, [uiState, popped]);

  const focusThread = useCallback(
    (threadId: string) => {
      void window.islandBridge?.focusThread(threadId);
      applyState("collapsed");
    },
    [applyState],
  );

  const effectiveState: IslandWindowState = uiState === "collapsed" && popped ? "hover" : uiState;

  // Cross-fade content swap: both layers stay mounted during the morph. The
  // incoming content renders immediately (with its delayed enter keyframes)
  // while the outgoing content lingers as a fading overlay.
  const [renderedState, setRenderedState] = useState<IslandWindowState>(effectiveState);
  const [leavingState, setLeavingState] = useState<IslandWindowState | null>(null);
  // Ref-held timer: setRenderedState re-runs this effect immediately, and an
  // effect-scoped cleanup would cancel the unmount of the leaving layer.
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (effectiveState === renderedState) return;
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    if (prefersReducedMotion()) {
      setRenderedState(effectiveState);
      setLeavingState(null);
      return;
    }
    setLeavingState(renderedState);
    setRenderedState(effectiveState);
    leaveTimerRef.current = setTimeout(() => setLeavingState(null), CONTENT_LEAVE_FALLBACK_MS);
  }, [effectiveState, renderedState]);

  // Unmount the leaving layer the moment its fade finishes.
  const onLeaveAnimationEnd = useCallback((event: ReactAnimationEvent) => {
    if (event.animationName !== "island-leave") return;
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    setLeavingState(null);
  }, []);
  useEffect(() => {
    return () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
  }, []);

  // Every displayed state change (click, shortcut, idle collapse, auto-pop) is
  // mirrored to the main process: on Linux there is no click-through
  // forwarding, so the window itself must resize to the displayed state.
  const sessionCount = sessions.length;
  useEffect(() => {
    void window.islandBridge?.setState(effectiveState, { sessionCount });
  }, [effectiveState, sessionCount]);

  const size = innerSize(effectiveState, context, sessionCount);
  const shell = islandShellMode(context?.notch ?? null);
  const orbState = orbStateForStatus(sessions[0]?.status ?? aggregate);
  const headline = sessions[0] ?? null;

  return (
    <div className="pointer-events-none relative h-screen w-screen overflow-hidden bg-transparent">
      <div aria-live="polite" className="sr-only">
        {popped && headline ? `${headline.title}: ${STATUS_LABEL[headline.status]}` : ""}
      </div>
      <div
        data-island-shell={shell}
        data-island-platform={platformAttribute(context)}
        data-island-state={effectiveState}
        data-island-empty={sessionCount === 0}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        style={{ width: size.width, height: size.height }}
        className="island-surface pointer-events-auto flex flex-col overflow-hidden text-white"
      >
        {renderIslandContent(renderedState, false)}
        {leavingState !== null && leavingState !== renderedState ? (
          <div
            className="pointer-events-none absolute inset-0 flex flex-col overflow-hidden"
            onAnimationEnd={onLeaveAnimationEnd}
          >
            {renderIslandContent(leavingState, true)}
          </div>
        ) : null}
      </div>
    </div>
  );

  function renderIslandContent(state: IslandWindowState, leaving: boolean) {
    if (state === "collapsed") {
      // Anchored to the pill's final top-center coordinates at its final size,
      // so during a close morph the incoming collapsed content sits where the
      // pill will land instead of floating mid-capsule.
      const collapsedSize = innerSize("collapsed", context, sessionCount);
      return (
        <div
          key={leaving ? "collapsed-leave" : "collapsed"}
          className="absolute left-1/2 top-0 -translate-x-1/2"
          style={{ width: collapsedSize.width, height: collapsedSize.height }}
        >
          <button
            type="button"
            onClick={() => applyState("expanded")}
            className={cn(
              // Enter keyframes only on the incoming copy: replaying them on the
              // remounted leaving copy would hide it (delayed `both` fill) and
              // leave the capsule blank mid-morph.
              leaving ? "island-leave" : "island-enter-body",
              "island-pill flex h-full w-full items-center justify-center gap-2 px-3",
            )}
            aria-label={
              sessionCount > 0
                ? `${sessionCount} agent ${sessionCount === 1 ? "session" : "sessions"}, ${STATUS_LABEL[orbState as IslandSessionStatus] ?? "idle"}`
                : "No agent sessions"
            }
          >
            <IslandOrb state={orbState} />
            {sessionCount > 0 ? (
              <span className="text-[13px] font-medium tabular-nums text-white/[0.92]">
                {sessionCount}
              </span>
            ) : null}
          </button>
        </div>
      );
    }
    return state === "hover" ? (
      <button
        key={leaving ? "hover-leave" : "hover"}
        type="button"
        onClick={() => applyState("expanded")}
        className={cn(
          leaving ? "island-leave" : "island-enter-body",
          "island-pill flex h-full w-full flex-col items-stretch justify-center gap-1 px-5 text-left",
        )}
        aria-label="Expand agent sessions island"
      >
        {headline ? (
          <>
            <div className="flex items-center gap-2.5">
              <IslandOrb state={headline.status} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/[0.92]">
                {headline.title}
              </span>
              <span className="shrink-0 text-[11px] text-white/60">
                {STATUS_LABEL[headline.status]}
              </span>
            </div>
            <div className="pl-[19px] text-[11px] tabular-nums text-white/40">
              {providerLabel(headline.provider)} ·{" "}
              {islandRelativeTime(headline.lastActivityAt, nowMs)}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2.5">
            <IslandOrb state="idle" />
            <span className="text-[11px] text-white/60">No active sessions</span>
          </div>
        )}
      </button>
    ) : (
      <div
        key={leaving ? "expanded-leave" : "expanded"}
        className={cn("relative flex h-full flex-col", leaving && "island-leave")}
        onPointerMove={armIdleTimer}
      >
        <div
          className={cn(
            !leaving && "island-enter-header",
            "flex items-center justify-between border-b border-white/6 px-4 py-2.5",
          )}
        >
          <span className="text-[13px] font-medium text-white/[0.92]">Sessions</span>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-white/25">{shortcutHint(context)}</span>
            <button
              type="button"
              onClick={() => applyState("collapsed")}
              className="island-close rounded p-1.5 text-white/40"
              aria-label="Close"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        </div>
        <div
          className={cn(
            !leaving && "island-enter-body",
            "island-list flex-1 overflow-y-auto px-2 pb-2",
          )}
        >
          {sessions.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-[11px] text-white/60">No active sessions</span>
            </div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.threadId}
                type="button"
                onClick={() => focusThread(session.threadId)}
                className={cn(
                  !leaving && "island-enter-row",
                  "island-row flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left",
                )}
              >
                <IslandOrb state={session.status} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/[0.92]">
                      {session.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-white/60">
                      {STATUS_LABEL[session.status]}
                    </span>
                  </span>
                  <span className="text-[11px] tabular-nums text-white/40">
                    {providerLabel(session.provider)} ·{" "}
                    {islandRelativeTime(session.lastActivityAt, nowMs)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }
}
