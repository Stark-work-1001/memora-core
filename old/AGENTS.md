# Development boundaries

This checkout is the development/test tree, `<project root>`.

- Do not copy, build, publish, synchronize, migrate data, or run write probes against
  `../memora-desktop-standalone` without explicit user authorization for that action.
- Development upgrades do not authorize a standalone update. `tools/build_desktop.py`
  defaults to a development-only backend build. Do not pass `--allow-standalone-update`
  unless the user has authorized it.
- Use disposable stores under this checkout's `runtime/tmp` for tests and previews.
  Existing `data/` contains real development memories; preserve it.
- Preserve unrelated uncommitted changes. See `docs/DIRECTORY-LAYOUT.md`,
  `docs/TRANSPORT.md`, and `docs/UPGRADE-MEMORY-SYSTEM.md` before changing these boundaries.
- Reference projects inform implementation. Do not claim upstream integration or benchmark
  parity when only an architectural mechanism has been reimplemented.
