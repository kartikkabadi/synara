# Island v4 — Notch-Native Morph (agent-notch × GhostNotch, Electron-adapted)

Status: design, ready for implementation. Iterates on
`.plans/island-visual-iteration-v3.md` using research from two macOS notch
apps (agent-notch, GhostNotch) and the v3 visual critique of PR #54
(`devin/1784570000-notch-island`). Architecture principle changes; v3's
surface/orb material work carries forward with fixes.

---

## 0. Key principles

1. **One window, one surface, one morph.** The BrowserWindow is pre-sized to
   the maximum expanded bounds (+ shadow margin) on *every* platform —
   including Linux — and never resizes per state. All state transitions are
   CSS/WAAPI transforms on a single `.island-surface` element. This is what
   makes GhostNotch feel like one object growing instead of a window swap
   (v3 critique flaw #1).
2. **Top-flush, bottom-rounded.** Like both reference apps, the island is
   anchored to the top edge and only its *bottom* corners round: r=14
   collapsed/hover, r=18 expanded. The expanded panel grows *downward* from
   the same top edge and horizontal center as the pill — never detached,
   never left-shifted (flaw #2).
3. **Restrained, physical shadows.** Contact + ambient pair, never one mega
   blur (flaw #3).
4. **The orb is a lamp, not a dot.** Visible even at idle; seam-free sheen
   (flaws #4, #5).
5. **Every pixel of the panel earns its place.** Content-driven height,
   structured header/rows/empty state (flaw #6).
6. **Linux is a first-class degraded mode**, not a broken one (flaw #7).

## 1. Architecture: pre-sized window, DOM-only morph

### 1.1 Window bounds (islandGeometry.ts / islandWindow.ts)

- Delete the Linux special case (`islandStateBounds` per-state resize path in
  `IslandWindowManager.setState` / `create` / `reanchor`). All platforms use
  `islandWindowBounds` = expanded max size **plus margin**:

```ts
// Room for ambient shadow + glow so nothing clips at the window edge.
export const ISLAND_WINDOW_MARGIN = { x: 48, bottom: 56 } as const;
export const ISLAND_MAX_SURFACE: IslandSize = { width: 560, height: 320 };
export const ISLAND_WINDOW_SIZE: IslandSize = {
  width: ISLAND_MAX_SURFACE.width + ISLAND_WINDOW_MARGIN.x * 2, // 656
  height: ISLAND_MAX_SURFACE.height + ISLAND_WINDOW_MARGIN.bottom, // 376
};
```

  Notch mode: window width is `max(ISLAND_WINDOW_SIZE.width, notch.width + 60
  + ISLAND_WINDOW_MARGIN.x * 2)` so the pill always covers the housing
  (agent-notch: expanded = `max(480, notchWidth + 240)` — same idea).
- The window top edge sits at the anchor top (screen top in notch mode; work
  area top + 6 elsewhere) — the surface is top-aligned inside the window, so
  margin is horizontal + bottom only. Top must stay flush.
- Linux click-through: `setIgnoreMouseEvents(true)` has no `forward` on
  Linux, so poll the cursor instead (agent-notch pattern — global mouse
  monitor): a 100 ms `screen.getCursorScreenPoint()` interval in the main
  process, active only while the window is visible; when the cursor enters
  the *current surface rect* (main process already knows state + geometry),
  `setIgnoreMouseEvents(false)`; when it leaves, re-ignore after a 40 ms
  grace (GhostNotch hover-exit grace).
- Because the window never resizes, `setState` on the main side becomes pure
  bookkeeping (state + sessionCount for the cursor-rect math); `setBounds`
  happens only in `reanchor()` on display changes.

### 1.2 Surface morph (Island.tsx)

The inner `.island-surface` is the shared element. It is absolutely
positioned `top: 0; left: 50%; transform: translateX(-50%)` inside the
window and animates only `width`, `height`, and `border-radius`:

```css
.island-surface {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  transition:
    width 260ms cubic-bezier(0.32, 0.72, 0, 1),
    height 260ms cubic-bezier(0.32, 0.72, 0, 1),
    border-radius 260ms cubic-bezier(0.32, 0.72, 0, 1);
}
```

`cubic-bezier(0.32, 0.72, 0, 1)` is the Apple-sheet ease — fast start, long
settle — the closest CSS analog to GhostNotch's 340 ms / 0.78-damping spring
without WAAPI spring polyfills. Reduced motion: `transition: none`.

Because top and horizontal center are fixed, expansion reads as the pill
itself growing downward — the shared-element morph.

## 2. Shape & layout spec

| state           | notch mode                         | floating (non-notch mac / Win / Linux) |
| --------------- | ---------------------------------- | -------------------------------------- |
| collapsed idle  | (notch.width + 60) × notch.height  | 64 × 30                                 |
| collapsed active| (notch.width + 60) × notch.height  | 180 × 32                                |
| hover           | max(notch.width + 200, 420) × 104  | 420 × 104                               |
| expanded        | 560 × clamp(140, 64+rows·44+12, 320); empty 560 × 180 | same |

Border-radius (bottom corners only — GhostNotch values):

```css
/* collapsed + hover */  border-radius: 0 0 14px 14px;
/* expanded */            border-radius: 0 0 18px 18px;
```

- Notch mode: top corners hard 0 — the surface fuses with the bezel.
- Floating mode: same bottom-rounded shape (the island still reads as
  "hanging from the top edge" of its own window), but with a 1px top rim
  treatment (§3) so the flat top edge looks intentional, not clipped:
  top corners get a small `10px` radius so the silhouette isn't a raw slab:
  `border-radius: 10px 10px 14px 14px` (18px bottom when expanded).

## 3. Surface material (island.css)

```css
.island-surface {
  background:
    /* top sheen */
    linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,0) 30%),
    /* body */
    linear-gradient(180deg, #26262a 0%, #101013 100%);
  border: 1px solid rgba(0,0,0,.9);            /* outer dark keyline */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.14),        /* top rim light (floating only) */
    inset 0 -1px 0 rgba(0,0,0,.6),              /* bottom rim dark */
    inset 0 0 24px rgba(0,0,0,.35),             /* inner vignette */
    0 1px 2px rgba(0,0,0,.5),                   /* contact shadow */
    0 8px 24px rgba(0,0,0,.28);                 /* ambient shadow (restrained) */
}
```

- **Anti-aliasing the top edge** (flaw #8): the 1px dark keyline + the
  10px top radius in floating mode give Chromium something to anti-alias;
  in notch mode the top edge is off-screen-flush so aliasing is invisible.
- **Notch variant** (`.island-surface-notch`): body top stop → `#000`, drop
  the top rim light and `border-top`, and make the ambient shadow
  downward-only: `0 10px 24px -6px rgba(0,0,0,.35)`.
- **Noise overlay** (kills 8-bit banding on the long gradient): a dedicated
  pseudo-element (`::before`) with a tiling SVG fractal noise at 1.5%:

```css
.island-surface::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none; opacity: 0.015;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

  (Rim sweep moves to a nested element, since `::before`/`::after` are now
  noise + rim; keep rim on `::after` as today and noise on `::before`.)
- State glow classes (`-glow`, `-glow-notch`, `-glow-done`) carry over from
  v3 unchanged except the ambient base updates to `0 8px 24px rgba(0,0,0,.28)`
  in every variant.

## 4. Orb (IslandOrb.tsx + island.css)

Sizes: 18px collapsed, 15px rows, 28px empty-state hero (unchanged).

- **Seam fix (flaw #5):** the current sheen conic ends `transparent 300deg`
  → hard step back to the 0deg stop at 4 o'clock. Close the loop —
  first and last stops must match:

```css
.island-orb-sheen::before {
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    rgba(255,255,255,.5) 60deg,
    transparent 140deg,
    rgba(255,255,255,.12) 220deg,
    transparent 300deg,
    transparent 360deg    /* explicit closed loop, same value as 0deg */
  );
}
```

  Verification step: screenshot the hero orb at 28px/2x and inspect the
  4-o'clock edge; if any step survives Chromium's conic interpolation,
  switch to the fallback — a rotating *radial* sheen (offset radial
  highlight on a rotating wrapper), which cannot seam:

```css
.island-orb-sheen-radial::before {
  background: radial-gradient(circle at 70% 30%,
    rgba(255,255,255,.45), transparent 45%);
  animation: island-orb-spin 6s linear infinite;
}
```

- **Idle ember (flaw #4):** must read as a dim blue-slate *sphere* with a
  specular and faint bloom at 64×30 pill size:

```css
.island-orb[data-orb-state="idle"] { opacity: 1; }        /* was .9 */
.island-orb[data-orb-state="idle"] .island-orb-core {
  background: radial-gradient(circle at 35% 30%,
    hsl(218 45% 66%), hsl(220 35% 38%) 55%, hsl(224 30% 18%));
}
.island-orb[data-orb-state="idle"] .island-orb-bloom { opacity: .3; }
.island-orb[data-orb-state="idle"] .island-orb-spec  { opacity: .8; }
```

- Active states: keep 1.15× transform scale, bloom `opacity: .8`,
  hue per state (working 205 / looping 265 / needs-approval 40 / done 150).
- Keep the seat ring in the collapsed pill only.

## 5. Motion spec

- **Morph:** width/height/border-radius on `.island-surface`,
  `cubic-bezier(0.32, 0.72, 0, 1)` 260ms (§1.2). Optional GhostNotch tuning:
  expand 340ms, collapse 180ms (`transition-duration` swapped per direction
  via `data-island-state`).
- **Content choreography** (replaces the current single crossfade):
  - Outgoing content: `opacity 1 → 0` over the first 90ms (~35% of 260ms),
    no transform, then unmount.
  - Incoming content: starts at 65ms delay (~25%); header
    `translateY(-4px) → 0`, body `translateY(-10px) → 0`, opacity 0 → 1,
    170ms ease-out. Two keyframes:

```css
.island-enter-header { animation: island-enter-h 170ms ease-out 65ms both; }
.island-enter-body   { animation: island-enter-b 170ms ease-out 65ms both; }
@keyframes island-enter-h { from { opacity: 0; transform: translateY(-4px); } }
@keyframes island-enter-b { from { opacity: 0; transform: translateY(-10px); } }
```

  Implementation: keep outgoing content mounted for 90ms via a tiny
  two-phase state (`leaving` → swap) in Island.tsx; simpler than
  FLIP/portal tricks and enough at these durations.
- **Pop flash:** unchanged one-shot WAAPI `brightness(1 → 1.25 → 1)` 500ms
  on status change, plus scale 1.035 overshoot.
- **Rim sweep:** active only for `working` (5s) / `looping` (3.5s) — as
  today.
- All motion behind the existing `prefers-reduced-motion` guards.

## 6. Panel structure (expanded)

- **Header:** `Sessions` `text-xs font-medium text-white/60` left; glass
  shortcut chip right (`rounded border border-white/10 bg-white/5 px-1
  text-[10px] text-white/40`); `border-b border-white/6` hairline below.
  Chip text is platform-aware: `⌘⇧I` only when the display context (or
  UA fallback) is macOS, else `Ctrl⇧I` — the v3 fix stands; add a unit test
  asserting the Windows display context yields `Ctrl⇧I`.
- **Rows:** 44px, `rounded-lg`, hover `bg-white/6` + left hue edge
  `inset 2px 0 0 hsl(var(--island-hue) 80% 60% / .5)`; title
  `text-[13px] text-white/90`, provider chip, status label, and a relative
  time (`2m`) `text-[10px] text-white/40` before the status chip.
- **Empty state (flaw #6):** 560×180 panel; vertically centered stack —
  28px hero orb, `No active sessions` `text-sm text-white/60`,
  `New agent turns will appear here` `text-xs text-white/35`.
- **Vignette:** bottom-weighted overlay
  `radial-gradient(120% 90% at 50% 0%, transparent 55%, rgba(0,0,0,.4))`.
- Height is content-driven via `islandExpandedSize(rowCount)` (already in
  shared geometry) — now consumed only by the renderer, not `setBounds`.

## 7. Platform adaptations

### 7.1 macOS notch

- Detection heuristic unchanged (`workArea.y - bounds.y ≥ 30`); width =
  `DEFAULT_NOTCH_WIDTH + 60`, height = top inset (agent-notch derives these
  from safe-area/auxiliary APIs; Electron can't, so the heuristic + fixed
  width stands, documented).
- Surface is flush with screen top; `.island-surface-notch` variant (§3).
- Ambient shadow downward-only so no halo around the physical housing.

### 7.2 Windows

- Floating synthetic island 6px below the work-area top, top-rounded 10px.
- `setIgnoreMouseEvents(true, { forward: true })` hover model unchanged.

### 7.3 Linux (flaw #7 — the "looks broken" platform)

- **Window flags:** keep `frame: false, transparent: true, skipTaskbar:
  true, focusable: false`; add `type: "toolbar"` (X11-supported; `"panel"`
  is not a documented Electron type) and ensure no `titleBarStyle` is ever
  set. `roundedCorners: false` stays (it's a mac-only flag anyway).
- **Square corners:** with the pre-sized window (§1.1) the visible shape is
  pure CSS — `border-radius` + `overflow: hidden` on `.island-surface`
  inside a fully transparent window, so WM corner handling becomes
  irrelevant. Root and body must be `background: transparent` (already
  done in Island.tsx).
- **Titlebar/decoration overlap:** if the WM still draws decorations
  despite `frame: false`, set `_MOTIF_WM_HINTS` (decorations=0) on the X11
  window id (`window.getNativeWindowHandle()`) via a best-effort
  `xprop`-style call; if that fails, document degraded mode: the island
  renders correctly *within* its window, and the decoration offset is
  compensated by positioning with `setBounds` (below).
- **Positioning:** always `setBounds({ x, y, width, height })` in one call —
  never `setPosition` alone — so WMs that re-clamp size on move can't drift
  the window.
- **Click-through:** cursor-poll model (§1.1); if `setIgnoreMouseEvents`
  itself is unsupported on the running WM/Wayland, degrade to
  interactive-always (the window is transparent outside the surface, but
  clicks in the transparent margin are eaten — acceptable degraded mode,
  documented).
- Wayland: always-on-top degrades silently (unchanged v2/v3 note).

### 7.4 Shortcuts

- Global: `CommandOrControl+Shift+I` (unchanged). Hint rendering per §6.

## 8. Implementation plan (small PRs, in order)

1. **PR 1 — window architecture** (`packages/shared/islandGeometry.ts`,
   `apps/desktop/src/island/islandGeometry.ts`, `islandWindow.ts`,
   `islandIpc.ts` if the setState payload slims down):
   pre-sized window with margins on all platforms, delete Linux per-state
   `setBounds`, cursor-poll click-through for Linux, `type: "toolbar"`,
   single-call `setBounds` in `reanchor`. Update geometry tests.
2. **PR 2 — surface morph + shape** (`Island.tsx`, `island.css`):
   absolute top-center `.island-surface`, sheet-ease transitions,
   bottom-rounded radii (14/18, 10px top in floating), new shadow pair,
   #26262a→#101013 body, noise `::before`. Biggest visual win.
3. **PR 3 — orb relight** (`island.css`, `IslandOrb.tsx`):
   closed-loop sheen conic (+ radial fallback verification), idle ember
   values, spec opacity. Includes the 4-o'clock seam screenshot check.
4. **PR 4 — content choreography + panel polish** (`Island.tsx`,
   `island.css`): two-phase content swap, enter keyframes, row relative
   time, empty-state centering, shortcut-hint unit test.

Verify each PR with the Linux + Windows screenshot harness from PR #54 at
1x on a light desktop wallpaper, plus a synthetic notch-metrics run for the
macOS variant.

## 9. Open questions / risks

1. Linux cursor-poll interval (100ms) vs battery: acceptable? Alternative
   is interactive-always on Linux.
2. `_MOTIF_WM_HINTS` needs an X11 native call or `xprop` child process —
   ship as best-effort or skip entirely and rely on `frame: false`?
3. Directional durations (340ms open / 180ms close) vs a single 260ms —
   pick after seeing the morph live.
