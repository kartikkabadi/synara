# Antigravity Synthetic Compaction — Design Proposal

Status: **proposed, not implemented**. `AntigravityAdapter` keeps
`compaction.manual.mode: "unsupported"` (guarded by a test in
`AntigravityAdapter.test.ts`) until this design is approved.

## Why native compaction is impossible

Verified against the installed `agy` CLI (Antigravity CLI, Linux flat build):

- `agy --print` runs a single prompt non-interactively and exits; Synara's
  `AntigravityAdapter` drives exactly this one-shot print mode per turn.
- There is no long-lived session process, no stdio RPC surface, and no ACP
  mode. Conversation continuity comes only from `--continue` /
  `--conversation <id>`, which replays provider-side conversation state.
- `agy --help` exposes no compaction, summarize, or compress command, and the
  binary carries no user-facing compaction surface.

With no session to compact and no primitive to invoke, any `compactThread`
implementation would have to fake the operation. Synara's compaction
descriptors are truth-claims, so faking is not acceptable.

## Proposed synthetic compaction (Synara-side)

Because Synara owns the full transcript for Antigravity threads, compaction
can be synthesized without provider support:

1. **Summarize the Synara-side transcript.** On `compactThread`, run a
   summarization prompt over the thread's accumulated turns (user prompts +
   assistant output). The summarizer can itself be a one-shot `agy --print`
   call with a fixed summarization instruction, so no second provider is
   needed.
2. **Persist the summary.** Store the summary as a thread-scoped compaction
   record (SQLite, alongside existing thread state), including the turn index
   it covers, so repeated compactions extend rather than re-summarize.
3. **Seed the next one-shot prompt.** After compaction, stop passing
   `--conversation <id>` for the rolled-over context. Instead, start a fresh
   conversation whose first prompt is prefixed with the persisted summary
   ("Context from earlier in this thread: …"), i.e. session-rollover
   semantics with `mechanism` best described as a Synara-side control command.
4. **Descriptor once implemented:** `manual.mode: "session-rollover"`,
   `manual.supportsInstructions: true` (instructions appended to the
   summarization prompt), `automatic.mode: "none"`, telemetry
   `lifecycle: "inferred"`, `contextUsage: "synara-estimated"`.

## Open questions (blocking approval)

- Token budget for the summary and how to estimate Antigravity context usage
  when the CLI reports none.
- Whether summarization should bill through the user's Antigravity account
  (an extra `agy --print` call per compaction).
- Interaction with `--continue` resume flows after Synara restarts: the
  rollover boundary must be persisted so a resume never re-attaches the
  pre-compaction conversation id.
