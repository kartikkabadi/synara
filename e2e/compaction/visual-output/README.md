# Compaction UI visual output

Media captured from the real `ChatView` (sidebar + chat header + timeline + composer)
rendered against a mocked WebSocket snapshot with context-window usage, a
`ThreadCompactionRuntimeStatus`, and a completed `context-compaction` work-log entry.

Regenerate with:

```bash
cd apps/web
bunx vitest --config vitest.browser.config.ts run src/components/chat/ContextCompaction.fullapp.browser.tsx
```

Then rebuild the walkthrough video from the captured frames:

```bash
cd e2e/compaction/visual-output/full-app
ffmpeg -y -framerate 0.5 -i frames/frame-%02d.png \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=2" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart compaction-walkthrough.mp4
```

## full-app/

- `01-full-app-timeline-compaction.png` — full app with sidebar, chat header,
  composer (context-window meter in footer), and the "Context compacted"
  timeline entry.
- `02-meter-popover.png` — context-window meter popover open: usage (76% ·
  152k/200k), model window, total processed tokens, and the Synara auto-compaction
  status line ("Auto-compacts at 85%").
- `03-meter-popover-settings.png` — Compaction settings disclosure expanded
  inside the popover (enable toggle + threshold input).
- `04-composer-compact-slash.png` — composer with `/compact` typed and the
  Compact Context slash-command suggestion shown.
- `compaction-walkthrough.mp4` — 8s walkthrough (2 fps) through the four states
  above.
- `frames/` — source frames for the video.
