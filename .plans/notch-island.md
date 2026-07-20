# Notch / Dynamic Island Overlay — Design

Status: design approved for implementation, no code written yet.
Scope: a small, focused, cross-platform "island" overlay window that surfaces
agent-session status (working / needs-approval / done) at the top-center of the
screen — flush with the macOS notch when present, a floating pill elsewhere.
Deliberately NOT PR #4: no dotmatrix loaders, no voice dictation, no in-app
renderer overlay.

## 1. Branch base decision

**Branch from `main`.** PR #4 (`feat/v0.4.0-island-dotmatrix-voice`) is 87
commits behind `main` and bundles ~5,766 insertions across 35 files including
unrelated features (dotmatrix loaders, whisper voice dictation). Its "island"
is a `position:fixed` overlay inside the main window's renderer — a different
architecture from a true always-on-top OS-level overlay window. We reuse its
*concepts* (thread status classification, pop-on-event behavior) but not its
branch. Building on main avoids inheriting the XXL diff, avoids rebase churn,
and keeps each PR mergeable independently of PR #4's fate. If PR #4 later
merges, its renderer island can be retired in favor of this window or coexist
behind settings.

## 2. Feature scope

- **P0 (this feature)**
  - Second frameless/transparent always-on-top BrowserWindow ("island window").
  - Collapsed pill: N active sessions + aggregate status glyph
    (working / needs-approval / done).
  - Hover preview: slight widen, per-session status glyphs; no focus steal.
  - Click / global shortcut → expanded panel: session rows (thread title,
    provider chip, status, last activity line) + click-to-jump: focuses the
    main window on that thread.
  - Auto-pop briefly (~4s) on `needs-approval` and `turn-completed` events.
  - Settings toggle (default ON macOS/Windows, default OFF Linux).
- **P1 (later, separate PRs)**: inline approve/deny quick actions from the
  island; quick-launch (folder × agent) grid.
- **P2 (not planned now)**: media controls, OS notification routing, file
  shelf. Media needs private APIs on macOS — out of scope permanently unless
  revisited.

## 3. UI/UX states & animations

State machine (renderer-owned):

```
collapsed --mouseenter--> hoverPreview --click/shortcut--> expanded
expanded --outside-click / Esc / shortcut / 8s idle--> collapsed
any --event(needs-approval|turn-done)--> popped (auto-expand hover-size, 4s) --> collapsed
```

- Window is pre-sized to the **max expanded bounds** (≈ 560×320 logical px,
  top-center). Expansion/collapse is pure CSS on an inner container — never
  animate `setBounds()`.
- Geometry (from GhostNotch measurements, adapted):
  - collapsed: `notchWidth + 60` × `notchHeight` (macOS notch mode);
    180×32 floating pill elsewhere. Top edge flush with screen top in notch
    mode; only bottom corners rounded (14px) so it reads as a camera-housing
    extension. Floating mode: fully rounded pill, 6px below workArea top.
  - hover: `max(notchWidth + 200, 420)` × 104. expanded: 560×320.
  - Status glyphs live in the side extensions, never behind the hardware notch.
- **No focus steal**: window created `focusable:false`; buttons still receive
  clicks. Island stays button-only (no text input) so it never needs focus.
- **Click-through**: `win.setIgnoreMouseEvents(true, { forward: true })` at
  rest; renderer toggles it off on `mouseenter` of the pill element and back on
  at `mouseleave` via IPC. (`forward` is macOS/Windows only — see §5 Linux.)
- Animations: CSS transitions / WAAPI with spring-like cubic-bezier, reusing
  the repo's `disclosureMotion` conventions. Zero new dependencies (no
  framer-motion). `backgroundThrottling:false` on the island webContents.
- Global shortcut: `CommandOrControl+Shift+I` via Electron `globalShortcut`,
  registered only while the feature is enabled; toggles expanded state (and
  shows the window if hidden).
- Idle economy: `win.hide()` after 5 min with zero active sessions; re-shown
  on next orchestration event.

## 4. Technical architecture

```
apps/server (orchestration events over WS)
        │  (existing backend WebSocket)
        ▼
apps/web /island route  ── renders island UI, owns state machine
        ▲  desktopBridge.island.* (preload IPC)
        │
apps/desktop main: island/islandWindow.ts creates the window,
  positions it (islandGeometry.ts), toggles click-through,
  registers global shortcut, forwards focus-thread requests
  to the main window.
```

- **Window creation** (`apps/desktop/src/island/islandWindow.ts`):
  `frame:false, transparent:true, hasShadow:false, resizable:false,
  movable:false, minimizable:false, maximizable:false, closable:false,
  focusable:false, alwaysOnTop:true, skipTaskbar:true, roundedCorners:false,
  show:false`, `webPreferences: { preload: islandPreload, contextIsolation,
  sandbox:true, backgroundThrottling:false }`. Then
  `setAlwaysOnTop(true, "screen-saver")` and
  `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true,
  skipTransformProcessType:true })`.
- **Renderer**: new lightweight route `/island` in apps/web (loaded via the
  existing desktop static protocol, same Vite bundle). It opens its own
  WebSocket to the backend using the existing `desktop:get-ws-url` bridge —
  no new main-process orchestration plumbing. A small
  `islandSessionTracker.ts` derives per-thread status
  (working / needs-approval / done) from thread/turn events (same
  classification rules PR #4 proved out, re-implemented minimally on main).
- **State flow**: server WS events → tracker → React state machine →
  CSS-animated island. Jump-to-thread: island → IPC → main process focuses
  `mainWindow` and forwards a `menuAction`-style navigation event the main
  renderer already knows how to route.
- **Contracts**: island bridge types added to `packages/contracts/src/ipc.ts`
  (schema-only, matching existing DesktopBridge style).
- **Feature flag**: `islandEnabled` boolean in desktop settings
  (default `process.platform !== "linux"`), read at startup and togglable at
  runtime (create/destroy window on change).

## 5. Cross-platform strategy

- **macOS notch detection (heuristic, no native code, no private APIs)**:
  on the built-in display, `display.workArea.y - display.bounds.y >= 30`
  strongly implies a notch (notched menu bar ≈ 37–38pt vs 24–25pt); treat that
  inset as notch height. Optional later upgrade: `node-mac-notch`
  (`NSScreen.safeAreaInsets`, public API) as an `optionalDependency` behind
  `try/require`, mirroring the AppSnap helper packaging pattern
  (asarUnpack + x64ArchFiles). NOT in the first PRs.
- **Non-notch macOS / Windows / Linux**: floating top-center pill anchored to
  `screen.getPrimaryDisplay().workArea` (excludes taskbar/panels). Re-anchor on
  `screen` `display-metrics-changed` / `display-added` / `display-removed`.
- **Windows**: transparent+frameless is supported; `focusable:false` implies
  skipTaskbar. Fullscreen-exclusive apps will cover the overlay — acceptable.
- **Linux**: default OFF. X11 with a compositor works best-effort;
  `setIgnoreMouseEvents(..., { forward:true })` is unsupported, so on Linux the
  island skips click-through entirely (window only spans the pill's collapsed
  bounds and resizes via `setBounds` between states — the one platform where
  we accept bounds changes, without animation). Wayland: `alwaysOnTop`
  unsupported → feature remains available but degraded; settings copy notes
  this.
- **macOS fullscreen**: `screen-saver` level + `visibleOnFullScreen:true`
  keeps the island above fullscreen spaces (Electron cannot match
  boring.notch's private SkyLight window; accepted limitation).
- Multi-monitor: island lives on the primary display only (P0).

## 6. File-by-file change list

New files:
- `apps/desktop/src/island/islandWindow.ts` — create/destroy/show/hide window,
  always-on-top + workspace flags, click-through toggling, shortcut register.
- `apps/desktop/src/island/islandGeometry.ts` — pure functions: notch
  heuristic, anchor/bounds math per platform. (+ `islandGeometry.test.ts`)
- `apps/desktop/src/island/islandIpc.ts` — ipcMain handlers for island
  channels; focus-thread forwarding. (+ `islandIpc.test.ts`)
- `apps/desktop/src/islandPreload.ts` — minimal contextBridge for the island
  window (`islandBridge`).
- `apps/web/src/routes/island.tsx` — route entry (bare layout, no chrome).
- `apps/web/src/components/island/Island.tsx` — pill/panel component + state
  machine.
- `apps/web/src/lib/islandSessionTracker.ts` — thread/turn → status
  classification. (+ `islandSessionTracker.test.ts`)

Modified files:
- `apps/desktop/src/main.ts` — instantiate island on app ready when enabled;
  teardown on quit.
- `apps/desktop/src/ipcChannels.ts` — add `island` namespace (below).
- `apps/desktop/src/preload.ts` — expose `desktopBridge.island.focusThread`
  hook only if needed for main-window side (likely none; island uses its own
  preload).
- `packages/contracts/src/ipc.ts` — `IslandBridge` type + island state types.
- `packages/contracts/src/settings.ts` — `islandEnabled` setting.
- Settings UI file in `apps/web` (existing desktop settings section) — toggle.
- `apps/desktop/package.json` — build entry for `islandPreload.ts` (tsdown).

No packaging changes: no new entitlements, no Info.plist changes, no native
deps in P0.

## 7. IPC additions (`DESKTOP_IPC_CHANNELS.island`)

```ts
island: {
  setIgnoreMouse: "desktop:island-set-ignore-mouse", // invoke, { ignore: boolean }
  setState:       "desktop:island-set-state",        // invoke, { state: "collapsed"|"hover"|"expanded" } (Linux bounds resize; no-op elsewhere)
  focusThread:    "desktop:island-focus-thread",     // invoke, { threadId: string } → focuses main window + navigates
  getContext:     "desktop:island-get-context",      // invoke → { platform, notch: { present, height, width } | null, wsUrl }
  setEnabled:     "desktop:island-set-enabled",      // invoke from main window settings, { enabled: boolean }
  stateChanged:   "desktop:island-state-changed",    // main → island (shortcut toggles, enable/disable)
}
```

Contracts (`packages/contracts/src/ipc.ts`): `IslandDisplayContext`,
`IslandWindowState`, `IslandBridge` interface — schema-only, no runtime deps,
matching existing `DesktopBridge` conventions.

## 8. Build / verification commands

One final pass per PR (per AGENTS.md — bundled, not repeated during iteration):

- `bun install`
- `bun fmt` && `bun lint` && `bun typecheck`
- `bun run test` (NEVER `bun test`)
- `bun run build:desktop`
- Platform artifacts when validating packaging: `bun run dist:desktop:mac`,
  `dist:desktop:win`, `dist:desktop:linux` (mac must run on a darwin host).

## 9. Testing plan

Unit (all platforms, in CI): `islandGeometry.test.ts` (notch heuristic
matrix: notched/non-notched insets, workArea anchoring, display changes),
`islandSessionTracker.test.ts` (event → status classification),
`islandIpc.test.ts` (channel contract, focus-thread forwarding).

Manual/agent validation per platform (each by a dedicated sub-agent where
hardware allows):
- **macOS (notched hardware ideally; else non-notched)**: pill flush with
  notch; hover expand without focus steal (type in another app while
  hovering); click-through at rest; global shortcut; fullscreen-space
  visibility; jump-to-thread focuses main window; approval event pops island.
- **Windows**: floating pill above taskbar-excluded workArea; transparency;
  click-through toggle; DPI change / monitor unplug re-anchoring.
- **Linux (X11 + compositor)**: feature OFF by default; enable via settings →
  pill renders, state changes via setBounds, no click-through; Wayland smoke
  test documents degradation.

## 10. PR strategy (small, granular)

Branch prefix `feat/island-*`, all into `main`, in order:

1. **PR A — `feat/island-contracts-and-flag`**: contracts types, `island` IPC
   channel names, `islandEnabled` setting + settings toggle UI. Tiny,
   zero-behavior. Commits: contracts; channels; setting+UI.
2. **PR B — `feat/island-window-shell`**: `islandGeometry.ts` (+tests),
   `islandWindow.ts`, `islandPreload.ts`, `islandIpc.ts` (+tests), main.ts
   wiring behind the flag, loading a placeholder `/island` route. Commits:
   geometry+tests; window; preload+ipc+tests; main wiring.
3. **PR C — `feat/island-renderer`**: `/island` route, `Island.tsx` state
   machine + CSS animations, `islandSessionTracker.ts` (+tests) wired to the
   backend WS, jump-to-thread. Commits: tracker+tests; component; wiring.

Each PR title `feat(island): …`, body per repo template, and each passes the
§8 verification pass independently. This doc lands first as a docs-only PR
(or is folded into PR A) — branch `devin/<ts>-notch-island-design`.

## 11. Licensing & constraints

- References: GhostNotch (MIT), electron-dynamic-island (MIT),
  Taxperia/windows-notch-overlay — reference only, no code copied.
- **Never** copy from boring.notch or eIsland (GPL-3.0).
- No private macOS APIs (no SkyLight); heuristic notch detection only in P0.
- Default off on Linux; feature-flagged everywhere.
