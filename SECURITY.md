# Security reporting

Do not put credentials, browser cookies, private source code, personal data, or
unredacted transcripts in public issues or pull requests.

Check this repository's Security tab for a configured private vulnerability
reporting route before sharing a report. Reporting availability is a repository
setting; do not assume another fork or upstream provides the same route. If no
private route is offered, request a maintainer-provided contact method without
posting sensitive details. This repository does not publish a private email
address or promise a response deadline.

A private report should describe the affected version or commit, platform,
provider/runtime boundary, impact, reproduction steps, and known mitigation.
Use synthetic identities and redact secrets from attachments. Do not run a
proof of concept against another person's account, database, or machine.

For ordinary bugs or usage questions, follow [SUPPORT.md](SUPPORT.md).
Supported runtime and release behavior are documented in the current
[provider guide](docs/providers.md) and [release guide](docs/release.md); do not
infer a fix or signed package from an unmerged PR or local test.
