# Architecture and design

Use the current [core concepts](docs/core-concepts.md),
[provider boundaries](docs/providers.md), and [agent instructions](AGENTS.md).
Shared schemas belong in `packages/contracts`; shared runtime utilities use
explicit subpath exports from `packages/shared`. Provider adapters own protocol
and capability differences. Runtime and UI verification follow
[CONTRIBUTING.md](CONTRIBUTING.md) and the affected package scripts.

These maintained documents take precedence over an old checkout's module map.
Keep Beta and Stable identities and data homes separate; use [BETA.md](BETA.md)
for the authorized one-way import and Beta-only gates.
