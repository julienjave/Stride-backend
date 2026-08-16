# A note on `_journal.json`'s `when` timestamps

Entries `0001`–`0010` carry hand-maintained, **synthetic** `when` values —
a fixed `+86,400,000ms` (one day) stride from the previous entry, not real
generation-time `Date.now()` output. Confirmed via git history, not
assumed: each entry appears fully-formed with its synthetic value in a
single commit, no later amendment. Entry `0000` is genuine generator
output (real, irregular timestamps, random auto-generated tag names).

They're in strict chronological order, so `drizzle-kit migrate` reads
them correctly — but if you're debugging an ordering or no-op issue,
don't assume these values reflect when each file was actually written.

Full story: `docs/journal/32-row-level-security-profile-tables.md`.

Entries `0011` onward must be created via `drizzle-kit generate --custom`
(per `docs/extra/RLS-ROADMAP.md`'s methodology) and will carry real
timestamps by construction — this note shouldn't need updating for them.
