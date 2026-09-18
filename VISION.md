# Synara vision

Synara is a local-first workspace for doing serious software work with coding
agents.

## The problem

Coding agents are useful, but the surrounding work is fragmented. Context lives
in one tool, files in another, terminals in a third, and review happens after
the agent is finished. That makes it difficult to supervise work, run multiple
tasks safely, understand what changed, and recover when a provider or connection
fails.

## What Synara is

Synara brings the working context around an agent into one application:

- projects and task threads;
- provider sessions and model selection;
- terminals, files, editors, browsers, and previews;
- Git changes, checkpoints, worktrees, and pull requests;
- provider handoffs, automations, and scoped MCP integrations.

The goal is not to hide the work. The goal is to make the work visible,
reviewable, and easier to control.

## Principles

### Local-first

The user's machine, files, credentials, provider installations, and Git
repositories remain the primary working environment. Synara should add
coordination without requiring users to move their source code to a hosted
service.

### Provider-neutral

Synara should work with multiple coding-agent runtimes without making one
provider the center of the product. Provider-specific behavior belongs behind
clear adapters and capability boundaries.

### Reviewable by default

Every meaningful action should leave enough context for a person to understand
what happened, inspect the result, and decide what happens next.

### Safe concurrency

Parallel work is valuable only when ownership is explicit. Tasks, worktrees,
processes, sessions, and external integrations must have clear boundaries and
predictable cleanup.

### Durable and recoverable

Disconnects, restarts, provider failures, and partial work are normal operating
conditions. Synara should preserve useful state and make recovery explicit
instead of silently losing context.

### Open without pretending to be unstructured

Synara is open source, but maintainers still need to protect the product's
coherence and users' time. Good contributions are welcome when they are
focused, explain the problem, respect the architecture, and follow the
project's process.

## What Synara is not

Synara is not intended to:

- replace every provider's native application;
- make autonomous changes invisible or irreversible;
- become a hosted source-code platform by default;
- promise that every proposed feature will be accepted;
- remove the need for human review, testing, or judgment.

## Direction

The long-term direction is a dependable command center for agent-assisted
software work: one place where people can start work, supervise it, coordinate
multiple runtimes, inspect the evidence, and deliver changes without losing
ownership of their code or environment.
