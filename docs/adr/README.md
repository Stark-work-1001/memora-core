# Architecture decision records

Each record states a decision, the evidence behind it, the alternatives rejected, and how it
touches the four fixed constraints in HANDOVER.md §4 (licence, published interfaces, offline-first
and desensitization, the degradation contract). A record may tighten a published interface only
when the old behaviour broke one of those constraints, and it must name the migration path.

| ADR | Decision | Interfaces touched |
|---|---|---|
| [0001](0001-cross-site-write-gate.md) | Refuse cross-site browser writes; allow same-origin framing | HTTP (403 `BAD_ORIGIN` for cross-site writes only) |
| [0002](0002-no-self-certification.md) | Agents, imports and workflows cannot approve or raise trust | MCP `memory_update`/`memory_forget`, exchange import default |
| [0003](0003-local-calendar-days.md) | Day buckets follow the local calendar | on-disk `vault/daily/*.md` naming semantics |
| [0004](0004-schema-versioning.md) | `PRAGMA user_version` + ordered migrations; refuse newer databases | on-disk `memora.db` |
| [0005](0005-desktop-build-contents.md) | Declare and check what the desktop build contains | release layout (deprecation of the top-level backend copy) |

Records for the workflow engine and for the retrieval default live next to these files once
those changes land (see CHANGELOG.md, 1.1.0).
