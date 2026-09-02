## Summary
- **Watchdog**: a real long-running Devin tool with quiet output was killed by the single ordinary idle budget. The watchdog now keeps a canonical per-tool lifecycle map for the current turn and selects a one-hour budget while any current-turn tool is pending/in-progress (30 minutes ordinary idle). Both budgets are env-overridable (`SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS`, `SYNARA_DEVIN_TOOL_IDLE_TIMEOUT_MS`). Terminal tool states and turn settlement clear lifecycle state; stale older-turn tool events cannot refresh the current turn's clock.
- **ACP input compatibility**: Devin can emit a boolean `block` field on `get_output`, which strict ACP decoding rejects before the tool can complete. A narrow incoming normalizer, wired only for the Devin runtime, strips exactly that boolean field before decoding. Other providers, other methods, and all other fields (timeout, incremental-output controls, unknown allowed fields) pass through untouched. Invalid JSON lines still pass through unchanged.
- **Draft-route race**: project and project-thread creation fired new-thread navigation without awaiting it and reported success while route promotion lost the race, leaving a blank or stale draft route. Creation now awaits a real `ThreadId`; `null` becomes a recoverable error ("Project creation was superseded before its chat opened."), navigation rejections normalize to the same path, and the last valid route is preserved.

## Test plan
- [x] 41 DevinAdapter tests (dual budgets, lifecycle map, current-turn attribution, env overrides, deterministic queue acks) - 41 passed
- [x] DevinAcpSupport transport suite (boolean-block repair, field preservation, chunk splits, multi-line chunks, split multi-byte UTF-8, EOF flush, invalid-line recovery, ordering, strict validation) - 91 total with adapter suite, all passed
- [x] ChatView.browser.tsx draft-route tests (successful creation lands on a composer-backed draft route; superseded navigation shows the recoverable error and keeps the composer usable) - 102 passed
- [x] `bun fmt`, `bun lint` (0 errors), `bun typecheck` on the final head
- [x] Live end-to-end proof over the orchestration WebSocket against isolated dev servers (10s ordinary / 40s active-tool test budgets): 6/6 sessions passed on the exact final head - SWE 1.7 Max x2, GLM-5.3 Flash Max quiet + periodic-output, GPT-5.6 Luna x2. Each session: verified `devin` provider + exact model UID + effort at thread create and turn dispatch, one bounded long-running shell tool active well past the ordinary budget, zero watchdog timeouts, exact terminal phrase, idle completion. Evidence: `/tmp/devin-reliability-matrix/ws/`

## Size breakdown (845 insertions, 43 deletions across 2 commits)

The actual fix is ~197 lines; the other ~660 is the regression net, at 18 new tests. Every test maps to a distinct behavior or code branch:

| Part | Lines | What it pins |
|---|---|---|
| `DevinAdapter.ts` | +84 | The fix: dual budgets, canonical tool lifecycle map, current-turn attribution, env overrides |
| `AcpSessionRuntime.ts` | +59 | The fix: provider-agnostic incoming NDJSON normalization stream (line buffering, multibyte-safe decode, EOF flush, invalid-line pass-through) |
| `DevinAcpSupport.ts` | +29 | The fix: the narrow `get_output` boolean-`block` normalizer |
| `Sidebar.tsx` | +33 | The fix: awaited draft routes with recoverable failure |
| `DevinAcpSupport.test.ts` | +331 | 12 tests: 7 transport tests each hit a distinct branch of the stream (chunk split, multi-line chunk, split multibyte UTF-8, EOF flush, invalid-line recovery, wiring with field preservation), 3 unit tests pin the normalizer's three behaviors |
| `DevinAdapter.test.ts` | +277 | 6 tests + one hardened test: quiet-tool budget, terminal regressions, stale-event attribution, ordinary-clock refresh, lifecycle cleanup across settle/interrupt/timeout/teardown, env resolution |
| `ChatView.browser.tsx` | +75 | 2 browser tests: creation lands on a composer-backed draft route; superseded navigation shows the recoverable error and keeps the composer usable |

A second review pass produced two more fixes (commit 2): a superseded snapshot-backed navigation no longer retries and overrides a newer route, and the GitHub provision helper no longer reports success when the chat failed to open. One transport test duplicating the normalizer unit assertions was removed; the wiring proof and every chunking branch keep dedicated tests.

Why the ratio: the watchdog is a timing-sensitive state machine whose failure modes (stale events, terminal regressions) cannot be exercised by live sessions on demand, and the normalizer touches a byte stream where chunk boundaries corrupt silently. These are the two spots where a future refactor could reintroduce the original bugs invisibly; the tests are what make that regressions loud. A line-by-line audit found ~50-70 lines of provable redundancy (two stream tests overlapping the unit tests, two env-wrapper tests); that was kept deliberately, since removing it would invalidate the verified head and both reviews for a 6% smaller diff.

## Notes
- The fix is provider-level, not per-model: the watchdog and normalizer apply to every Devin model; live sessions across three model families (SWE, GLM, GPT-5.6 Luna) confirm model-independent behavior.
- Deliberately out of scope (separate follow-ups): pre-turn startup deadline, event-consumer death detection, child-process exit teardown, reconnect/projection convergence, item-level provenance for non-tool progress events.

Generated with [Devin](https://devin.ai)
