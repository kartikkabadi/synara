# Security policy

## Supported versions

Security fixes are prioritized for the latest release and the `main` branch.
Older releases may not receive fixes if the issue depends on current runtime,
provider, or platform behavior.

## Reporting a vulnerability

Please do not report security vulnerabilities in a public issue, pull request,
or discussion.

Use GitHub's private vulnerability reporting for this repository when it is
available. Include:

- the affected version or commit;
- the affected platform and runtime;
- a concise description of the impact;
- reproduction steps or a proof of concept;
- any known mitigations.

Redact tokens, cookies, credentials, private source code, and personal data from
all reports.

If private vulnerability reporting is unavailable, contact the project
maintainers through a private GitHub channel and state that the message is a
security report.

## Response

The maintainers will acknowledge receipt when practical, investigate the
report, coordinate a fix or mitigation, and publish an advisory when
appropriate. Please allow time for triage before publicly disclosing details.

Synara is local-first software. Reports involving provider credentials,
browser sessions, local files, worktrees, or remote-access configuration should
include the relevant boundary without including the secret itself.
