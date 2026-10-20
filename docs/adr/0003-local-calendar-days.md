# ADR-0003 — Day buckets follow the local calendar

Status: accepted (1.1.0)

## Context

Timestamps are stored as UTC ISO strings (`…Z`). 1.0.0 also *bucketed* by the first ten characters
of those strings: the daily note (`vault/daily/YYYY-MM-DD.md`), the overview's per-day counts, the
timeline graph and imported documents' `day`. For anyone east of Greenwich, morning work landed on
yesterday's page (UTC+8 rolls over at 08:00); west of it, evening work landed on tomorrow's. The UI
showed the same memory under the local date, so the views disagreed with each other.

## Decision

Stored timestamps stay UTC. Every *day* is the user's local calendar day: `db.today()`,
`db.local_day(stamp)`, `db.local_clock(stamp)`; the overview groups with SQLite's
`date(recorded_at, 'localtime')` and returns `today`; timeline day nodes start at local midnight.

## Constraints

The on-disk name format `daily/YYYY-MM-DD.md` is unchanged; what changes is which day an entry
belongs to. Existing pages are not rewritten: entries written before the upgrade keep the page they
were filed under. Proven by `tests/test_vault.py::test_daily_page_is_the_local_calendar_day`
(fails on the 1.0.0 vault: `daily/2026-10-19.md != daily/2026-10-20.md`).
