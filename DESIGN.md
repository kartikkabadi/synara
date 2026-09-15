# Synara design

This document describes the architectural boundaries that keep Synara
predictable as the product grows. It is a map of ownership, not a replacement
for implementation-specific documentation.

## Runtime surfaces

Synara has three primary runtime surfaces:

- `apps/web` — React presentation, browser-side transport, and client
  projections;
- `apps/server` — durable orchestration, persistence, providers, Git, tools,
  and the typed HTTP/WebSocket API;
- `apps/desktop` — Electron hosting and operating-system integrations.

The public website and documentation live separately in `apps/marketing`.
Shared contracts live in `packages/contracts`; intentionally shared runtime
utilities live in `packages/shared`.

```text
┌──────────────────────────────────────────────┐
│ Web client                                   │
│ React UI · transport · client projections    │
└──────────────────────┬───────────────────────┘
                       │ typed HTTP/WebSocket RPC
┌──────────────────────▼───────────────────────┐
│ Server                                       │
│ orchestration · persistence · providers      │
│ Git/worktrees · terminals · automation       │
└──────────────┬───────────────────────┬────────┘
               │                       │
       provider adapters          SQLite/filesystem/Git
               │                       │
        coding-agent runtimes       durable local state

┌──────────────────────────────────────────────┐
│ Desktop shell                               │
│ Electron host · backend supervision · native │
│ integrations · shared web client             │
└──────────────────────────────────────────────┘
```

## Ownership rules

### Server authority

Durable application truth belongs to the server's orchestration and
persistence layers. The web client may cache and project that state, but it
must not become the source of truth for active turns, provider sessions,
checkpoints, Git state, or recovery.

Client-owned state is explicit and limited to concerns such as unsent drafts,
layout preferences, and other local presentation state that cannot be
reconstructed from server snapshots.

### Provider boundaries

Provider-specific protocols, process behavior, model discovery, approvals,
resume semantics, and native capabilities belong behind `ProviderAdapter`.
Cross-provider orchestration depends on capabilities and canonical runtime
events, not on provider-specific wire formats.

### Process and resource lifecycles

Processes, provider sessions, terminals, worktrees, streams, browser targets,
and external integrations need deterministic ownership, bounded queues, clear
timeouts, and explicit cleanup. A successful source-level test is not proof
that packaged process behavior is correct on every platform.

### Shared code

Cross-process schemas belong in `packages/contracts`. Runtime utilities shared
across workspaces belong in `packages/shared` and should use explicit subpath
exports rather than a catch-all barrel.

## Durable orchestration

A state-changing request generally follows this path:

```text
client request
    ↓
orchestration command
    ↓
durable event / projection update
    ↓
provider command reactor
    ↓
provider service
    ↓
provider adapter
```

Provider output returns through the inverse path:

```text
native provider event
    ↓
canonical runtime event
    ↓
runtime ingestion
    ↓
durable orchestration state
    ↓
projection stream
    ↓
web client
```

The important invariant is that native provider output is normalized before it
becomes application state. Provider-specific details may be retained where
needed for identity, recovery, or diagnostics, but arbitrary native protocol
frames should not leak through the application boundary.

## Recovery and reconnects

The client receives server-authoritative snapshots and resumable streams. A
reconnect may resume from a known cursor when the server can prove that the
cursor is valid; otherwise Synara prefers a fresh snapshot over an unsafe
partial replay.

Late requests and replayed events must not move a client behind a newer live
sequence. Recovery behavior should preserve drafts and presentation state
without confusing that local state with durable server state.

## Adding a feature

Before implementing a feature, identify:

1. which runtime owns the behavior;
2. whether the behavior is durable or presentation-only;
3. which contract crosses a process boundary;
4. how retries, cancellation, reconnects, and partial failure behave;
5. how ownership and cleanup are enforced;
6. what evidence proves the behavior works.

Prefer one authoritative path over parallel special cases. Prefer capability
checks over provider-name conditionals. Prefer an explicit recovery path over
silently guessing.

## Adding a provider

A first-class provider normally requires:

1. shared provider metadata and contracts;
2. a server adapter and registry wiring;
3. health/authentication and discovery behavior;
4. model and runtime-mode compatibility;
5. web settings, picker, and handoff surfaces;
6. lifecycle, interruption, resume, approval, and event-normalization tests.

Provider additions should extend existing shared protocol infrastructure where
possible and keep native behavior inside the adapter.

## Further reading

- [Architecture notes](.docs/architecture.md)
- [Provider architecture](.docs/provider-architecture.md)
- [Workspace layout](.docs/workspace-layout.md)
- [Runtime modes](.docs/runtime-modes.md)
- [Core concepts](docs/core-concepts.md)
