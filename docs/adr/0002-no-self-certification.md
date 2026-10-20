# ADR-0002 — Agents, imports and workflows cannot approve or raise trust

Status: accepted (1.1.0)

## Context

The README states a hard rule: a memory whose only evidence is `agent_asserted` never exceeds
trust 0.5 and is never auto-promoted. 1.0.0 enforced it in exactly one place (`Store.set_status`).
Five bypasses were verified at runtime:

1. `PATCH /api/memories/{id}` or `memory_update {status: approved, trust: .99}` — approved, 0.99;
2. MCP `memory_update` by the agent that wrote the memory — it approves itself;
3. `memory_remember evidence_kind=user_stated` — the agent's claim taken as the user's word (0.9);
4. exchange import of a record saying `approved / 0.99 / user_stated, verified` — honoured as is;
5. the built-in `session-distill` workflow persisted `fact` memories as `approved` with no evidence.

Combined with the cross-site import (ADR-0001), a web page could plant an "approved" instruction
that `recall` then handed to every agent.

## Decision

Every write path declares an **origin**: `user` (the local UI / HTTP), `restore` (the user
explicitly restoring their own backup), `agent` (MCP), `import` (exchange import), `workflow`.
For untrusted origins (`agent`, `import`, `workflow`) the store:

* creates `approved` requests as `candidate` (`metadata.requested_status` records the request,
  `metadata.origin` the source) and caps trust at 0.5;
* refuses a transition to `approved` (`store.NotPermitted`, a `ValueError`: HTTP 400, MCP -32602);
* records claimed evidence kinds verbatim but never as `verified`.

A memory whose evidence is all `agent_asserted` is capped at 0.5 for everyone, including a human
`PATCH` — the README rule is absolute. Human approval does not raise trust by itself.

Also: `update_memory` now validates everything before writing and commits status and fields in one
transaction (1.0.0 committed the status change, then failed on an invalid `kind`); editing text drops
cached vectors; hard delete removes orphan edges, vectors, review rows, candidates and conflicts;
`sensitivity=secret` bodies are no longer written to the Markdown mirror or exported by default.

## Interface changes and their paths

| Interface | 1.0.0 | 1.1.0 | Path for existing hosts |
|---|---|---|---|
| MCP `memory_update {status: approved}` | approves | error -32602 "批准只能由人在界面里完成" | a human approves in the UI; agents keep writing candidates |
| MCP `memory_forget {hard: true}` | deletes immediately | needs `confirm: <id>` | pass `confirm`; HTTP already required it and MEMORY-MODEL §7 promised it |
| MCP `memory_remember` trust | evidence-kind weight (up to 0.9) | ≤ 0.5 until a human approves | none needed; the old number was the lie the rule forbids |
| exchange import (HTTP/CLI/MCP) | status/trust/verified honoured | `trust: "cap"` by default (`demoted` count in the report) | restoring your own backup: `trust: "preserve"` (HTTP body/query, CLI) — never over MCP |
| exchange export | included `sensitivity=secret` | excluded unless `include_secret=1` (HTTP) | records now carry `sensitivity`; the format id stays `memora-exchange/1` (additive field) |
| exchange import of `memora-exchange/2+` | silently read as v1 | per-record error, nothing guessed | — |

The semantic change to import is deliberate: the 1.0.0 behaviour broke constraint 4 (a "success"
that certified what nobody verified) and the README's own rule. `preserve` keeps the old behaviour
available to the one actor entitled to it.

## Alternatives rejected

* **Enforce by evidence only.** An importer can forge evidence rows as easily as a status.
* **Default-deny origin in the store.** Safer in principle, but every internal caller and test
  would change at once; explicit origins on the five untrusted paths, each with a test, are
  auditable today (`tests/test_trust.py`).
