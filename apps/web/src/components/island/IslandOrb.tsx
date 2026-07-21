// FILE: IslandOrb.tsx
// Purpose: CSS-built "liquid glass" orb lamp whose hue and motion encode agent state.
// Layer: Web island UI
// Why: The orb is the island's only living element ("ember glass"); pure CSS,
//      no canvas/WebGL, only transform/opacity animate.

import type { CSSProperties } from "react";

import type { IslandSessionStatus } from "~/lib/islandSessionTracker";

export type IslandOrbState = IslandSessionStatus | "looping" | "idle" | "error";

// One dominant hue at a time, from Synara's own state palette.
const ORB_HUE: Record<IslandOrbState, number> = {
  idle: 224,
  working: 205,
  looping: 265,
  "needs-approval": 36,
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
  /** Diameter in px: 18 in the collapsed pill, 15 in rows, 28 as the empty-state hero. */
  size?: number;
}

export function IslandOrb({ state, size = 18 }: IslandOrbProps) {
  const style = {
    width: size,
    height: size,
    "--island-hue": ORB_HUE[state],
  } as CSSProperties;
  return (
    <span aria-hidden className="island-orb" data-orb-state={state} style={style}>
      {/* 2× canvas scaled down: gradients rasterize at double resolution. */}
      <span className="island-orb-canvas">
        <span className="island-orb-bloom" />
        <span className="island-orb-core" />
        <span className="island-orb-spec" />
        <span className="island-orb-sheen" />
      </span>
    </span>
  );
}
