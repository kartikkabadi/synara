// FILE: IslandOrb.tsx
// Purpose: CSS-built "liquid glass" orb lamp whose hue and motion encode agent state.
// Layer: Web island UI
// Why: The orb is the island's only living element ("ember glass"); pure CSS,
//      no canvas/WebGL, only transform/opacity/filter animate.

import type { CSSProperties } from "react";

import type { IslandSessionStatus } from "~/lib/islandSessionTracker";

export type IslandOrbState = IslandSessionStatus | "looping" | "idle" | "error";

// One dominant hue at a time, from Synara's own state palette. The same hue
// number drives the surface glow / interior wash via --island-hue.
const ORB_HUE: Record<IslandOrbState, number> = {
  idle: 225,
  working: 195,
  looping: 265,
  "needs-approval": 38,
  done: 150,
  error: 3,
};

export function orbStateForStatus(status: IslandSessionStatus | null): IslandOrbState {
  return status ?? "idle";
}

export function orbHue(state: IslandOrbState): number {
  return ORB_HUE[state];
}

export interface IslandOrbProps {
  state: IslandOrbState;
  /** Diameter in px: 16 in the collapsed pill, 20 in rows, 32 as the empty-state hero. */
  size?: number;
}

// Three stacked layers: bloom (::before, blurred halo breathing behind), core
// (child, hot-white center over the state hue), rim (::after, a 1.5px conic
// sweep ring). See island.css "Orb lamp".
export function IslandOrb({ state, size = 16 }: IslandOrbProps) {
  const style = {
    width: size,
    height: size,
    "--island-hue": ORB_HUE[state],
  } as CSSProperties;
  return (
    <span aria-hidden className="island-orb" data-orb-state={state} style={style}>
      <span className="island-orb-core" />
    </span>
  );
}
