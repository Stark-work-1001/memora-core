# ADR-0004 — `PRAGMA user_version` and ordered migrations

Status: accepted (1.1.0)

## Context

1.0.0 re-ran `schema.sql` (`CREATE … IF NOT EXISTS`) on every start and unconditionally wrote
`meta.schema_version = '1'`. A column added to an existing table would never reach an existing
database, and a database written by a newer build would be silently re-stamped as version 1.
OPERATIONS.md claimed "automatic schema migration on startup"; there was none.

## Decision

* `db.SCHEMA_VERSION` (currently 1) is stored in `PRAGMA user_version`; 1.0.0 databases (0) are
  treated as version 1.
* `db.MIGRATIONS = {version: (sql, ...)}` runs in ascending order, one transaction per version,
  the version number committed with its changes. A failing migration rolls back completely.
* Fresh databases are created from `schema.sql` at the latest version and skip migrations, so
  `schema.sql` must always describe the latest schema.
* A database newer than the program raises `db.SchemaTooNew` and the file is left byte-for-byte
  untouched.
* `/api/health` reports `schema_version`; the table census is derived from `sqlite_master`
  against `schema.sql` (the hand-written 23-name list missed 7 real tables and counted 2 virtual).

Proven by `tests/test_db.py` (migration once and in order, rollback, refusal leaves the file
unchanged, 1.0.0 database adopted).
