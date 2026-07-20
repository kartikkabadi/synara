# Island v2 — "Ember Glass" Orb-Lamp + /loop Integration

Status: design, ready for implementation.
Supersedes the *visual* sections of `.plans/notch-island.md` (§3 UI/UX); the
architecture, geometry, and window-management decisions there stand unchanged.

Bases:
- Island code: PR #54, branch `devin/1784570000-notch-island`.
- `/loop` code: branch `devin/loop-phase-1` (`ThreadLoop` on
  `OrchestrationThreadShell`, `LoopIndicator.tsx`, `packages/shared/src/loop.ts`).
- The loop-integration PR (PR 4 below) requires both branches merged into a
  common base; PRs 1–3 need only PR #54.

---

## 1. Design intent

Keyword: **ember glass**. A dark smoked-glass capsule whose only living element
is a small **orb lamp** — a CSS-built miniature "liquid glass" sphere in the
pill's left cap whose hue and motion encode aggregate agent state. Inspired by
the iOS 27 Siri direction (hardware-anchored pill, dark-only glass, transient
process shimmer, deference) but deliberately not a copy:

- One dominant hue at a time, from Synara's own state palette — never Apple's
  four-color rainbow.
- Shimmer/glow exists **only while work happens** and fades on completion
  (process indicator, never a badge).
- Content lives in quiet flat rows; the orb is the only glowing element.
  Never orb + rim shimmer + panel glow simultaneously.
- No binary rain, no light mode, no free-floating orb.

## 2. Visual specification

### 2.1 Surface (all states)

Replaces `bg-black/90 shadow-lg backdrop-blur`:

- Background: `linear-gradient(180deg, rgba(24,24,27,.92), rgba(9,9,11,.96))`
  + `backdrop-blur-xl backdrop-saturate-150`.
- Border: `border border-white/10` plus top inner highlight
  `shadow-[inset_0_1px_0_rgba(255,255,255,.08)]` (the "glass" cue).
- Outer shadow: `0 8px 32px rgba(0,0,0,.45)`. While any session is active,
  add a state-hued ambient glow `0 0 24px hsl(var(--island-hue) 80% 60% / .15)`.
  In notch mode keep the glow below the pill only (blur outward downward) so a
  mismatched `DEFAULT_NOTCH_WIDTH` doesn't halo the physical camera housing.
- Radius: `rounded-full` collapsed (floating), keep `rounded-b-2xl` notch
  special case, `rounded-[22px]` hover, `rounded-[26px]` expanded.

### 2.2 The orb lamp (replaces status dots)

16px in the collapsed pill, 14px in rows. Pure CSS, no canvas/WebGL:

- Core: `radial-gradient(circle at 35% 30%, hsl(H 90% 75%), hsl(H 85% 55%) 55%, hsl(H 80% 35%))`.
- Sheen: pseudo-element `conic-gradient` rotating (`island-orb-spin`),
  masked to the circle — the "liquid" drift.
- Bloom: blurred duplicate behind (`filter: blur(6px); opacity: .6`).
- Single CSS var `--island-hue` per state:

| state          | hue                    | motion                                   |
| -------------- | ---------------------- | ---------------------------------------- |
| idle (none)    | slate, 40% opacity     | sheen paused ("sleeping")                |
| working        | cyan ~205              | sheen 6s spin + breathe scale 1→1.06, 3s |
| looping        | violet ~265            | sheen 3s spin (loops feel "spun up")     |
| needs-approval | amber ~40              | no spin; soft double-pulse every 2.4s    |
| done           | emerald ~150           | static; fades to idle after retention    |

- `motion-reduce`: freeze spin/breathe/pulse — hue only.
- Only `transform`/`opacity` animate (composited layers; perf priority #1).

### 2.3 Collapsed pill

`[orb] 3 · ⟳1` — orb + session count + loop glyph with count of active loops
(only when ≥1 loop is active). `text-xs font-medium tabular-nums tracking-wide
text-white/80`. Idle: sleeping orb alone.

### 2.4 Pop moment (auto-pop)

On pop transitions, add a spring overshoot on the inner container via a single
WAAPI call: `scale 1 → 1.035 → 1`, 280ms, `cubic-bezier(0.34,1.56,0.64,1)`,
plus a one-shot hue glow flash. Guard with
`matchMedia("(prefers-reduced-motion: reduce)")`. Keep the existing 220ms
ease-out width/height/radius transition unchanged — the island's resize is a
status animation, not a disclosure toggle, so `disclosureMotion.ts` does not
apply (documented decision; do not migrate).

### 2.5 Hover state

Replace the anonymous dot strip with a **headline row** for the top-priority
session: mini orb + truncated title + hue-colored status word + loop chip
(`⟳ 4/20`) when looping. Second line: summary text, e.g.
`+2 more working · 1 done` or `Loop stopped · budget reached` right after a
loop-stop pop. Content crossfades (`opacity 0→1, translateY 4px→0`, 160ms,
60ms delay) so text never pops during the resize.

### 2.6 Expanded state

- Header: `Sessions` in `text-[11px] uppercase tracking-widest text-white/40`,
  `XIcon` from `~/lib/icons` (no raw `×`), subtle `⌘⇧I` hint.
- Rows:

```
[orb-mini]  Thread title………        [⟳ 4/20]  [Claude]  Working
```

  - Status word colored to the row's hue (e.g. `text-amber-300`), not gray.
  - Provider chip as glass chip: `bg-white/8 border border-white/10
    rounded-md text-[10px] text-white/60`.
  - Loop chip (violet tint): `⟳ 4/20` (count budget), `⟳ 12 · 3h left`
    (duration budget), `⟳ 7` (uncapped).
  - Row hover actions (right side, replacing chips): looping → Stop loop
    (`StopIcon`) + Open; needs-approval → Open (focus-to-approve — the user
    cannot see the diff from the island, so no one-click approve in v2);
    otherwise → Open.
- Empty state: centered sleeping orb + `No active sessions`.

## 3. /loop in the island

### 3.1 States

- **Collapsed**: loop glyph + count (§2.3); aggregate orb goes violet when the
  highest-priority state is `looping`.
- **Hover**: headline row shows the looping thread with its `⟳ n/cap` chip.
- **Expanded**: loop chip per row + Stop loop hover action.
- **Loop stopped**: pop (§3.3) with `Loop stopped · <reason>` in the hover
  summary line, violet→slate fade on the orb.
- Approval while looping: thread classifies as `needs-approval` (priority
  above `looping`), amber pulse, existing auto-pop — the island stays the
  fastest "loop needs you" surface. Re-arming/reconfiguring a loop stays in
  the composer (`/loop …`); the island only observes and stops.

### 3.2 Status derivation (pure, tested)

`islandSessionTracker.ts`:

```ts
export type IslandSessionStatus = "needs-approval" | "looping" | "working" | "done";

export interface IslandSession {
  // existing fields…
  loop: { iteration: number; maxIterations: number | null; endsAt: string | null } | null;
}
```

- `classifyIslandStatus`: after the needs-approval checks, if
  `thread.loop?.active === true` → `"looping"` (covers running loop-owned
  turns *and* armed-between-iterations); then the existing running/completed
  checks. Priority: `needs-approval (0) < looping (1) < working (2) < done (3)`.
- `loop` field populated from `thread.loop` whenever active.
- `findPopTransition` gains `"loop-stopped"`: previous session had
  `loop !== null` and next has `loop === null` with
  `thread.loop.lastStopReason != null`. (Pass shells or stop reason through —
  smallest option: keep `lastStopReason` on the session while draining.)

### 3.3 Shared loop formatting

Extract `formatRemainingTime` and `formatStopReason` from `LoopIndicator.tsx`
into `packages/shared/src/loop.ts` (runtime utility package; contracts stays
schema-only). Both `LoopIndicator` and the island consume them — no duplicate
logic (AGENTS.md maintainability rule).

### 3.4 Restyled LoopIndicator (same family)

Same visit: the composer banner gets the violet mini-orb, the `⟳ 4/20` chip,
and a thin progress hairline along the banner bottom
(`width = iteration/maxIterations`, 220ms ease-out) when a count budget is
set. Island and banner must visibly read as one system.

## 4. Architecture / file changes

Zero new server events, subscriptions, or native dependencies. `ThreadLoop`
already rides `OrchestrationThreadShell` into the island's existing shell
subscription.

| file | change |
| --- | --- |
| `apps/web/src/components/island/island.css` (new) | orb keyframes (`island-orb-spin`, `island-breathe`, `island-pulse`), ember-glass surface classes, crossfade classes, `motion-reduce` guards |
| `apps/web/src/components/island/IslandOrb.tsx` (new) | ~60-line orb component (core + sheen + bloom divs, `--island-hue` prop) |
| `apps/web/src/components/island/Island.tsx` | new surface classes, orb usage, hover headline, expanded header/rows, WAAPI pop spring, row hover actions |
| `apps/web/src/lib/islandSessionTracker.ts` | `looping` status, `loop` field, priority update, `loop-stopped` pop |
| `apps/web/src/lib/islandSessionTracker.test.ts` | cases: looping classification/priority, retention, loop-stopped pop |
| `packages/shared/src/loop.ts` | + `formatRemainingTime`, `formatStopReason` (moved from LoopIndicator) |
| `apps/web/src/components/chat/LoopIndicator.tsx` | consume shared helpers; restyle with mini-orb + chip + hairline |
| `packages/contracts/src/ipc.ts` | `IslandBridge` + `stopLoop(threadId: string): Promise<void>` |
| `apps/desktop/src/island/islandIpc.ts` | `stopLoop` handler → delegate (mirrors `focusThread`) |
| `apps/desktop/src/islandPreload.ts` | expose `stopLoop` |
| `apps/desktop/src/ipcChannels.ts` | `island.stopLoop` channel |

Notes:
- `stopLoop` routes main-process-side to the existing `thread.loop.toggle`
  dispatch path (same wiring pattern as `focusThread`). Alternative considered:
  dispatching `thread.loop.toggle` directly over the island renderer's own
  WebSocket NativeApi (zero IPC). Rejected for v2: island stays a read-only WS
  subscriber; mutations go through the main process like `focusThread`.
- No changes to `islandGeometry` (shared or desktop), `islandWindow.ts`,
  `settings.ts`, or server code.
- Linux parity: no click-through forwarding → hover unreachable; pop already
  resizes the window per state. No special handling beyond what PR #54 does.
- No framer-motion or any new dependency: CSS keyframes + one
  `element.animate()` call.

## 5. Implementation plan (small PRs, in order)

Each PR is independently mergeable and small (user preference).

1. **PR 1 — ember-glass restyle** (base: PR #54 branch). `island.css` +
   `IslandOrb.tsx` + `Island.tsx` surface/orb/crossfade/pop-spring. No
   contracts, no tracker changes. ~250 lines.
2. **PR 2 — hover headline + expanded rows**. Headline row, header polish,
   glass chips, hue-colored status words, row hover actions (Open only —
   `focusThread`). Tracker untouched except any presentational field already
   available on the shell.
3. **PR 3 — shared loop formatting** (base: loop-phase-1). Extract
   `formatRemainingTime`/`formatStopReason` to `packages/shared/src/loop.ts`;
   LoopIndicator consumes them. Pure refactor, tests move with it.
4. **PR 4 — island loop integration** (requires both branches merged).
   Tracker `looping` status + `loop` field + `loop-stopped` pop (with tests);
   loop chips in pill/hover/rows; violet orb state; `stopLoop` IPC
   (contracts + islandIpc + preload + channels + tests mirroring
   `focusThread`).
5. **PR 5 — LoopIndicator restyle**. Mini-orb + chip + progress hairline in
   the composer banner, reusing PR 1's orb (promote `IslandOrb` to
   `apps/web/src/components/ui/StatusOrb.tsx` here, not earlier).

Suggested merge order for the bases: land loop-phase-1 and PR #54 first;
PRs 1–2 can proceed on the island branch immediately.

## 6. Open questions

1. Merge order of PR #54 vs `devin/loop-phase-1`? PR 4 needs both.
2. Is Stop (re-arm via composer) sufficient for v2, or is pause/resume wanted?
   Pause requires a contracts field + `loopDecision.ts` branch — out of scope
   here; would be its own small PR series.
3. Should approvals ever be one-click from the island? v2 stays
   focus-to-approve for safety (no diff visible from the island).
4. Transcript snippet under row titles needs a `latestAssistantSnippet` field
   on the shell — deferred; do not add island-side per-thread subscriptions.
