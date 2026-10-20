# ADR-0001 — Refuse cross-site browser writes; allow same-origin framing

Status: accepted (1.1.0)

## Context

The server binds to loopback and checks `Host`, which stops DNS rebinding. It had no `Origin`
check. Writes were "protected" only by requiring `Content-Type: application/json`, which forces a
CORS preflight that the server never grants. Two kinds of request skip the preflight:

* `multipart/form-data` — accepted on **every** path ending in `/import`, including
  `/api/exchange/import`, which never parsed multipart at all;
* POSTs with an empty body (`Content-Length: 0`), where the content-type rule did not apply.

Verified in 1.0.0 (`tests/test_security.py`, 13 tests, all failing on the 1.0.0 server):
any web page could import an `approved` memory whose text then came back verbatim in
`/api/recall`'s digest to agents, approve candidates, run workflows, probe agents, or trigger
paid model calls.

Separately, `frame-ancestors 'none'` + `X-Frame-Options: DENY` blocked the graph page's own
same-origin iframe of `/brain.html`, so the 3D view never rendered.

## Decision

* Every `POST/PUT/PATCH/DELETE` is refused with `403 BAD_ORIGIN` when the browser says the
  request is cross-site (`Sec-Fetch-Site: cross-site`) or sends an `Origin` other than this
  server's own loopback origin (`http://127.0.0.1:<port>`, `localhost`, `[::1]`). The request body
  is drained first so the client sees the 403, not a reset.
* Requests without `Origin` and `Sec-Fetch-Site` — agents, curl, MCP hosts — are unaffected.
* Multipart is accepted only on `/api/documents/import`, the one route that parses it.
* `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`: the app may frame itself; third
  parties still may not (clickjacking protection unchanged).

## Alternatives rejected

* **A bearer token for REST.** It would also stop local processes, but every existing REST
  integration (and the UI, which is served by the backend itself) would need it: a break with no
  migration path for a host that integrated last week. The loopback trust model stays as
  documented; this ADR closes the browser hole, which is the one remote attackers can reach.
* **CORS allow-list.** The server grants no CORS at all; adding it would widen, not narrow.

## Constraints

Published HTTP shapes are unchanged for every non-browser client and for the same-origin UI.
Cross-site browser requests never had a legitimate use: without CORS grants, none of them could
read a response.
