// FILE: Island.tsx
// Purpose: Renderer for the always-on-top island overlay window: pill, hover preview, expanded rows.
// Layer: Web island UI
// Why: Runs in its own transparent BrowserWindow (see apps/desktop/src/island/), so it keeps its
//      own WebSocket shell subscription instead of relying on the main app shell.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  type IslandSession,
  type IslandSessionStatus,
} from "~/lib/islandSessionTracker";
import { XIcon } from "~/lib/icons";
import { cn, isMacPlatform } from "~/lib/utils";

import { IslandOrb, orbHue, orbStateForStatus } from "./IslandOrb";
import "./island.css";

const AUTO_POP_MS = 4_000;
const EXPANDED_IDLE_COLLAPSE_MS = 8_000;
// Outgoing content fades over the first ~35% of the 260ms surface morph, then
// the incoming content mounts and enters on its own 65ms-delayed keyframes.
const CONTENT_LEAVE_MS = 90;
// Drives done-session pruning and relative timestamps between shell events.
const CLOCK_TICK_MS = 30_000;

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

const STATUS_TEXT_CLASS: Record<IslandSessionStatus, string> = {
  working: "text-cyan-300",
  "needs-approval": "text-amber-300",
  done: "text-emerald-300",
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
  return isMac ? "\u2318\u21e7I" : "Ctrl\u21e7I";
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
  const sessionsRef = useRef<IslandSession[]>([]);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const sessions = useMemo(() => deriveIslandSessions(threads, nowMs), [threads, nowMs]);
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

  // Global shortcut toggles arrive from the main process.
  useEffect(() => {
    return window.islandBridge?.onStateChanged((state) => {
      setUiState(state);
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

  // Two-phase content swap: the surface morph starts immediately while the
  // outgoing content fades for CONTENT_LEAVE_MS, then the incoming content
  // mounts and runs its delayed enter keyframes.
  const [renderedState, setRenderedState] = useState<IslandWindowState>(effectiveState);
  const [contentLeaving, setContentLeaving] = useState(false);
  useEffect(() => {
    if (effectiveState === renderedState) return;
    if (prefersReducedMotion()) {
      setRenderedState(effectiveState);
      return;
    }
    setContentLeaving(true);
    const timer = setTimeout(() => {
      setRenderedState(effectiveState);
      setContentLeaving(false);
    }, CONTENT_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [effectiveState, renderedState]);

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
      { duration: 260, easing: "cubic-bezier(0.34,1.56,0.64,1)" },
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
  const orbState = orbStateForStatus(aggregate);
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
        {renderedState === "collapsed" ? (
          <button
            key="collapsed"
            type="button"
            onClick={() => applyState("expanded")}
            className={cn(
              "island-enter-body flex h-full w-full items-center text-xs font-medium tracking-wide text-white/80",
              sessions.length > 0 ? "gap-2 pl-2.5 pr-3" : "justify-center px-3",
              contentLeaving && "island-leave",
            )}
            aria-label="Expand agent sessions island"
          >
            <span className="island-orb-seat">
              <IslandOrb state={orbState} />
            </span>
            {sessions.length > 0 ? (
              <>
                <span className="text-[13px] font-semibold tabular-nums text-white/90">
                  {sessions.length}
                </span>
                <span className="flex-1" />
                <span className="h-1 w-1 rounded-full bg-[hsl(var(--island-hue)_85%_65%)]" />
              </>
            ) : null}
          </button>
        ) : renderedState === "hover" ? (
          <button
            key="hover"
            type="button"
            onClick={() => applyState("expanded")}
            className={cn(
              "island-enter-body flex h-full w-full flex-col items-stretch justify-center gap-1.5 px-4 py-3 text-left",
              contentLeaving && "island-leave",
            )}
            aria-label="Expand agent sessions island"
          >
            {headline ? (
              <>
                <div className="flex items-center gap-2.5">
                  <IslandOrb state={headline.status} size={15} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/90">
                    {headline.title}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs font-medium",
                      STATUS_TEXT_CLASS[headline.status],
                    )}
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
                <IslandOrb state="idle" size={15} />
                <span className="text-xs text-white/50">No active sessions</span>
              </div>
            )}
          </button>
        ) : (
          <div
            key="expanded"
            className={cn("relative flex h-full flex-col", contentLeaving && "island-leave")}
            onPointerMove={armIdleTimer}
          >
            <div className="island-panel-vignette pointer-events-none absolute inset-0" />
            <div className="island-enter-header flex items-center justify-between border-b border-white/6 px-4 py-2.5">
              <span className="text-xs font-medium text-white/60">Sessions</span>
              <div className="flex items-center gap-2">
                <span className="rounded border border-white/10 bg-white/5 px-1 text-[10px] text-white/40">
                  {shortcutHint(context)}
                </span>
                <button
                  type="button"
                  onClick={() => applyState("collapsed")}
                  className="rounded-md p-1 text-white/50 hover:bg-white/10 hover:text-white/80"
                  aria-label="Collapse island"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="island-enter-body flex-1 overflow-y-auto px-2 pb-2">
              {sessions.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-2">
                  <IslandOrb state="idle" size={28} />
                  <span className="text-sm text-white/60">No active sessions</span>
                  <span className="text-xs text-white/35">New agent turns will appear here</span>
                </div>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.threadId}
                    type="button"
                    onClick={() => focusThread(session.threadId)}
                    className="island-row group flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-white/6"
                  >
                    <IslandOrb state={session.status} size={15} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-white/90">
                      {session.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 group-hover:hidden">
                      <span className="rounded-md border border-white/10 bg-white/8 px-1.5 py-0.5 text-[10px] text-white/60">
                        {providerLabel(session.provider)}
                      </span>
                      <span className="text-[10px] text-white/40">
                        {islandRelativeTime(session.lastActivityAt, nowMs)}
                      </span>
                      <span
                        className={cn("text-[10px] font-medium", STATUS_TEXT_CLASS[session.status])}
                      >
                        {STATUS_LABEL[session.status]}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-[10px] font-medium text-white/70 group-hover:inline">
                      Open
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
