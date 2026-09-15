# Contributing to Synara

Thank you for taking the time to improve Synara. Read this guide together with
the [Code of Conduct](CODE_OF_CONDUCT.md), [Governance](GOVERNANCE.md), and
[Support](SUPPORT.md) guides.

## What contributions fit best

We especially welcome:

- focused bug and regression fixes;
- reliability, recovery, and performance improvements;
- documentation and examples;
- tests and tooling improvements;
- provider integrations that follow the existing boundaries;
- small maintenance changes with clear verification.

Synara is maintainer-led and still evolving. A contribution may be declined
because it conflicts with product direction, duplicates planned work, or adds
maintenance cost that the project cannot support. That is a project decision,
not a judgment about the contributor.

## Before larger changes

For a new feature, architecture change, provider integration, or security
boundary change, open an issue first. Explain:

- the problem and who experiences it;
- the smallest useful solution;
- alternatives and tradeoffs;
- how the change fits [VISION.md](VISION.md) and [DESIGN.md](DESIGN.md);
- how the result would be tested and reviewed.

Please wait for direction before investing in a large implementation. A draft
proposal or spike is often more useful than a large unsolicited pull request.

## Pull requests

Keep each pull request focused and explain what changed, why it should exist,
and how it was verified. Do not combine unrelated cleanup with a feature or
bug fix.

For UI changes, include before/after screenshots. For motion or interaction
changes, include a short recording when it makes the behavior easier to review.
Call out platform-specific behavior, migrations, provider requirements, and
known limitations.

Pull requests are automatically labeled with diff size and contributor trust
status. These labels support triage; they are not a substitute for review.

## Issues

Search existing issues and documentation before opening a new report. Use the
issue form that best matches the request and include the smallest useful
reproduction. Do not post credentials, cookies, private source, or unredacted
provider transcripts.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public
issue.

## Development and testing

Use the pinned toolchain from `.mise.toml` and `package.json`.

Install dependencies with:

```bash
bun install --frozen-lockfile
```

Run the full workspace test suite from the repository root with:

```bash
bun run test
```

For focused web tests, pass paths relative to `apps/web` through the dedicated
root command:

```bash
bun run test:web:focused src/path/to/example.test.ts
```

The pinned `@pierre/diffs` patch refreshes file-editor rows after line
insertions and deletions. When upgrading the dependency, verify repeated Enter,
subsequent typing, undo, and redo with the real editor browser tests before
removing it:

```bash
bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.browser.tsx
```

## Review expectations

Opening a pull request does not guarantee acceptance or a particular review
timeline. Maintainers may ask for a smaller change, request a proposal first,
close a duplicate, or implement the idea differently. We will explain the
decision when practical and ask contributors to keep discussions focused and
respectful.
