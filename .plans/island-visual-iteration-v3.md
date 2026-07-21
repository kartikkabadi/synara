# Island v3 — Visual Iteration ("looks very bad still. Could be much better.")

Status: design, ready for implementation. Iterates on the *visuals* of
`.plans/island-siri-orb-v2.md`; architecture, tracker, and loop plans there
stand unchanged. Based on runtime evidence from PR #54
(`devin/1784570000-notch-island`) on Windows and Linux.

---

## 1. What the screenshots actually show

- **Collapsed pill**: a flat, matte, near-black capsule with one small dim
  gray dot floating in the center. No visible gradient, no glass, no glow.
  It reads as a dead sticker — closer to a misrendered tooltip than a
  Dynamic Island.
- **Expanded panel**: a 560×320 black rectangle that is ~85% empty. A small
  gray dot + "No active sessions" floats near the top; the bottom two-thirds
  is dead space. The `SESSIONS` caption and `⌘⇧I` hint sit awkwardly in the
  corners.
- **Against a light desktop** (both OSes ship light-theme apps behind it),
  the pill has zero rim definition — the `white/10` border and inset
  highlight are invisible at 1x on a 32px-tall surface.
- The `⌘⇧I` hint renders with mac glyphs **on Windows** (visible in the
  expanded screenshot) — the display-context platform fallback is wrong.

## 2. Ranked issues (worst first)

1. **Idle orb looks dead, not "sleeping".** `opacity: .4` +
   `saturate(.15)` turns the orb into a flat gray dot. There is no visible
   bloom, no sheen, no specular highlight at 16px. The single living element
   of the design is the single worst-looking element on screen.
2. **The surface reads flat matte, not glass.** The 180° zinc gradient spans
   only 32px in the pill — imperceptible. No backdrop blur is possible
   (transparent BrowserWindow), and nothing else (vignette, layered inner
   glows, edge light) compensates. Result: a solid black blob.
3. **Rim definition is invisible on light backgrounds.** `border-white/10` +
   `inset 0 1px 0 white/8` disappears against light desktops; the pill has a
   harsh, aliased silhouette. Needs a real two-tone rim (light top edge, dark
   bottom edge) plus an outer 1px dark keyline.
4. **Expanded panel is a black void.** 560×320 fixed size regardless of
   content; empty state uses the same tiny dim orb; no vignette, no footer,
   no structure below the rows. Feels unfinished.
5. **Collapsed composition is unbalanced.** A 180px-wide capsule with a
   single 16px dot dead-center. The v2 spec places the orb in the *left cap*
   with count text; with zero sessions the pill should shrink (or show a
   subtle wordmark), not present a big empty capsule.
6. **No depth separation from the desktop.** The single
   `0 8px 32px black/45` shadow produces a sticker-like halo. Needs a tight
   contact shadow + soft ambient shadow pair.
7. **State glow is imperceptible.** `0 0 24px hue/.15` is below visibility
   threshold on any real desktop; active states don't read at a glance.
8. **Typography/hierarchy is weak.** `SESSIONS` all-caps caption +
   corner-pinned `⌘⇧I` + centered `No active sessions` at three different
   grays with no rhythm. And the shortcut hint shows mac glyphs on Windows
   (platform detection bug).
9. **Motion is flat.** Only the auto-pop has a spring; hover/expand resizes
   with a plain 220ms ease-out and content merely fades in. Nothing feels
   "alive" outside the (rarely seen) pop.
10. **Expanded radius/size mismatch with the pill.** Jumping 32px-tall
    `rounded-full` → 320px-tall `rounded-[26px]` with no intermediate scale
    cue makes the expand feel like a window swap, not the same object
    growing.

## 3. Redesign specification

### 3.1 Surface — layered "ember glass" (replaces §2.2 of v2)

`island.css` `.island-surface`:

```css
.island-surface {
  background:
    /* top sheen */
    linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,0) 30%),
    /* body */
    linear-gradient(180deg, #232326 0%, #131316 45%, #0a0a0c 100%);
  border: 1px solid rgba(0,0,0,.9);              /* dark keyline vs light desktops */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.14),          /* top rim light */
    inset 0 -1px 0 rgba(0,0,0,.6),                /* bottom rim dark */
    inset 0 0 24px rgba(0,0,0,.35),               /* vignette */
    0 1px 2px rgba(0,0,0,.5),                     /* contact shadow */
    0 12px 40px rgba(0,0,0,.35);                  /* ambient shadow */
}
```

Add a rim-shimmer pseudo-element, active only while any session is active
(the v2 "shimmer only while work happens" rule):

```css
.island-surface::after {           /* liquid-glass rim */
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 1px; pointer-events: none;
  background: conic-gradient(from var(--rim-angle, 0deg),
    transparent 0deg,
    hsl(var(--island-hue) 80% 70% / .5) 40deg,
    transparent 110deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box exclude,
                linear-gradient(#000 0 0);
  opacity: 0; transition: opacity 400ms ease;
}
.island-surface[data-active="true"]::after {
  opacity: 1;
  animation: island-rim-sweep 5s linear infinite;   /* animates --rim-angle */
}
@property --rim-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@keyframes island-rim-sweep { to { --rim-angle: 360deg; } }
```

(If `@property` support is a concern in the Electron Chromium in use, fall
back to rotating a masked oversized `::after` with `transform: rotate()`.)

Bump the state glow so it actually reads:
`0 0 20px hsl(var(--island-hue) 85% 60% / .35), 0 0 48px hsl(var(--island-hue) 85% 55% / .18)`
(floating). Keep the downward-only variant for notch mode, same doubling.

### 3.2 Orb — from dot to lamp

- **Sizes**: 18px collapsed pill (up from 16), 15px rows, **28px** in the
  expanded empty state (it's the hero there).
- **Idle must glow faintly, not gray out**: replace
  `opacity:.4; saturate(.15)` with a dim ember —

```css
.island-orb[data-orb-state="idle"] .island-orb-core {
  background: radial-gradient(circle at 35% 30%,
    hsl(220 30% 60%), hsl(222 25% 35%) 55%, hsl(224 25% 16%));
}
.island-orb[data-orb-state="idle"] .island-orb-bloom { opacity: .25; }
.island-orb[data-orb-state="idle"] { opacity: .9; }   /* was .4 */
```

- **Specular highlight** (the missing "sphere" cue) — new child, above core:

```css
.island-orb-spec {
  position: absolute; inset: 0; border-radius: 9999px;
  background: radial-gradient(circle at 32% 26%,
    rgba(255,255,255,.9), rgba(255,255,255,.25) 22%, transparent 40%);
}
```

- **Bloom**: enlarge beyond the orb bounds so it actually blooms:
  `inset: -35%; filter: blur(8px); opacity: .8` (active) / `.25` (idle).
- **Dark seat**: give the orb a recessed socket in the pill so it looks
  mounted, not pasted: wrapper `box-shadow: inset 0 1px 2px rgba(0,0,0,.6)`
  on a `p-[3px] rounded-full bg-black/40` ring (collapsed pill only).
- **Active scale**: `working`/`needs-approval`/`looping` scale the whole orb
  1.15× via transform (composited), so state change is visible from across
  the room.
- Sheen conic stays; raise peak alpha `.35 → .5` so drift is visible at 18px.

### 3.3 Collapsed pill composition

- Idle (0 sessions): shrink to `{ width: 64, height: 30 }` floating — just
  the seated orb, centered. No half-empty 180px capsule.
  (`islandCollapsedSize` gains a `sessionCount === 0` branch; renderer passes
  count through the existing `setState` mirror or a tiny `setIdle` IPC —
  smallest option: include it in the state string is wrong; add
  `setBadge(count: number)` on `IslandBridge`.) Notch mode keeps
  notch-derived width (hardware-anchored) in both cases.
- Active: orb seated in the **left cap** (`pl-2.5`), count `text-[13px]
  font-semibold tabular-nums text-white/90`, then flexible space. Right cap
  gets a 3px hue tick (`h-1 w-1 rounded-full bg-[hsl(var(--island-hue)_85%_65%)]`)
  as a counterweight.

### 3.4 Expanded panel

- **Content-driven height**: `height = clamp(140, 64 + rows*44 + 12, 320)`.
  Sizing already flows through `islandStateSize` — add
  `islandExpandedSize(rowCount)` in `islandGeometry.ts` and pass the count
  from the renderer via the existing `setState` path (extend
  `IslandBridge.setState(state, meta?)`). Empty state: 560×180.
- **Header**: keep `Sessions` label but `text-xs font-medium text-white/60`
  (drop the all-caps tracking-widest); move the shortcut hint into a glass
  chip (`rounded border border-white/10 bg-white/5 px-1 text-[10px]
  text-white/40`); fix `shortcutHint` — trust
  `navigator.platform`/`userAgentData` when `context.platform` is missing
  **and verify the Windows display context actually reports `"windows"`**
  (screenshot shows ⌘ on Windows).
- **Hairline** under the header: `border-b border-white/6`.
- **Rows**: 44px tall, `rounded-lg`, hover `bg-white/6`; title
  `text-[13px] text-white/90`; keep chips. Add a faint hue left-edge on the
  hovered row: `inset 2px 0 0 hsl(var(--island-hue) 80% 60% / .5)`.
- **Empty state**: centered vertically in the 180px panel — 28px idle orb,
  `No active sessions` `text-sm text-white/60`, sub-line
  `New agent turns will appear here` `text-xs text-white/35`.
- **Vignette**: panel-only overlay
  `radial-gradient(120% 90% at 50% 0%, transparent 55%, rgba(0,0,0,.4))`.

### 3.5 Motion

- Give **every** state change the spring, not just pops: on any
  `effectiveState` transition run the existing WAAPI overshoot
  (`scale 1 → 1.02 → 1`, 260ms, `cubic-bezier(0.34,1.56,0.64,1)`) alongside
  the 220ms size transition. (Still a status animation, not a disclosure —
  the documented `disclosureMotion.ts` exemption stands.)
- Pop keeps the bigger 1.035 overshoot + a one-shot glow flash: animate the
  surface `filter: brightness(1) → 1.25 → 1` over 500ms.
- Crossfade stays; drop its 60ms delay when going expanded → collapsed (the
  pill content should be there when the shrink lands).
- All guarded by the existing `prefers-reduced-motion` checks.

### 3.6 State legibility

| state          | orb                         | surface                        |
| -------------- | --------------------------- | ------------------------------ |
| idle           | dim ember, spec only        | no glow, no rim                |
| working        | cyan 205, sheen 6s, 1.15×   | cyan glow + rim sweep 5s       |
| looping        | violet 265, sheen 3s, 1.15× | violet glow + rim sweep 3.5s   |
| needs-approval | amber 40, double-pulse      | amber glow, **no** rim sweep (pulse owns attention) |
| done           | emerald 150, static         | brief flash then glow fades over 2s |

### 3.7 macOS notch mode

Unchanged geometry (`notch.width + 60`, `rounded-b-2xl`, downward glow).
Two additions: kill the top rim light in notch mode
(`inset 0 1px 0` → none; the top edge must fuse with the bezel), and darken
the body top stop to pure `#000` so the pill and the physical notch read as
one object.

## 4. Implementation plan (small PRs, in order)

1. **PR A — surface + orb relight** (~120 lines, `island.css` +
   `IslandOrb.tsx`): §3.1 layers/shadows/keyline, §3.2 idle ember, spec
   highlight, bigger bloom, active scale, notch top-edge fix. Pure CSS +
   one new span. Biggest visual win, zero contracts.
2. **PR B — motion + glow legibility** (~60 lines, `Island.tsx` +
   `island.css`): spring on all state changes, glow bump, rim sweep,
   done-flash. Includes the `shortcutHint`/display-context platform fix.
3. **PR C — expanded panel structure** (~80 lines, `Island.tsx` +
   `island.css`): header restyle, hairline, vignette, row polish, empty
   state.
4. **PR D — adaptive geometry** (`islandGeometry.ts` + contracts +
   `islandIpc`): idle mini-pill, content-driven expanded height,
   `setBadge`/`setState` meta. Only PR touching contracts; ship last.

Verify each PR with the same Linux + Windows screenshot harness used for
PR #54 evidence, at 1x on a light desktop wallpaper (the failure case).

## 5. Open questions

1. Is `@property`-based rim sweep acceptable, or should we use the
   transform-rotate fallback unconditionally (older Electron)?
2. Idle mini-pill (64×30) vs. hiding the island entirely when idle — hide is
   simpler but loses the "expand to check" affordance.
3. PR D's `setState` meta vs. a dedicated `setBadge` IPC — preference?
