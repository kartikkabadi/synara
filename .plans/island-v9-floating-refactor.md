# Island v9 — Floating Shell Refactor (subtraction pass)

Design doc for PR #54 v9. Consumed by implementation agents working on branch
`devin/1784570000-notch-island`. Synthesized from five research agents: reference-image
extraction, Impeccable (pbakaus/impeccable), Emil Kowalski design-eng, Vercel Web
Interface Guidelines, and a code audit of the current branch.

---

## 1. Goals and non-goals

### Goals

- Refactor **through subtraction**: remove decorative effects; do not add new visual ideas.
- Introduce two shell modes:
  - `floating` — Windows, Linux, non-notched macOS. **Fully implemented this pass.**
  - `notch` — notched macOS. **Stub only** (reuses floating rendering, gated behind the
    shell attribute for a later pass).
- One calm geometry morph between collapsed / hover / expanded; no secondary animation.
- Keep session tracking (`islandSessionTracker.ts`) and IPC (`islandIpc.ts`, contracts
  `IslandBridge` / `IslandWindowState` / `IslandDisplayContext`) **unchanged**. Shell mode is
  derivable in the renderer from `context.platform` + `context.notch` — no contract changes.
- No new dependencies.

### Non-goals

- Implementing the real notch shell (camera-housing fusion) — later pass.
- Changing auto-pop triggers, priority logic, or the Ctrl+Shift+I shortcut semantics.
- Any server/web-app work outside `apps/desktop/src/island`, `apps/web/src/components/island`,
  and `packages/shared/src/islandGeometry.ts`.

---

## 2. Visual spec

### Position (floating shell)

- Anchored top-center of the display, **9px below the work-area top**
  (`ISLAND_FLOATING_TOP_MARGIN: 0 → 9`; within the required 8–10px band).
- Window stays pre-sized to max surface + shadow margin; renderer morphs the inner surface
  (current architecture — keep; `setBounds` only on display changes).
- Keep the darwin hidden-menu-bar fallback (`DARWIN_HIDDEN_MENU_BAR_TOP_INSET = 38`).

### Sizes (visible surface)

| State | Width | Height | Radius |
|---|---|---|---|
| Collapsed (sessions > 0) | content-fit, ~110–140px | **32px** | 16px (height/2, full pill) |
| Collapsed (idle, 0 sessions) | ~64px | **30px** | 15px |
| Hover | **372px** | **80px** | 20px |
| Expanded | **432px** | content-driven, **max 288px** | 22px |

- Expanded height formula stays content-driven: `chrome + rowCount * rowHeight`, clamped to
  ≤288. Suggested: row height 44px, chrome ~64px, empty state ~140px.
- All four corners rounded in every state. No top-flush fusion in floating mode.

### Surface

- Background: `rgba(10, 10, 12, 0.94)` — near-black, almost opaque, flat. **No backdrop
  blur** (Electron transparent windows cannot blur the desktop reliably).
- Border: exactly one — `1px solid rgba(255, 255, 255, 0.08)`.
- Shadow, neutral only:
  `0 1px 2px rgba(0,0,0,0.30), 0 8px 24px rgba(0,0,0,0.35)`.
- `color-scheme: dark` on the island document root.

### Removed (delete outright — see §6)

Colored surface glow, rim sweep (surface + orb), noise texture, interior hue wash,
brightness flash, hue rotation, permanently breathing orb, panel vignette, glass chip
gradients.

### Orb → status light

- Single element, **9px** diameter dot, `border-radius: 50%`.
- Fill = state color; halo = one small static glow: `box-shadow: 0 0 6px
  <state-color at ~0.35 alpha>`.
- State colors: keep the existing state→color mapping (working / needs-approval / done /
  idle) from `IslandOrb.tsx`; render as flat fills, no gradients or layers.
- Color changes transition `background-color, box-shadow` 150ms ease.
- **Only `needs-approval` may pulse**: one brief transition pulse (≤2 iterations, ~600ms
  each) when entering the state, then static. Nothing animates continuously while idle.

### Typography

- Platform UI font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, system-ui,
  sans-serif` (or the app's existing sans token). **No `font-mono`, no bold display titles.**
- Sizes: title 13px / weight 500; secondary 11px / weight 400; count uses `tabular-nums`.
- Opacity hierarchy on white text: primary 0.92, secondary 0.60, tertiary 0.40.
- Working copy ends with the `…` character (e.g. `Working…`), never `...`.

---

## 3. Content spec

### Collapsed

- Status light + session count (`tabular-nums`), nothing else. Idle (0 sessions): status
  light only. `aria-label` describes aggregate state.

### Hover

- Shows **only the highest-priority session** (drop `summarizeRest` and its helper):
  - Line 1: session title (truncate, `min-w-0`) + status text.
  - Line 2: provider name + relative time.
- Auto-pop enters this hover preview (never expanded).

### Expanded rows

- Same two-line hierarchy as hover: line 1 title + status; line 2 provider + relative time.
- Whole row is a single semantic `<button>` — **remove provider glass chips and the
  duplicate Open/status hover swap**. Row hover feedback: background
  `rgba(255,255,255,0.04)` and/or a small chevron at tertiary opacity; nothing more.
- Hit height ≥ 40px (≥24px minimum per Vercel guidelines). Visible `:focus-visible` ring.
- Status not conveyed by color alone: rows include status text (already in line 1).
- List: `overscroll-behavior: contain`; no scrollbars unless content exceeds max height.

### Header & controls (retain, restrained)

- "Sessions" header (13px / 500), shortcut hint (Ctrl+Shift+I, tertiary opacity,
  non-breaking space in the key lockup), close button (icon-only, `aria-label="Close"`).

### Empty state

- Single line, secondary opacity: e.g. "No active sessions". Deliberate, no illustration.

---

## 4. Motion spec

One geometry morph is primary; everything else is subordinate fades.

| Motion | Duration | Easing |
|---|---|---|
| Open (collapsed→hover, hover→expanded, collapsed→expanded) | **300ms** | `cubic-bezier(0.32, 0.72, 0, 1)` (iOS curve) |
| Close (any → smaller state) | **200ms** | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Content fade/translate | **130ms**, translateY ≤ 3px | `cubic-bezier(0.23, 1, 0.32, 1)` |
| Hover row / control feedback | 150ms | `ease` |
| Status-light color change | 150ms | `ease` |

- The morph is the existing single `width / height / border-radius` CSS transition on
  `.island-surface`, retimed with the asymmetric durations above. CSS transitions (not
  keyframes) so rapid state churn retargets smoothly. List transition properties
  explicitly — never `transition: all`.
- **Delete**: WAAPI scale springs on every state change, brightness flash, animated rim,
  all breathing/pulse/hue keyframes (except the single needs-approval pulse).
- Timers: **hover-open delay 120ms** (pointer must dwell before hover state opens);
  **exit grace 150ms** (pointer leaving hover doesn't collapse until grace elapses).
  Align `LINUX_CURSOR_EXIT_GRACE_MS` (currently 250) to **150**.
- Keyboard toggle (Ctrl+Shift+I): no added delay; the 300/200ms morph is the only motion.
- `prefers-reduced-motion`: replace the geometry morph with a 200ms opacity fade; keep
  color fades; remove all translate motion. Gate hover effects behind
  `@media (hover: hover) and (pointer: fine)`.

---

## 5. Interaction spec

States: `collapsed`, `hover`, `expanded` (existing `IslandWindowState`).

- **Pointer enter (collapsed)** → after 120ms dwell → `hover`.
- **Pointer leave (hover)** → after 150ms grace → `collapsed`. Collapses **hover state
  only**.
- **Pointer leave (expanded)** → does **nothing** immediately. Expanded closes only via:
  1. the close button,
  2. the keyboard shortcut,
  3. activating (opening) a row,
  4. inactivity timeout: `EXPANDED_IDLE_COLLAPSE_MS: 8_000 → 13_000` (12–15s band),
     reset on any pointer movement or key event inside the panel.
- **Auto-pop** (needs-approval / turn-complete): enters **hover preview** for
  `AUTO_POP_MS` (keep 4s), then returns to collapsed. No spring/flash. Announce via an
  `aria-live="polite"` region.
- **Click collapsed/hover surface** → `expanded`. **Click row** → open thread + collapse.
- Keyboard: rows focusable in DOM order; Escape closes expanded; visible focus rings
  everywhere (never `outline: none` without replacement).

---

## 6. Architecture and file changes

### Shell mode attributes

- Renderer derives `shell = context.notch != null ? "notch" : "floating"`.
- Root island element gets `data-island-shell="floating" | "notch"` and
  `data-island-platform="darwin" | "win32" | "linux"`.
- All shell-specific CSS keys off `[data-island-shell=…]`; platform tweaks off
  `[data-island-platform=…]`. Notch mode is a stub: it currently renders the floating
  styles under its own attribute value.

### Files changed

| File | Change |
|---|---|
| `packages/shared/src/islandGeometry.ts` | New floating sizes: hover 372×80, expanded 432×(≤288), collapsed heights 32/30. Replace notch-presence branching in `islandStateSize`/`islandHoverSize` with an explicit shell-mode parameter (`"floating" | "notch"`, notch stub keeps current behavior). Remove obsolete size constants. |
| `apps/desktop/src/island/islandGeometry.ts` | `ISLAND_FLOATING_TOP_MARGIN: 0 → 9`. Keep `detectNotch` (drives the notch stub). Update top-flush anchoring comments; update re-exports. |
| `apps/desktop/src/island/islandGeometry.test.ts` | Rewrite size/anchor expectations for the new constants and 9px top margin. |
| `apps/desktop/src/island/islandWindow.ts` | `LINUX_CURSOR_EXIT_GRACE_MS: 250 → 150`; comment cleanup. |
| `apps/web/src/components/island/island.css` | Rewrite (see removals below): four-corner rounded surface, near-black flat background, one border, neutral shadow, retimed morph (300/200ms), content fade 130ms/≤3px, status-light styles, `[data-island-shell]`/`[data-island-platform]` selectors, trimmed reduced-motion block, `color-scheme: dark`. |
| `apps/web/src/components/island/Island.tsx` | Set shell/platform data attributes; delete WAAPI springs + flash, glow class logic, `island-state-wash` div, `--island-hue` plumbing, `orbHue` import; hover shows only top session (drop `summarizeRest`); two-line rows; remove chips and Open/status swap; platform font (drop `font-mono`/`font-bold`); add 120ms hover-open delay + 150ms exit grace timers; `EXPANDED_IDLE_COLLAPSE_MS → 13_000`; keep auto-pop→hover; `aria-live` region. |
| `apps/web/src/components/island/IslandOrb.tsx` | Reduce to single 9px status-light element with state color + static halo; keep state→color mapping; drop 3-layer structure and `orbHue` export if unused. |
| `apps/web/src/components/island/Island.test.ts` | Update for removed elements/classes and new timers. |

### Files/sections removed (island.css)

- `.island-surface-glow`, `-glow-notch`, `-glow-done`, `@keyframes island-glow-fade`
- `@property --island-rim-angle`, `.island-surface::after` conic-gradient rim,
  `[data-island-status=working/looping]::after`, `@keyframes island-rim-sweep`
- `.island-surface::before` noise texture
- `.island-state-wash` + idle/expanded-empty variants
- Entire 3-layer orb lamp: bloom `::before`, hue-rotate core, rim `::after`,
  `.island-orb-seat`, keyframes `island-orb-sweep`, `island-orb-bloom-breathe`,
  `island-orb-hue`, `island-orb-idle-breathe`, `island-orb-idle-drift`,
  `island-orb-breathe`
- `.island-panel-vignette`, `.island-chip` glass gradient, collapsed cross-fade override
  selectors, `.island-surface-notch` styling (replaced by the shell-attribute stub),
  reduced-motion rules for deleted animations

### Unchanged

`islandSessionTracker.ts` (+test), `islandIpc.ts` (+test), `islandPreload.ts`, contracts
`IslandBridge` / `IslandWindowState` / `IslandDisplayContext`.

### Commit order (small, focused commits)

1. `packages/shared` + `apps/desktop` geometry: floating sizes, 9px top margin, shell-mode
   parameter; rewritten `islandGeometry.test.ts`.
2. `island.css` rewrite + `IslandOrb.tsx` status-light simplification.
3. `Island.tsx` content/interaction changes (attributes, hover delay + exit grace, 13s
   timeout, two-line rows, removals) + `Island.test.ts` updates.
4. `islandWindow.ts` grace constant + comment/dead-constant cleanup sweep.

Verification per AGENTS.md: `bun run test` for island tests during iteration; one final
`bun fmt && bun lint && bun typecheck` pass at the end (never `bun test`).

---

## 7. Validation checklist

Screenshot every state on each platform-shape:

- [ ] Collapsed idle (0 sessions), collapsed with count, hover preview, expanded with 1 /
      3 / max rows, expanded empty state.
- [ ] Auto-pop → hover preview → auto-collapse (no flash, no spring).
- [ ] Hover-open delay: quick pointer pass-through does not open hover.
- [ ] Exit grace: brief pointer exit + re-enter does not collapse hover.
- [ ] Expanded survives pointer leave; collapses at ~13s inactivity, via close button,
      shortcut, and row activation.
- [ ] needs-approval: brief pulse then static; nothing animates while idle (verify with a
      10s idle watch).
- [ ] Windows at 100% / 125% / 150% display scaling — border stays 1px-crisp, 9px offset
      correct.
- [ ] Linux X11 and Wayland — click-through polling with 150ms grace, transparent window
      edges clean.
- [ ] Non-notched macOS floating; notch stub renders floating styles under
      `data-island-shell="notch"`.
- [ ] `prefers-reduced-motion`: opacity-fade fallback only.
- [ ] Keyboard: shortcut toggle, row focus traversal, Escape, visible focus rings.
- [ ] Record one video of collapsed → hover → expanded → row-open on the primary platform.

---

## 8. References used

- Reference images (holy grail): floating rounded-rect media overlay below the macOS menu
  bar — geometry/color extraction (session dd614259: ~315px wide, radius ~20–26px,
  near-black `#0a0a0a–#161616` surface, no border, neutral shadow, white/60%/40% text
  hierarchy).
- Impeccable — github.com/pbakaus/impeccable, product register: restrained neutrals, one
  accent ≤10% for state only, system sans, motion 150–250ms ease-out, subtraction first.
- Emil Kowalski (emilkowal.ski, emil-design-eng skill): frequency-based motion budget,
  iOS curve `cubic-bezier(0.32,0.72,0,1)`, strong ease-out `cubic-bezier(0.23,1,0.32,1)`,
  exits ~75% of enters, CSS transitions over keyframes, transform/opacity only where
  possible, reduced-motion opacity fallback.
- Vercel Web Interface Guidelines — vercel.com/design/guidelines: explicit transition
  properties, `color-scheme: dark`, focus-visible rings, ≥24px hit targets, aria-live for
  async status, `tabular-nums`, `…` character, `overscroll-behavior: contain`, truncation
  with `min-w-0`.
- Code audit of `devin/1784570000-notch-island` (session d39216c2): removal inventory and
  file-by-file change map reproduced in §6.
