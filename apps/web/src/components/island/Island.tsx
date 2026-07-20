// FILE: Island.tsx
// Purpose: Renderer for the always-on-top island overlay window: pill, hover preview, expanded rows.
// Layer: Web island UI
// Why: Runs in its own transparent BrowserWindow (see apps/desktop/src/island/), so it keeps its
//      own WebSocket shell subscription instead of relying on the main app shell.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type IslandDisplayContext,
  type IslandWindowState,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
  type ProviderKind,
} from "@synara/contracts";

import { ensureNativeApi } from "~/nativeApi";
import {
  aggregateIslandStatus,
  deriveIslandSessions,
  findPopTransition,
  type IslandSession,
  type IslandSessionStatus,
} from "~/lib/islandSessionTracker";
import { cn } from "~/lib/utils";

const AUTO_POP_MS = 4_000;
const EXPANDED_IDLE_COLLAPSE_MS = 8_000;

// Mirrors apps/desktop/src/island/islandGeometry.ts: the window is pre-sized to
// the expanded bounds and only this inner container animates.
const EXPANDED_SIZE = { width: 560, height: 320 };
const HOVER_HEIGHT = 104;
const FLOATING_COLLAPSED_SIZE = { width: 180, height: 32 };

function innerSize(state: IslandWindowState, context: IslandDisplayContext | null) {
  const notch = context?.notch ?? null;
  if (state === "expanded") return EXPANDED_SIZE;
  if (state === "hover") {
    return { width: Math.max((notch?.width ?? 180) + 200, 420), height: HOVER_HEIGHT };
  }
  if (notch) return { width: notch.width + 60, height: notch.height };
  return FLOATING_COLLAPSED_SIZE;
}

const STATUS_DOT_CLASS: Record<IslandSessionStatus, string> = {
  working: "bg-blue-400 animate-pulse",
  "needs-approval": "bg-amber-400",
  done: "bg-emerald-400",
};

const STATUS_LABEL: Record<IslandSessionStatus, string> = {
  working: "Working",
  "needs-approval": "Needs approval",
  done: "Done",
};

function providerLabel(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider as ProviderKind] ?? provider;
}

export function Island() {
  const [context, setContext] = useState<IslandDisplayContext | null>(null);
  const [threads, setThreads] = useState<readonly OrchestrationThreadShell[]>([]);
  const [uiState, setUiState] = useState<IslandWindowState>("collapsed");
  const [popped, setPopped] = useState(false);
  const sessionsRef = useRef<IslandSession[]>([]);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessions = useMemo(() => deriveIslandSessions(threads, Date.now()), [threads]);
  const aggregate = aggregateIslandStatus(sessions);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    void window.islandBridge?.getContext().then(setContext);
  }, []);

  useEffect(() => {
    const api = ensureNativeApi();
    const threadsById = new Map<string, OrchestrationThreadShell>();
    const applyThreads = () => setThreads([...threadsById.values()]);
    const disposeShellEvents = api.orchestration.onShellEvent(
      (item: OrchestrationShellStreamItem) => {
        if (item.kind === "snapshot") {
          threadsById.clear();
          for (const thread of item.snapshot.threads) threadsById.set(thread.id, thread);
        } else if (item.kind === "thread-upserted") {
          threadsById.set(item.thread.id, item.thread);
        } else if (item.kind === "thread-removed") {
          threadsById.delete(item.threadId);
        } else {
          return;
        }
        applyThreads();
      },
    );
    void api.orchestration.subscribeShell();
    void api.orchestration.getShellSnapshot().then((snapshot) => {
      threadsById.clear();
      for (const thread of snapshot.threads) threadsById.set(thread.id, thread);
      applyThreads();
    });
    return () => {
      disposeShellEvents();
      void api.orchestration.unsubscribeShell();
    };
  }, []);

  // Auto-pop on needs-approval / turn-completed transitions.
  useEffect(() => {
    const transition = findPopTransition(sessionsRef.current, sessions);
    sessionsRef.current = sessions;
    if (!transition) return;
    setPopped(true);
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
    popTimerRef.current = setTimeout(() => setPopped(false), AUTO_POP_MS);
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
    // Linux has no click-through forwarding, so the window itself resizes.
    void window.islandBridge?.setState(state);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") applyState("collapsed");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyState]);

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
  const size = innerSize(effectiveState, context);
  const isNotch = context?.notch != null;

  return (
    <div className="flex h-screen w-screen items-start justify-center overflow-hidden bg-transparent">
      <div
        data-island-state={effectiveState}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        style={{ width: size.width, height: size.height }}
        className={cn(
          "pointer-events-auto flex flex-col overflow-hidden bg-black/90 text-white shadow-lg backdrop-blur",
          "transition-[width,height,border-radius] duration-220 ease-out motion-reduce:transition-none",
          isNotch && effectiveState === "collapsed" ? "rounded-b-2xl" : "rounded-2xl",
        )}
      >
        {effectiveState === "collapsed" ? (
          <button
            type="button"
            onClick={() => applyState("expanded")}
            className="flex h-full w-full items-center justify-center gap-2 px-3 text-xs font-medium"
            aria-label="Expand agent sessions island"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                aggregate ? STATUS_DOT_CLASS[aggregate] : "bg-white/30",
              )}
            />
            <span className="tabular-nums">{sessions.length}</span>
          </button>
        ) : effectiveState === "hover" ? (
          <button
            type="button"
            onClick={() => applyState("expanded")}
            className="flex h-full w-full flex-col items-stretch gap-1 px-4 py-3 text-left"
            aria-label="Expand agent sessions island"
          >
            <div className="flex items-center gap-2 text-xs text-white/70">
              <span
                className={cn(
                  "size-2 rounded-full",
                  aggregate ? STATUS_DOT_CLASS[aggregate] : "bg-white/30",
                )}
              />
              {sessions.length === 1 ? "1 session" : `${sessions.length} sessions`}
            </div>
            <div className="flex items-center gap-2 overflow-hidden">
              {sessions.slice(0, 8).map((session) => (
                <span
                  key={session.threadId}
                  title={session.title}
                  className={cn("size-2.5 shrink-0 rounded-full", STATUS_DOT_CLASS[session.status])}
                />
              ))}
              {sessions.length === 0 ? (
                <span className="text-xs text-white/50">No active sessions</span>
              ) : null}
            </div>
          </button>
        ) : (
          <div className="flex h-full flex-col" onPointerMove={armIdleTimer}>
            <div className="flex items-center justify-between px-4 py-2 text-xs text-white/70">
              <span>Agent sessions</span>
              <button
                type="button"
                onClick={() => applyState("collapsed")}
                className="rounded px-1.5 py-0.5 hover:bg-white/10"
                aria-label="Collapse island"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {sessions.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-white/50">
                  No active sessions
                </div>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.threadId}
                    type="button"
                    onClick={() => focusThread(session.threadId)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/10"
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        STATUS_DOT_CLASS[session.status],
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
                    <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">
                      {providerLabel(session.provider)}
                    </span>
                    <span className="shrink-0 text-[10px] text-white/50">
                      {STATUS_LABEL[session.status]}
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
