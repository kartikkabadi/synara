// FILE: IslandOrb.tsx
// Purpose: Status light for the island: a 9px state-colored dot with a small static halo.
// Layer: Web island UI

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { IslandSessionStatus } from "~/lib/islandSessionTracker";
import { cn } from "~/lib/utils";

export type IslandOrbState = IslandSessionStatus | "looping" | "idle" | "error";

// One flat state color at a time, from Synara's own state palette.
const LIGHT_COLOR: Record<IslandOrbState, string> = {
  idle: "hsl(225 25% 55%)",
  working: "hsl(195 85% 60%)",
  looping: "hsl(265 80% 65%)",
  "needs-approval": "hsl(38 95% 60%)",
  done: "hsl(150 70% 50%)",
  error: "hsl(3 80% 58%)",
};

const LIGHT_HALO: Record<IslandOrbState, string> = {
  idle: "hsl(225 25% 55% / 0.35)",
  working: "hsl(195 85% 60% / 0.35)",
  looping: "hsl(265 80% 65% / 0.35)",
  "needs-approval": "hsl(38 95% 60% / 0.35)",
  done: "hsl(150 70% 50% / 0.35)",
  error: "hsl(3 80% 58% / 0.35)",
};

export function orbStateForStatus(status: IslandSessionStatus | null): IslandOrbState {
  return status ?? "idle";
}

export interface IslandOrbProps {
  state: IslandOrbState;
}

export function IslandOrb({ state }: IslandOrbProps) {
  // Pulse only on an observed transition into needs-approval, never on mount:
  // content layers remount on every collapsed/hover/expanded swap, and the
  // light must not replay the pulse each time.
  const previousStateRef = useRef(state);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (state === "needs-approval" && previousStateRef.current !== "needs-approval") {
      setPulse(true);
    } else if (state !== "needs-approval") {
      setPulse(false);
    }
    previousStateRef.current = state;
  }, [state]);

  const style = {
    "--island-light-color": LIGHT_COLOR[state],
    "--island-light-halo": LIGHT_HALO[state],
  } as CSSProperties;
  return (
    <span
      aria-hidden
      className={cn("island-light", pulse && "island-light-pulse")}
      data-light-state={state}
      style={style}
    />
  );
}
