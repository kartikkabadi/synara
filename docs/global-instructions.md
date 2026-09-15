# Global instructions

Synara can load durable, user-authored guidance from `~/SYNARA.md`.

The feature is disabled by default. Enable **Global SYNARA.md instructions** in
Settings → General. When enabled, Synara reads and bounds the file to 6,000
characters, then includes it once when a provider session starts or is
restarted. Keeping it session-scoped avoids repeating the same text in every
turn while preserving the intended behavior across the session.

The contents are wrapped as user-authored guidance. They do not override
Synara safety rules, provider capabilities, or explicit higher-priority system
instructions. Edits to the file are picked up for the next provider session
start or restart.
