# Global instructions

Synara can load durable, user-authored guidance from `SYNARA.md` in its configured data home (`~/.synara` for Stable,
`~/.synara-beta` for Beta).

The feature is disabled by default. Enable **Global SYNARA.md instructions** in
Settings → General. Only the authenticated owner can read or save it through
the editor. Synara reads a regular file of at most 64 KiB and bounds its text to 6,000
characters, then includes it once when a provider session starts or is
restarted. Keeping it session-scoped avoids repeating the same text in every
turn while preserving the intended behavior across the session.

The contents are encoded as escaped JSON containing optional user-authored guidance.
They are untrusted content and cannot authorize tools or change approval or filesystem boundaries. They do not override
Synara safety rules, provider capabilities, or explicit higher-priority system
instructions. The app does not read a shared home-level file or the other flavor’s
file. Edits to the file are picked up for the next provider session
start or restart.

If optional guidance cannot be loaded, the turn continues without it and the
server records a warning. The editor reports the read error and disables editing
and saving until a successful retry. It refreshes after reconnect or app focus;
unsaved drafts remain available.
