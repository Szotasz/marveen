# Memory MCP connector

A remote MCP server built into the dashboard HTTP server. claude.ai and ChatGPT "custom connectors" can read and write a dashboard user's **own** memories in the `memories` table, authenticated with OAuth 2.1 (dynamic client registration, authorization code, PKCE S256).

## Enable

1. Set `MEMORY_MCP_ENABLED=1`.
2. Set `DASHBOARD_PUBLIC_URL` to the public **https** URL of the dashboard. Without an https URL the connector stays off and every endpoint answers 404.
3. Optional: `MEMORY_MCP_REDIRECT_HOSTS` (comma-separated, default `claude.ai,chatgpt.com`) limits which hosts may be OAuth redirect targets (exact hostname match).
4. Restart the dashboard.

A dashboard user must exist, and be logged in in the browser that adds the connector: the consent page only works with a valid dashboard session.
The login cookie is `SameSite=Strict`, so it is not sent when the connector opens the consent URL from its own site; the sign-in page then offers a **continue** link to the same URL, which carries the cookie.

## Connect

Add a custom connector with the URL `<DASHBOARD_PUBLIC_URL>/mcp`. The consent page asks for one of three modes:

- `rw`: read and write (search, fetch, recent, list_topics, remember, update_memory, forget)
- `r`: read only (search, fetch, recent, list_topics)
- `w`: write only (remember; nothing can be read back)

## Data

The owner's rows are stored in `memories` with agent_id `mcp:<username>`. The `mcp:` namespace is reserved: `POST`/`PUT`/`PATCH /api/memories` refuse it. A connector only ever sees its own rows, never agent or shared rows. `forget` removes the row but keeps its last text as a `delete` entry in `memory_versions`.

## Revoke

- `GET /api/memory-mcp/tokens` lists grants: a logged-in user sees their own active grants, the dashboard token sees every grant (revoked ones with `revoked_at`).
- `POST /api/memory-mcp/tokens/<id>/revoke` revokes a grant; its access and refresh tokens stop working at once.
