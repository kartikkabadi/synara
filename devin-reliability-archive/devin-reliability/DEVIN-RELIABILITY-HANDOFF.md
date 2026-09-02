# Devin reliability handoff

Updated: 2026-09-01

## Executive summary

The active Devin reliability patch is not ready for delivery yet. It is a seven-file combined proof patch assembled from two protected source worktrees. Five consecutive real Devin SWE 1.7 Max sessions passed through the browser, Synara orchestration WebSocket, server, ACP transport, and Devin tools. Each session kept a real tool active past the ordinary idle budget and completed normally.

The cross-model matrix is still incomplete. The attempted GLM-5.3 Flash Max run did not reach Devin or GLM. It sent Codex GPT-5.5 Medium because the proof harness did not establish the requested composer selection before send. This is a harness selection failure, not a GLM product failure. Do not add a server fallback for it.

Exact objective:

1. Prevent Synara from killing a quiet but active Devin tool call.
2. Keep the ordinary inactive-turn timeout at 30 minutes and the active-tool timeout at one hour by default, with environment overrides.
3. Accept Devin's malformed boolean `block` field only for incoming `get_output` requests, without weakening other validation.
4. Prevent new-project and new-thread UI paths from reporting success before a real draft thread route exists.
5. Prove the combined behavior across Devin model families before any PR or merge decision.

## Current status

- Five consecutive SWE 1.7 Max sessions passed on the combined seven-file proof worktree.
- The final successful streak is under `/tmp/devin-combined-cross-model-proof/swe-1` through `swe-5`.
- All five used real browser UI, continuous orchestration WebSocket capture, a real Devin tool call, and exact terminal completion text.
- The proof used shortened test-only budgets of 10 seconds ordinary idle and 40 seconds active-tool idle. Production defaults remain 30 minutes and one hour.
- The GLM attempt is invalid as a model result. Before send, the UI showed GPT-5.5 Medium. `thread.created` and `thread.turn-start-requested` carried Codex GPT-5.5. The server correctly followed those values. No verified GLM selection reached draft state.
- The combined proof worktree remains proof-only. It is not the source of truth for edits.
- No patch is merge-ready. No PR should be opened yet.

## Protected worktrees and branches

### Provider source

- Path: `/Users/user/.synara/worktrees/devin-tool-idle-budget-clean`
- Branch: `agent/devin-tool-idle-budget-clean`
- Base and current HEAD: `0c5102460c4138d34d595b392e6b52857a0f9807`
- State: five modified tracked files plus a protected untracked `.acceptance/` evidence directory.
- Diff: 762 insertions and 32 deletions across five tracked files.
- The branch reports one commit behind current `upstream/main`. Do not rebase, merge, reset, stash, or update it as part of resuming proof.

### UI source

- Path: `/Users/user/synara-handoff-wt/devin-draft-route-race`
- Branch: `agent/devin-draft-route-race`
- Base and current HEAD: `0c5102460c4138d34d595b392e6b52857a0f9807`
- State: two modified tracked files.
- Diff: 88 insertions and 12 deletions.

### Combined proof

- Path: `/Users/user/.synara/worktrees/devin-combined-live-proof`
- Branch: `agent/devin-combined-live-proof`
- Base and current HEAD: `0c5102460c4138d34d595b392e6b52857a0f9807`
- State: seven modified tracked files.
- Diff: 850 insertions and 44 deletions.
- Purpose: tests and live proof only.

The two source worktrees must remain untouched unless a confirmed fix belongs to that source lane. Never treat the combined worktree as the editing authority. The combined files were hash-checked after assembly.

## Exact seven changed files and current stats

1. `apps/server/src/provider/Layers/DevinAdapter.test.ts`: 270-line test expansion in the current diff family.
2. `apps/server/src/provider/Layers/DevinAdapter.ts`: 82-line production change family.
3. `apps/server/src/provider/acp/AcpSessionRuntime.ts`: 59-line transport integration change family.
4. `apps/server/src/provider/acp/DevinAcpSupport.test.ts`: 354-line support and transport test expansion.
5. `apps/server/src/provider/acp/DevinAcpSupport.ts`: 29-line normalization helper.
6. `apps/web/src/components/ChatView.browser.tsx`: 75-line browser-test expansion.
7. `apps/web/src/components/Sidebar.tsx`: 25-line UI behavior change family.

Exact combined diff stat at handoff:

- 7 files changed.
- 850 insertions.
- 44 deletions.

Combined SHA-256 values checked at handoff:

- `DevinAdapter.ts`: `68b495f7bac961c4cc5797f4e145d22d95a24a3f6dc40540a4b71acfd3a06808`
- `DevinAdapter.test.ts`: `3dcb8ff41fa0a76307c8e7406edf40251042b653ac1ce62d4c8ec65cbe30f6df`
- `AcpSessionRuntime.ts`: `0558de7e224fb677e6ec81b4a667b1af906a8f4a350dcbbd9b525a215bf22f47`
- `DevinAcpSupport.ts`: `62e95c4603cf07be919cb60de86d8ba71d3cdf7a754734b0443b7b7d67f78a97`
- `DevinAcpSupport.test.ts`: `1f2af10e38bfa37e1d960c0e20d59aad9ce3ba04f5d5b2f44bf92ac1728eabe4`
- `Sidebar.tsx`: `6146d8b3081c9a4558be42818cdd9aef2e401fb7a95fee2d759073201e7ce215`
- `ChatView.browser.tsx`: `72b899a903efcac8d06bc6f1a82306a05492d1d690ee4dc3229fce529a60f016`

Record fresh source and combined hashes before and after any future copy. Do not copy blindly.

## Changed behavior

### Devin watchdog and lifecycle

`apps/server/src/provider/Layers/DevinAdapter.ts` and its test now implement:

- A 30-minute default budget while the current turn has no active tool call.
- A separate one-hour default while a current-turn Devin tool call is active.
- Environment overrides for both budgets and the watchdog cadence.
- Dynamic budget selection at each watchdog check.
- A canonical lifecycle map keyed by tool identity instead of duplicate lifecycle sets.
- Current-turn attribution so stale events from an older turn do not refresh the new turn's clock.
- Cleanup when tool lifecycle and turn lifecycle end.
- Deterministic injected time and watchdog dependencies for tests.
- Queue acknowledgments and fake clocks instead of unsafe sleeps and guessed event delivery.
- Coverage for pending and in-progress tools, terminal states, stale activity, turn completion, timeout cleanup, and environment-independent defaults.

### Devin ACP input compatibility

`apps/server/src/provider/acp/AcpSessionRuntime.ts`, `DevinAcpSupport.ts`, and `DevinAcpSupport.test.ts` now implement:

- Incoming JSON normalization only when the runtime provider is Devin.
- A narrow compatibility repair only for `get_output` requests where `block` is boolean.
- Removal of that malformed boolean `block` field before strict ACP decoding.
- Preservation of valid `timeout`, incremental-output controls, and unknown allowed fields.
- Strict rejection of unrelated unknown methods and nonboolean malformed values.
- No normalization for other providers.
- Coverage through the real byte and NDJSON transport path.
- Coverage for one JSON line split across chunks, several lines in one chunk, split multibyte UTF-8, EOF flush behavior, invalid line recovery, ordering, and strict validation.

The boundary is intentional. Repair only the known Devin wire defect. Do not relax the ACP schema globally.

### Draft-route race

`apps/web/src/components/Sidebar.tsx` and `apps/web/src/components/ChatView.browser.tsx` now implement and test:

- Await `handleNewThread` in project creation and project thread paths.
- Report success only when `handleNewThread` returns a real `ThreadId`.
- Keep the previous valid route when navigation is superseded.
- Surface the recoverable message `Project creation was superseded before its chat opened.`
- Verify successful project creation lands on a draft route backed by a composer draft record.
- Verify the composer remains usable after the superseded-navigation error.

The exact browser test file is `apps/web/src/components/ChatView.browser.tsx`.

## Root causes and decisions

### Watchdog killed quiet long tools

The old watchdog used one idle clock and one budget. A real long-running tool could be active without producing provider events. Once the ordinary idle budget elapsed, Synara killed a healthy turn. The fix models active-tool state and selects the longer budget while that state is true.

### Ordinary timeout changed from 10 minutes to 30 minutes

The user explicitly changed the normal production timeout from 10 minutes to 30 minutes. The active-tool production timeout is one hour. Keep both environment-overridable.

### Stale events changed the wrong clock

Events from an older turn could arrive late and refresh activity for a newer turn. Activity now requires current-turn attribution. Stale events do not buy more time for the current turn.

### Unsafe test acknowledgments

Earlier tests used sleeps and assumed queued effects had run. That created hidden races. The current tests use deterministic clock injection and explicit queue acknowledgment.

### Duplicate lifecycle sets

Separate sets for pending and active tools could diverge during replacement, completion, and cleanup. The patch uses one canonical lifecycle map.

### Hidden environment-dependent tests

Inherited timeout environment variables could change expected defaults. The no-environment suite isolates those variables and proves defaults directly.

### Malformed `get_output.block`

Devin can emit a boolean `block` field on `get_output`. Strict ACP decoding rejects it before the tool can complete. The narrow incoming boundary normalizer strips only that boolean field for Devin `get_output`. It does not rewrite unrelated input.

### Vite readiness lesson

A healthy Synara server is not enough. Live proof must wait for Vite and the literal thread route module. The reliable gate fetches `_chat.$threadId.tsx?tsr-split=component`, requires HTTP 200 and JavaScript content, then dynamically imports it in the proof page before creating and sending a thread.

### Ego screenshot and task-space lessons

- Create one fresh Ego task space and reuse its numeric ID.
- Finish it in a separate final call.
- Call `captureScreenshot('/absolute/path.png')` with a string path. Passing an options object caused timeouts.
- Do not assume an old task space exists.
- Preserve normal HOME, XDG, and provider authentication. Isolate only Synara state with `--home-dir`.
- A screenshot is evidence only after its file exists and has valid PNG dimensions.

### Blank draft route race

Project creation could fire new-thread navigation without awaiting it, close the dialog, and return success while route promotion lost a race. This produced a blank or stale draft route. Await the real thread result and treat `null` as a recoverable failure while preserving the last valid route.

### GLM run diagnosis

Two independent investigations agree:

- Before send, the UI showed GPT-5.5 Medium.
- SQLite `thread.created` recorded provider `codex` and model `gpt-5.5`.
- `thread.turn-start-requested` again requested Codex GPT-5.5.
- The server followed the request correctly.
- No durable evidence shows `provider: devin`, model UID `glm-5-3-flash-max`, or Max in draft state.

Therefore the GLM attempt is a proof automation failure. It is not a GLM provider result. Do not add a server fallback. Fix the harness so it proves semantic selection before send.

## Verification ledger

Counts changed as tests were added. Commands and pass status are more important than comparing stale totals from different revisions.

### Reviews

- The last full Thermos provider review covered the then-current seven-file patch and reported 170 passing tests.
- That review happened before the latest transport-level extension.
- A later independent transport-focused review was started after the byte and NDJSON tests were added. Re-run both Thermos reviews after the live matrix because the user requires a final independent review on the final head.

### Focused provider verification

Completed reports record:

- Latest transport support suite: 78 passing tests.
- No-environment watchdog suite: 41 passing tests.
- Changed-test group: 91 passing tests.
- Support group: 50 passing tests.
- Current combined provider selection across five files: 126 passing tests.

These totals overlap. Do not sum them. They represent different focused commands at different patch points.

### UI verification

- Browser tests: 90 passed and 12 skipped.
- The skips were existing or environment-gated browser cases, not reported failures in the changed draft-route cases.

### Workspace and static checks

Completed reports state:

- `bun fmt` passed.
- `bun lint` passed.
- `bun typecheck` passed.
- Final diff-name and diff-stat checks passed.
- IDE diagnostics for the changed files were clear.
- Secret scan found no credential material in the seven-file diff.

Do not rerun heavyweight checks during every live session. Run one final bundled pass after the matrix and final fixes. Repository rules require explicit user authority before running `bun fmt`, `bun lint`, or `bun typecheck`; the prior pass is evidence, not standing permission for a future pass.

### Live SWE 1.7 Max proof

Five consecutive sessions passed in `/tmp/devin-combined-cross-model-proof`.

Each session proved:

- Visible SWE 1.7 and Max state.
- A real Devin thread through the real browser and orchestration WebSocket.
- One bounded long-running shell tool.
- Tool activity remained alive beyond the 10-second ordinary test budget.
- No watchdog timeout during the active tool.
- Exact completion phrase `SWE SESSION N COMPLETE`.
- Terminal idle state after completion.
- Before-send, active-past-normal-timeout, and completed screenshots.

Any future product code change invalidates this streak and resets it to zero on the new head.

## Live evidence paths

### Combined cross-model proof

Root: `/tmp/devin-combined-cross-model-proof`

SWE session evidence directories:

- `/tmp/devin-combined-cross-model-proof/swe-1`
- `/tmp/devin-combined-cross-model-proof/swe-2`
- `/tmp/devin-combined-cross-model-proof/swe-3`
- `/tmp/devin-combined-cross-model-proof/swe-4`
- `/tmp/devin-combined-cross-model-proof/swe-5`

Each contains:

- `01-before-send.png`
- `02-active-past-normal-timeout.png`
- `03-completed.png`
- `browser-events.json`
- `ui-samples.json`
- `final-snapshot.txt`

Session 1 also has `browser-events-continuation.json`. Session 5 also has `ui-samples-tail.json`.

All 15 SWE PNGs were revalidated at handoff as 1908 by 963, 8-bit RGB, non-interlaced PNG images.

Invalid GLM-attempt evidence is under:

- `/tmp/devin-combined-cross-model-proof/glm-1/01-before-send.png`
- `/tmp/devin-combined-cross-model-proof/glm-1/03-state.png`
- `/tmp/devin-combined-cross-model-proof/glm-1/final-snapshot.txt`
- `/tmp/devin-combined-cross-model-proof/glm-1/failure-followup.json`
- `/tmp/devin-combined-cross-model-proof/glm-1/ui-samples.json`
- `/tmp/devin-combined-cross-model-proof/glm-1/browser-events.json`

Keep it as harness-failure evidence. Do not count it in the model matrix.

### Fixed get_output calibration

Root: `/tmp/devin-get-output-calibration-fixed`

Important files:

- `result.json`
- `provider-runtime-events.json`
- `orchestration-events.json`
- `browser-events.json`
- `ui-samples.json`
- `final-snapshot.txt`
- `server.log`

`result.json` records PASS, Devin `swe-1-7`, terminal completion, exact phrase `CALIBRATION COMPLETE`, 55 raw provider events, 93 continuous WebSocket frames, and zero failed tool rows. It also records screenshot names from its companion fixed calibration evidence as `03-before-send.png`, `04-active-past-normal-timeout.png`, and `05-completed.png`.

### Earlier Ego pass

Root: `/tmp/devin-tool-idle-ego-final-pass`

Important files:

- `session-1/browser-events.json`
- `session-1/orchestration-events.json`
- `session-1/ui-samples.json`
- `session-1/final-snapshot.txt`
- `task-space.json`
- `state/dev/logs/server.log`

This run is useful for harness history. The final authoritative five-session streak is the combined proof root above.

### Route and readiness diagnosis

Primary root: `/tmp/devin-route-module-diagnosis`

Important files:

- `previous-run-summary.json`
- `previous-run-dry-run.log`
- `previous-run-runtime.log`
- `runtime.log`
- `readiness-headers.txt`
- `main-headers.txt`
- `bootstrap-headers.txt`
- `root-headers.txt`
- `module-headers.txt`
- `state/dev/logs/server.log`

Additional route-race evidence may exist in the prior Ego evidence roots. Preserve all `/tmp/devin-*` evidence. Do not clean or reuse those directories.

## Remaining work in exact order

### 1. Fix the proof harness selection gate

Before send, assert all of these from live state:

1. The picker is closed and the visible composer label is stable.
2. Draft state provider is exactly `devin`.
3. Draft state model UID is exactly the requested UID.
4. Draft options are exactly Max for the Max runs.
5. The route is a live draft route for the intended project.

Abort the harness if any assertion fails. Do not send. Do not count an aborted harness attempt as a product failure. Capture the visible picker state and live draft state in the evidence record.

Do not make a product fix unless semantic selection is verified before send and the dispatched thread still differs.

### 2. Run GLM-5.3 Flash Max

Run two fresh sessions:

- Quiet long tool with no periodic output.
- Long tool with periodic output.

Use the same active-past-normal-timeout proof shape. Require browser, WebSocket, provider, model UID, options, tool lifecycle, terminal phrase, and idle completion evidence.

### 3. Run GPT-5.4 Mini efforts

Run quiet long-tool sessions for each confirmed available effort:

- Low.
- Medium.
- High.
- XHigh.

Do not infer effort names from screenshots. Read the live model option contract and assert exact state.

Run GPT-5.6 Sol only if historical evidence confirms that exact Devin family and model UID. GPT-5.4 Mini and GPT-5.6 Sol are separate families. Do not guess which model an old screenshot used.

### 4. Add pause integration proof if deterministic

Test approval and user-input pauses only if a deterministic local path exists. Prove that an intentional pause does not look like dead idle work, and that lifecycle resumes or terminates cleanly. Do not add flaky live requirements merely to check a box.

### 5. Keep broader resilience items separate

Consider separate follow-ups, not this patch, for:

- A pre-turn startup deadline.
- Event-consumer death detection.
- Child-process exit teardown.
- Reconnect and projection convergence.

Do not expand the current patch unless the model matrix reveals a direct regression caused by one of these paths.

### 6. Final review and checks

After the live matrix:

1. Run both independent Thermos reviews on the exact final seven-file diff.
2. Fix real findings in the correct source worktree.
3. Rebuild the combined proof worktree by verified copying and record hashes.
4. Reset and rerun every affected live acceptance streak after a product change.
5. Run the focused tests.
6. With current explicit user permission, run the final bundled `bun fmt`, `bun lint`, and `bun typecheck` pass. If permission is not present in the resumed conversation, ask once before these heavyweight checks.
7. Recheck diff names, stats, IDE diagnostics, and secrets.
8. Decide delivery shape with the user. Do not merge.

The user's earlier rule still applies. No PR until the required live work is 100 percent successful on the reviewed head.

## Acceptance criteria and reset rules

The program is accepted only when all of these are true:

- Production defaults are 30 minutes ordinary idle and one hour active-tool idle.
- Both budgets remain environment-overridable.
- A current-turn pending or in-progress tool selects the active-tool budget.
- Terminal tool states and turn completion clear lifecycle state.
- Old-turn events do not refresh the current-turn clock.
- No active tool can hold the longer budget after it is terminal.
- Devin boolean `get_output.block` is normalized before strict decode.
- Valid timeout, incremental, and unknown allowed fields survive unchanged.
- Unrelated unknown methods and nonboolean malformed fields remain rejected.
- Other providers do not receive Devin normalization.
- Fragmented, batched, multibyte, EOF, invalid-line recovery, and ordering transport tests pass.
- Project and project-thread creation await a real `ThreadId`.
- Superseded navigation preserves a valid route and shows a recoverable error.
- Five consecutive SWE 1.7 Max live sessions pass on the exact final combined head.
- GLM-5.3 Flash Max quiet and periodic-output sessions pass after verified semantic selection.
- GPT-5.4 Mini quiet sessions pass at each confirmed available effort.
- GPT-5.6 Sol is included only when its exact identity is confirmed.
- Browser screenshots, WebSocket events, server/provider identity, exact final phrase, and idle terminal state agree for each counted session.
- Both final Thermos reviews pass or all real findings are fixed.
- Focused tests and final workspace checks pass on the exact final source state.
- Diff scope remains the intended seven files unless a separately justified source fix is required.
- No secrets appear in diff or evidence summaries.
- The user approves the delivery shape.

Reset rules:

- Any true product failure resets the affected consecutive streak to zero after root-cause repair.
- Any production or test-harness code change that can affect the proof resets the affected streak.
- A browser, Vite, task-space, screenshot API, or picker-selection harness failure does not count as a provider failure. Diagnose it, fix the harness, and rerun without recording a model result.
- If outcomes vary, extend the affected streak from five to ten consecutive sessions.
- After final reviews and fixes, rerun the full required streak on the reviewed head.
- Never preserve a streak across changed file hashes.

## Safe next-agent instructions

- Read this file in full before any action.
- Continue live tests in `/Users/user/.synara/worktrees/devin-combined-live-proof` only.
- Make provider fixes only in `/Users/user/.synara/worktrees/devin-tool-idle-budget-clean`.
- Make UI fixes only in `/Users/user/synara-handoff-wt/devin-draft-route-race`.
- Never edit a source worktree merely to make the combined proof convenient.
- Never copy a combined file back into a source worktree.
- Before copying source files into the combined proof worktree, record source and destination SHA-256 values. Copy only the exact owned files. Recheck all seven hashes afterward.
- Do not clean, reset, stash, rebase, merge, delete, or repurpose any worktree.
- Preserve every `.acceptance/` directory and every `/tmp/devin-*` evidence root.
- Do not touch `/Users/user/synara`. Another program treats it as read-only.
- Do not touch the remaining-plans agent's worktrees, branches, evidence, or `/tmp/REMAINING-PLANS-HANDOFF.md`.
- Do not kill processes you did not start.
- Use unique isolated ports and a unique Synara `--home-dir` for each runtime.
- Preserve normal provider auth without printing or copying secret values into reports.
- Wait for both Synara and Vite route-module readiness.
- Use one fresh Ego task space. Store its numeric ID. Close only that task space in a dedicated final action.
- Verify provider, exact model UID, and options from live draft state before send.
- Abort on selection mismatch. Do not let a wrong-provider send become a fake model failure.
- Do not commit, push, open a PR, merge, deploy, or change external state without fresh explicit user authority.

## Copy-paste next-agent prompt

```text
Resume the active Synara Devin reliability program from `/tmp/DEVIN-RELIABILITY-HANDOFF.md`. Read it fully before any action.

Hard boundaries:
- Do not touch `/Users/user/synara` or the remaining-plans agent's work.
- Do not clean, reset, stash, rebase, merge, delete, or repurpose any existing worktree.
- Preserve all `.acceptance/` directories and `/tmp/devin-*` evidence.
- Do not commit, push, open a PR, merge, deploy, or change external state without fresh explicit user authority.
- Do not print secrets.

Source ownership:
- Provider source: `/Users/user/.synara/worktrees/devin-tool-idle-budget-clean`, branch `agent/devin-tool-idle-budget-clean`.
- UI source: `/Users/user/synara-handoff-wt/devin-draft-route-race`, branch `agent/devin-draft-route-race`.
- Combined proof only: `/Users/user/.synara/worktrees/devin-combined-live-proof`, branch `agent/devin-combined-live-proof`.
- All three are based at `0c5102460c4138d34d595b392e6b52857a0f9807` and currently carry uncommitted work. Never edit a source lane from the combined lane or copy combined files back.

Start with a read-only freshness and hash check of the exact seven files. Then repair only the proof harness selection gate. Before send, require a closed stable picker plus live draft state with provider `devin`, the exact requested model UID, and exact options. Abort the harness if any value differs. Do not add a server fallback.

After the harness gate is proven, run GLM-5.3 Flash Max twice through the real browser and orchestration WebSocket: one quiet long tool and one periodic-output long tool. Then run GPT-5.4 Mini quiet sessions at each confirmed available effort: Low, Medium, High, and XHigh. Run GPT-5.6 Sol only if historical or live contract evidence confirms the exact family and UID. Do not guess from screenshots.

Count a session only when visible UI, live draft state, thread creation, turn start, provider events, WebSocket evidence, tool lifecycle, exact terminal phrase, and idle completion all agree. Any true product failure resets the affected streak after a root-cause fix. Harness failures do not count as provider failures. Any relevant code or hash change resets affected proof.

After the model matrix, add approval and user-input pause integration proof only if deterministic. Keep pre-turn startup deadline, event-consumer death, child-exit teardown, and reconnect/projection convergence as separate follow-ups unless a direct current-patch defect requires them.

Finally run both independent Thermos reviews on the exact final diff, fix real findings in the correct source lane, rebuild combined proof with recorded hashes, rerun affected live proof, run focused tests, and run one final bundled fmt/lint/typecheck pass only with current explicit user permission. Recheck diff names, stats, IDE diagnostics, and secrets. Do not merge. Do not open a PR until the user-defined 100 percent live gate passes on the reviewed head.
```

## Open questions and risks

- The exact live model UID and option encoding for every GPT-5.4 Mini effort must be read from current discovery state. Do not assume naming.
- GPT-5.6 Sol may or may not be a Devin model available in this environment. Historical evidence must settle inclusion.
- Approval and user-input pauses may not have a deterministic local trigger. If not, report them as unverified rather than adding brittle automation.
- The source branch is behind current upstream main. Delivery will need an explicit integration plan after proof. Do not rebase during the reliability matrix.
- The final seven-file delivery shape may be one patch or separate provider and UI patches. The user must decide after proof and review.
- The combined proof lane can drift from either source lane. Hash checks are mandatory before trusting it.
- Cross-model behavior should be model-independent in code, but each model can emit different tool lifecycle timing and malformed wire details. That is why live matrix evidence still matters.
- A quiet tool can exceed the ordinary budget with no output. Periodic output can mask lifecycle errors. Both GLM shapes are required.
- Broad startup, process-death, and reconnect resilience remain real risks, but adding them here would hide the bounded watchdog and compatibility fix inside a larger patch.
- Evidence directories can contain large runtime state. Preserve them, but do not quote logs without screening for secrets.

## Principles and technical decisions

### Fix root causes

The watchdog fix models the real cause, an active tool with quiet output. It does not merely increase one global timeout. The GLM diagnosis also stops at the actual cause, failed harness selection, instead of blaming the provider or adding a fallback.

### Prove the real path

A passing unit test is not enough. Count live proof only when browser state, draft state, orchestration events, provider events, tool lifecycle, and final UI all agree. Screenshots alone do not prove model identity.

### Keep boundaries strict

Repair malformed Devin input at the Devin transport boundary. Do not weaken ACP validation for every provider. Keep provider and UI source ownership separate from the combined proof lane.

### Model lifecycle once

Use one canonical map for tool lifecycle. Avoid duplicate pending and active sets that can disagree.

### Preserve valid state

A superseded draft navigation should not destroy a valid route. Keep the last valid route and show a recoverable error.

### Sequence work into verifiable units

First prove selection. Then GLM quiet and periodic output. Then GPT-5.4 Mini efforts. Then optional pauses. Then final review and workspace checks. A later step must not hide a failed earlier prerequisite.

### Keep the patch bounded

Startup deadlines, event-consumer death, child-exit teardown, and reconnect convergence deserve separate follow-ups. They do not enter this patch unless direct evidence proves they are required for its correctness.

## Final warning

Do not state that GLM failed. GLM was never selected in the counted attempt. Do not state that this patch is merge-ready. Five SWE sessions passed, but the cross-model matrix, final review on the latest transport extension, final reviewed-head rerun, and delivery decision remain open.
