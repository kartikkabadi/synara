// FILE: DynamicIsland.tsx
// Purpose: Compact pill below the top bar showing active thread status.
// Layer: Web UI overlay (position: fixed, z-50)
// Why: Gives the user at-a-glance awareness of what the agent is doing without
//      switching to the thread's tab. Auto-expands on approvals/user-input/plans.

import { useEffect, useMemo, useRef, useState } from "react";

import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@t3tools/shared/desktopChrome";
import { useAppSettings } from "~/appSettings";
import { mapWorkLogToActionState, type ActionState } from "~/lib/actionStates";
import {
  selectActiveIslandThread,
  selectIdleIslandThread,
  selectRecentIslandThreads,
} from "~/lib/islandThreadTracker";
import { deriveWorkLogEntries } from "~/session-logic";
import { useStore } from "~/store";
import type { Thread } from "~/types";
import { cn } from "~/lib/utils";

const ISLAND_TOP_PX = CHAT_SURFACE_HEADER_HEIGHT_PX + 4;
const ISLAND_MAX_WIDTH = "min(420px, calc(100vw - 200px))";
const HYSTERESIS_MS = 150;

// Hook: tracks the active island thread with hysteresis to prevent flicker.
function useIslandThreadTracker(): {
  activeThread: Thread | null;
  idleThread: Thread | null;
  recentThreads: Thread[];
} {
  const threads = useStore((s) => s.threads);
  const [hysteresisId, setHysteresisId] = useState<string | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeSelected = useMemo(() => selectActiveIslandThread(threads), [threads]);
  const idleSelected = useMemo(() => selectIdleIslandThread(threads), [threads]);
  const recentSelected = useMemo(() => selectRecentIslandThreads(threads), [threads]);

  // Hysteresis: when the active thread changes, wait HYSTERESIS_MS before
  // switching. This prevents flicker when threads briefly lose "active" state
  // between turns. If a new active thread appears within the hysteresis window,
  // we switch immediately (the user needs to see pending approvals etc).
  useEffect(() => {
    const newId = activeSelected?.id ?? null;
    if (newId === hysteresisId) {
      pendingIdRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // If there's no active thread, hide immediately (don't keep showing stale state).
    if (newId === null) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingIdRef.current = null;
      setHysteresisId(null);
      return;
    }

    // New active thread: if we have a pending state (approvals/user-input/plan),
    // switch immediately. Otherwise apply hysteresis.
    const hasPendingState =
      activeSelected?.hasPendingApprovals === true ||
      activeSelected?.hasPendingUserInput === true ||
      activeSelected?.hasActionableProposedPlan === true;

    if (hasPendingState || hysteresisId === null) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingIdRef.current = null;
      setHysteresisId(newId);
      return;
    }

    // Apply hysteresis for non-pending thread switches.
    if (pendingIdRef.current !== newId) {
      pendingIdRef.current = newId;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingIdRef.current;
        pendingIdRef.current = null;
        if (pending) setHysteresisId(pending);
      }, HYSTERESIS_MS);
    }
  }, [activeSelected, hysteresisId]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const activeThread = useMemo(
    () => activeSelected?.id === hysteresisId ? activeSelected : (hysteresisId ? threads.find((t) => t.id === hysteresisId) ?? null : null),
    [activeSelected, hysteresisId, threads],
  );

  return { activeThread, idleThread: idleSelected, recentThreads: recentSelected };
}

// Derive the current action state from the tracked thread's last work entry.
function useTrackedThreadActionState(
  thread: Thread | null,
  preset: ReturnType<typeof useAppSettings>["settings"]["loaderColorPreset"],
): ActionState | null {
  return useMemo(() => {
    if (!thread) return null;
    const entries = deriveWorkLogEntries(
      thread.activities,
      thread.latestTurn?.turnId ?? undefined,
    );
    const lastEntry = entries.at(-1);
    if (!lastEntry) {
      // Turn just started, no activities yet — show "Thinking..."
      return mapWorkLogToActionState(
        {
          id: "island-pending",
          createdAt: new Date().toISOString(),
          label: "Thinking...",
          tone: "thinking",
        },
        preset,
      );
    }
    return mapWorkLogToActionState(lastEntry, preset);
  }, [thread, preset]);
}

export function DynamicIsland() {
  const { settings } = useAppSettings();
  const { activeThread } = useIslandThreadTracker();
  const actionState = useTrackedThreadActionState(activeThread, settings.loaderColorPreset);

  // Window focus gating: hide island when app is not focused.
  const [windowFocused, setWindowFocused] = useState(
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!settings.dynamicIslandEnabled) return null;
  if (!windowFocused) return null;
  if (!activeThread || !actionState) return null;

  const Loader = actionState.loader;

  return (
    <div
      className="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2"
      style={{ top: ISLAND_TOP_PX }}
    >
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 shadow-lg backdrop-blur-md",
          "max-w-[420px]",
        )}
        style={{ width: ISLAND_MAX_WIDTH }}
      >
        <Loader size={16} color={actionState.color} aria-hidden="true" />
        <span className="truncate text-xs font-medium text-foreground/90" title={activeThread.title}>
          {actionState.label}
        </span>
      </div>
    </div>
  );
}
