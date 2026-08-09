# ADR 0001: Remote execution environments over SSH — architecture decision package

- Status: Proposed (awaiting Kartik approval)
- Date: 2026-07-28
- Related: kartikkabadi/synara#99 (epic; design v2 and Kartik's source-validation addendum in the issue thread), kartikkabadi/synara#92 (control workboard), upstream Emanuele-web04/synara#366 (remote-host RFC), #467 (Claude over SSH), #408 (worktree-backed workspaces), #291 (agent gateway)

## Context

Synara should run a project or thread on a remote machine (VPS, Box VM, Mac, Linux host) over SSH while keeping the normal Synara experience: chat, approvals, checkpoints, terminals, dev servers, history, and recovery. Two principal architectures exist, and the epic requires a comparison, a threat model, and a shared environment capability contract before any engine work.

## Architecture A: Provider process over SSH (local server authoritative)

The local Synara server stays the single source of truth. For a remote thread it spawns the provider binary (`codex app-server`, `claude`, etc.) on the remote host through SSH, streams the provider's stdio protocol over the SSH channel, and keeps all state (SQLite, events, checkpoints, thread history) local.

- The remote host needs only the provider binary and a repo checkout — no Synara install.
- Workspace lives remotely; the local server addresses it via SSH commands (git, file reads, terminals).
- Upstream #467 is a working proof for Claude.

## Architecture B: Remote Synara server with proxying

An exact-version Synara server runs on the remote host (bootstrapped upload-first, supervised by systemd/launchd). The local server acts as an SSH broker: it holds the tunnel and forwards the remote server's WS/HTTP surface byte-for-byte under `/env/:envId/*`. Sessions, files, git, and state live entirely on the remote server. This is the upstream #366 RFC design, matching how Codex remote connections and comparable remote-workspace tools work.

## Hybrid

Per-capability choice: Architecture A for quick "run this provider over there" cases; Architecture B where durability across local sleep/disconnect matters. Both are expressible with the same environment descriptor (`runtimeType: "ssh-process" | "remote-synara-server"`), so the contract does not force the decision.

## Trade-offs

| Concern                         | A: process over SSH                                                                                          | B: remote Synara server                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Correctness                     | Event log local and authoritative; risk of divergence if SSH drops mid-turn                                  | Remote server owns its own event log; no split state, but two servers to aggregate client-side           |
| Provider support                | Works for stdio-protocol providers; provider must exist remotely; per-provider quirks handled locally        | Whatever the remote Synara version supports; version skew between local and remote is a new failure axis |
| Latency                         | Every provider event crosses SSH; interactive but chatty                                                     | Only UI frames cross the tunnel; provider loop is host-local                                             |
| Packaging                       | Nearly none — needs SSH + provider binary remotely                                                           | Full bootstrap: tarball upload, pinned runtime, checksums, rollback, supervisor install                  |
| Trust boundary                  | Remote host is semi-trusted executor; secrets stay local except provider credentials                         | Remote host holds full Synara state, provider credentials, and auth tokens                               |
| Survives local sleep/disconnect | No — the turn dies with the SSH channel unless a remote detacher (tmux-like) is added                        | Yes — sessions live remotely; reconnect reattaches                                                       |
| Reconnect/crash recovery        | Must resume provider session over new SSH channel; provider-dependent                                        | Server-level: reconnect tunnel, re-handshake, resume WS; state intact                                    |
| Workspace sync                  | None needed (workspace fully remote), but local UI features (diffs, file browsing) must go over SSH per call | None needed; remote server serves its own files/diffs natively                                           |
| Phone / multi-device            | No — local server must be up                                                                                 | Yes — connect directly to remote server (e.g. Tailscale)                                                 |
| Cost                            | Low idle cost; nothing persistent remotely                                                                   | Persistent daemon per host; orphaned-server cleanup required                                             |

## Per-thread execution profiles

Kartik's source-validation addendum on #99 (referencing upstream Emanuele-web04/synara#284) validates making execution location a **per-thread execution profile** while orchestration and durable lifecycle state stay owned by Synara. The addendum names seven concepts an executor design must cover:

1. runtime type and adapter/protocol version
2. reproducible setup image/template and bootstrap inputs
3. repository revision and path scope
4. credential/secrets boundary
5. filesystem sync direction and conflict policy
6. event-stream normalisation
7. teardown/reconciliation after success, crash, cancellation, expiry, or unknown outcome

The contract expresses this as `ExecutionProfile` (`packages/contracts/src/orchestration.ts`), carried optionally on `ProviderSessionStartInput` — absent means local execution:

- `environmentId` — which `ExecutionEnvironmentDescriptor` the thread runs on (host-level: transport, runtime, capabilities).
- `providerKind` — which provider binary runs there.
- `remoteWorkspaceRoot` — the path scope: the absolute remote checkout the thread is anchored to. This is per-thread, not per-host, so it lives on the profile rather than on the environment runtime (`ExecutionEnvironmentRuntime` keeps host-level `remoteBinaryPath` and `adapterProtocolVersion`). The contract deliberately has no generic env-var forwarding field: forwarded values are commonly credentials, so anything crossing the remote boundary must be modeled later as typed references into the credential/secret system (explicit target environment, consumer, scope, and audit semantics) or a distinct non-secret allowlist contract.
- `repositoryRevision` (optional) — the revision the workspace is expected to be at, for repo-identity checks at probe time.
- `bootstrapImage` (optional) — reproducible setup image/template for environments that are provisioned rather than pre-existing.
- `adapterProtocolVersion` (optional) — per-thread override of the adapter/protocol version negotiated with the remote provider process.

Concepts 4–7 (secrets boundary, sync policy, event normalisation, teardown/reconciliation) are covered by the threat model and the existing event/turn lifecycle rather than by profile fields; they become schema when the slices that need them land.

## Threat model

| Threat                       | Notes / required mitigation                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH host-key spoofing (MITM) | Verification is mandatory and cannot be silently disabled. The contract only offers `known-hosts` or `pinned-fingerprint` policies; there is no "insecure/off" value. New-host trust is an explicit user action.                                                                                                             |
| Key/credential leakage       | Contract carries only paths/references (`identityFile`, `sshConfigPath`), never key material, passwords, or tokens. Nothing secret in repository state, logs, prompts, or evidence. Provider credentials pushed to a remote host (B, and A for provider auth) must be scoped per environment via Global Accounts.            |
| Command injection            | All remote command construction must use argv-style execution (no shell string concatenation) and be tested with spaces, quotes, Unicode, and long paths on POSIX and Windows.                                                                                                                                               |
| Public binding / exposure    | Port forwards bind to loopback by default. A remote Synara server (B) must require an auth token whenever reachable beyond loopback; Tailscale/Cloudflare exposure is explicit and separately governed. Upstream #366 notes current auth is tied to `--auth-token` presence — that must become policy-driven before B ships. |
| Remote process cleanup       | Kill/cleanup scoped to the exact Synara installation/session (pidfiles + install path), never pattern-matched process kills. Crash-safe create/delete to avoid orphaned daemons, worktrees, or expensive VMs.                                                                                                                |
| Workspace isolation          | Remote worktrees per thread (per #408 model); a thread must not be able to escape its workspace root. Repo identity checked so operations hit the intended checkout.                                                                                                                                                         |
| Multi-tenant remote host     | Multiple brokers/users sharing a host risk contended `SYNARA_HOME`, port collisions, and cross-user reads. v1 assumes single-user hosts; per-broker homes and loopback-only listeners keep the blast radius small.                                                                                                           |
| Bootstrap supply chain (B)   | Upload-first with checksums and rollback; never `curl \| sh` on the remote host.                                                                                                                                                                                                                                             |

## Recommendation

Start the first vertical slice with **Architecture A (provider process over SSH, local server authoritative)**, while keeping the contract explicitly dual-architecture.

Rationale: A reuses the existing provider-session machinery and #467's proven path, requires no remote packaging/supervision/version-skew story, and keeps all durable state in one place. It delivers the core user value ("run this thread on my VPS") with the smallest new attack surface. B remains the target for durability and phone access and is expressed in the same contract (`runtimeType: "remote-synara-server"`), so nothing in this slice forecloses it.

Assumptions: single-user remote hosts; existing OpenSSH client config (keys, agents, ProxyJump) is usable; provider binaries can be checked/installed on the remote host; workspace is fully remote (no two-way file sync).

Non-goals for the first slice: remote Synara server bootstrap/supervision, phone/multi-device access, long work surviving local server shutdown, Windows remote hosts, multi-tenant hosts.

## Source validation

External evidence supporting this decision package:

- Upstream Emanuele-web04/synara#467 (Claude over SSH) is a working proof of Architecture A's shape: a provider process spawned remotely with stdio streamed over the SSH channel, local server authoritative.
- Upstream Emanuele-web04/synara#366 (remote-host RFC) is the reference design for Architecture B (remote Synara server behind an SSH broker), including its bootstrap, auth-token, and version-skew concerns.
- Kartik's source-validation addendum on #99 validates the per-thread execution-profile shape against upstream #284 and surveys comparable systems (Better Agent's detached runners behind one authoritative backend; pingdotgg's minimal multi-provider web GUI and its tailnet-scoped access model; Crabbox's remote-lease and proof-bundle patterns) as architectural inspiration.

The architectural invariant across all of it: **backends may differ, but users see one Synara lifecycle, one approval model, one recovery model, and one durable evidence trail.**

## Unresolved product questions (need Kartik's approval)

1. Approve Architecture A as the first vertical slice, with B as the durability follow-up?
2. For A, is "turn dies if the local machine sleeps" acceptable for v1, or is a remote detach/reattach layer (tmux-style) required from the start?
   - **Assumed answer for v1: yes — the turn dies with the SSH channel.** The failure is surfaced as a settled (interrupted) turn with full evidence retained; no remote detacher in the first slice. Architecture B remains the durability path.
3. One `SYNARA_HOME` per remote box or per connecting broker when B lands (upstream #366 open question)?
4. Is Tailscale acceptable as the blessed multi-device path for B, with SSH port-forward as fallback?
5. Version-skew policy for B: read-degraded + user-invoked drain-then-upgrade (per #366), or something stricter?
6. Which providers must the A slice support first (Codex and Claude are the natural candidates)?
   - **Assumed answer: Codex-first, Claude next behind the same seam.** `codexAppServerManager.ts` is the most complete session broker and the whole Codex path is already stdio-shaped; upstream #467 (Claude over SSH) is the precedent proving the same mechanism works for Claude, so nothing in the Codex-first order forecloses it.
