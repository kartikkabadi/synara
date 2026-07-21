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
  type CSSProperties,
} from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type IslandDisplayContext,
  type IslandWindowState,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
  type ProviderKind,
} from "@synara/contracts";
import { islandStateSize } from "@synara/shared/islandGeometry";

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

import { IslandOrb, orbHue, orbStateForStatus } from "./IslandOrb";
import "./island.css";

const AUTO_POP_MS = 4_000;
const EXPANDED_IDLE_COLLAPSE_MS = 8_000;
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

// The window is pre-sized to the expanded bounds (except Linux) and only this
// inner container animates, using the same sizing as the Electron window.
function innerSize(
  state: IslandWindowState,
  context: IslandDisplayContext | null,
  sessionCount: number,
) {
  return islandStateSize(state, context?.notch ?? null, sessionCount);
}

// Token-based status text colors so text matches the orb's state hues exactly
// (see island.css "Orb lamp" state hue tokens).
const STATUS_TEXT_CLASS: Record<IslandSessionStatus, string> = {
  working: "island-status-text-working",
  "needs-approval": "island-status-text-needs-approval",
  done: "island-status-text-done",
};

const STATUS_LABEL: Record<IslandSessionStatus, string> = {
  working: "Working",
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

// e.g. "+2 more working · 1 done" under the hover headline row.
function summarizeRest(rest: readonly IslandSession[]): string | null {
  if (rest.length === 0) return null;
  const counts = new Map<IslandSessionStatus, number>();
  for (const session of rest) counts.set(session.status, (counts.get(session.status) ?? 0) + 1);
  const parts: string[] = [];
  for (const status of ["needs-approval", "working", "done"] as const) {
    const count = counts.get(status);
    if (!count) continue;
    const label = STATUS_LABEL[status].toLowerCase();
    parts.push(parts.length === 0 ? `+${count} more ${label}` : `${count} ${label}`);
  }
  return parts.join(" · ");
}

export function Island() {
  const [context, setContext] = useState<IslandDisplayContext | null>(null);
  const [threads, setThreads] = useState<readonly OrchestrationThreadShell[]>([]);
  const [uiState, setUiState] = useState<IslandWindowState>("collapsed");
  const [popped, setPopped] = useState(false);
  const sessionsRef = useRef<readonly IslandSession[]>([]);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Mock rows go through the same priority sort as live sessions so the
  // headline, row order, and surface glow hue never disagree.
  const sessions = useMemo(
    () =>
      USE_MOCK_SESSIONS ? sortIslandSessions(MOCK_SESSIONS) : deriveIslandSessions(threads, nowMs),
    [threads, nowMs],
  );
  const aggregate = aggregateIslandStatus(sessions);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    void window.islandBridge?.getContext().then((value) => setContext(value ?? null));
  }, []);

  useEffect(() => {
    return () => {
      if (popTimerRef.current) clearTimeout(popTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
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

  // Auto-pop on needs-approval / turn-completed transitions, with a bigger
  // spring overshoot plus a one-shot brightness flash on the surface. The
  // resize itself keeps the 220ms ease-out transition — it is a status
  // animation, not a disclosure toggle, so disclosureMotion.ts does not apply
  // (see .plans/island-siri-orb-v2.md §2.4).
  useEffect(() => {
    const transition = findPopTransition(sessionsRef.current, sessions);
    sessionsRef.current = sessions;
    if (!transition) return;
    setPopped(true);
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
    popTimerRef.current = setTimeout(() => setPopped(false), AUTO_POP_MS);
    if (!prefersReducedMotion()) {
      surfaceRef.current?.animate(
        { transform: ["scale(1)", "scale(1.035)", "scale(1)"] },
        { duration: 280, easing: "cubic-bezier(0.34,1.56,0.64,1)" },
      );
      surfaceRef.current?.animate(
        { filter: ["brightness(1)", "brightness(1.25)", "brightness(1)"] },
        { duration: 500, easing: "ease-out" },
      );
    }
  }, [sessions]);

  // Expanded panel collapses after a period without pointer activity.
  const armIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setUiState("collapsed"), EXPANDED_IDLE_COLLAPSE_MS);
  }, []);

  useEffect(() => {
    if (uiState === "expanded") armIdleTimer();
    else if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
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

  const applyState = useCallback((state: IslandWindowState) => {
    setUiState(state);
  }, []);

  const onPointerEnter = useCallback(() => {
    void window.islandBridge?.setIgnoreMouse(false);
    setUiState((current) => (current === "expanded" ? current : "hover"));
    if (uiState === "expanded") armIdleTimer();
  }, [uiState, armIdleTimer]);

  const onPointerLeave = useCallback(() => {
    void window.islandBridge?.setIgnoreMouse(true);
    applyState("collapsed");
  }, [applyState]);

  const focusThread = useCallback((threadId: string) => {
    void window.islandBridge?.focusThread(threadId);
  }, []);

  const effectiveState: IslandWindowState = uiState === "collapsed" && popped ? "hover" : uiState;

  // Cross-fade content swap: both layers stay mounted during the morph. The
  // incoming content renders immediately (with its delayed enter keyframes)
  // while the outgoing content lingers as a fading overlay for CONTENT_LEAVE_MS.
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

  // Unmount the leaving layer the moment its fade finishes — a lingering
  // opacity-0 layer with blurred orb blooms leaves ghost smears otherwise.
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

  // Every displayed state change gets the spring overshoot alongside the
  // surface morph, so the island always feels alive, not just on pops.
  const previousStateRef = useRef<IslandWindowState | null>(null);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = effectiveState;
    if (previous === null || previous === effectiveState) return;
    if (prefersReducedMotion()) return;
    surfaceRef.current?.animate(
      { transform: ["scale(1)", "scale(1.02)", "scale(1)"] },
      { duration: 340, easing: "cubic-bezier(0.34,1.56,0.64,1)" },
    );
  }, [effectiveState]);

  // Every displayed state change (click, shortcut, idle collapse, auto-pop) is
  // mirrored to the main process: on Linux there is no click-through
  // forwarding, so the window itself must resize to the displayed state.
  const sessionCount = sessions.length;
  useEffect(() => {
    void window.islandBridge?.setState(effectiveState, { sessionCount });
  }, [effectiveState, sessionCount]);

  const size = innerSize(effectiveState, context, sessionCount);
  const isNotch = context?.notch != null;
  // Surface glow/wash hue follows what the surface is actually showing: the
  // hover headline / top expanded row, falling back to the aggregate.
  const orbState = orbStateForStatus(sessions[0]?.status ?? aggregate);
  const glowing = aggregate === "working" || aggregate === "needs-approval";
  const headline = sessions[0] ?? null;
  const restSummary = summarizeRest(sessions.slice(1));

  return (
    <div className="pointer-events-none relative h-screen w-screen overflow-hidden bg-transparent">
      <div
        ref={surfaceRef}
        data-island-state={effectiveState}
        data-island-status={orbState}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        style={
          {
            width: size.width,
            height: size.height,
            "--island-hue": orbHue(orbState),
          } as CSSProperties
        }
        className={cn(
          "island-surface pointer-events-auto flex flex-col overflow-hidden text-white",
          isNotch && "island-surface-notch",
          glowing && (isNotch ? "island-surface-glow-notch" : "island-surface-glow"),
          aggregate === "done" && !isNotch && "island-surface-glow-done",
        )}
      >
        <div className="island-state-wash pointer-events-none absolute inset-0" />
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
              "flex h-full w-full items-center justify-center text-xs font-medium tracking-wide text-white/80",
              sessions.length > 0 ? "gap-2 pl-2.5 pr-3" : "px-3",
            )}
            aria-label="Expand agent sessions island"
          >
            <span className="island-orb-seat">
              <IslandOrb state={orbState} size={16} />
            </span>
            {sessions.length > 0 ? (
              <span className="text-[13px] font-semibold tabular-nums text-white/90">
                {sessions.length}
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
          "flex h-full w-full flex-col items-stretch justify-center gap-1.5 px-5 py-3 text-left",
        )}
        aria-label="Expand agent sessions island"
      >
        {headline ? (
          <>
            <div className="flex items-center gap-2.5">
              <IslandOrb state={headline.status} size={16} />
              <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-white/90">
                {headline.title}
              </span>
              <span
                className={cn("shrink-0 text-xs font-medium", STATUS_TEXT_CLASS[headline.status])}
              >
                {STATUS_LABEL[headline.status]}
              </span>
            </div>
            {restSummary ? (
              <div className="pl-[26px] text-xs text-white/50">{restSummary}</div>
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-2.5">
            <IslandOrb state="idle" size={16} />
            <span className="text-xs text-white/50">No active sessions</span>
          </div>
        )}
      </button>
    ) : (
      <div
        key={leaving ? "expanded-leave" : "expanded"}
        className={cn("relative flex h-full flex-col", leaving && "island-leave")}
        onPointerMove={armIdleTimer}
      >
        <div className="island-panel-vignette pointer-events-none absolute inset-0" />
        <div
          className={cn(
            !leaving && "island-enter-header",
            "flex items-center justify-between border-b border-white/6 px-4 py-2.5",
          )}
        >
          <span className="text-xs font-medium text-white/60">Sessions</span>
          <div className="flex items-center gap-2">
            <span className="island-chip px-1.5 py-0.5 text-[10px] text-white/50">
              {shortcutHint(context)}
            </span>
            <button
              type="button"
              onClick={() => applyState("collapsed")}
              className="island-chip p-1 text-white/50 hover:bg-white/10 hover:text-white/80"
              aria-label="Collapse island"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        </div>
        <div className={cn(!leaving && "island-enter-body", "flex-1 overflow-y-auto px-2 pb-2")}>
          {sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5 px-2">
              <IslandOrb state="idle" size={32} />
              <span className="text-sm font-medium text-white/70">No active sessions</span>
              <span className="text-xs text-white/35">Agent sessions will appear here</span>
            </div>
          ) : (
            sessions.map((session, index) => (
              <button
                key={session.threadId}
                type="button"
                onClick={() => focusThread(session.threadId)}
                style={
                  {
                    ...(leaving ? {} : { animationDelay: `${150 + index * 30}ms` }),
                    // Hover edge uses the row's own state hue, not the surface's.
                    "--island-hue": orbHue(orbStateForStatus(session.status)),
                  } as CSSProperties
                }
                className={cn(
                  !leaving && "island-enter-row",
                  "island-row group flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-white/6",
                )}
              >
                <IslandOrb state={session.status} size={20} />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-bold text-white/90">
                  {session.title}
                </span>
                <span
                  className={cn(
                    "island-chip shrink-0 px-1.5 py-0.5 text-[10px]",
                    STATUS_TEXT_CLASS[session.status],
                  )}
                >
                  {providerLabel(session.provider)} ·{" "}
                  {islandRelativeTime(session.lastActivityAt, nowMs)}
                </span>
                <span
                  className={cn(
                    "w-20 shrink-0 text-right text-[10px] font-medium group-hover:hidden",
                    STATUS_TEXT_CLASS[session.status],
                  )}
                >
                  {STATUS_LABEL[session.status]}
                </span>
                <span className="hidden w-20 shrink-0 text-right text-[10px] font-medium text-white/70 group-hover:inline">
                  Open
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }
}
