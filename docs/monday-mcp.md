# Monday.com MCP server

`scripts/monday-mcp.py` is a dependency-free Python stdio MCP server for
Monday.com (GraphQL API, `API-Version: 2025-07`).

Design guardrails:

- **Read is unrestricted** across all boards the token can see (reports,
  search, verification, statuses, activity logs, subitems, update replies,
  asset URLs).
- **Write is create + update only**: create items / subitems / groups /
  columns, change column values (single, status, multiple), move an item to a
  group, duplicate an item, post an update (optionally as a thread reply, with
  real clickable @mentions), edit a posted update in place, attach a file to
  an update, send a Monday notification.
- **There is deliberately no delete tool.** The capability is absent, so the
  agent cannot delete anything regardless of what the token permits.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `MONDAY_TOKEN` | yes | A Monday personal API token. Inject it from the dashboard Vault via a binding rather than writing it into `.mcp.json`. |
| `MONDAY_AUTHOR_MARK` | no | Prefix put in front of every posted update, e.g. `🤖 Bot (automated):`. Useful when the agent writes with a person's token, so its posts do not read as that person's own comments. Unset = no prefix. |

## .mcp.json

```json
{
  "mcpServers": {
    "monday": {
      "command": "python3",
      "args": ["<install>/scripts/monday-mcp.py"],
      "env": {
        "MONDAY_TOKEN": "vault:<your-monday-key-id>",
        "MONDAY_AUTHOR_MARK": "🤖 Bot (automated):"
      }
    }
  }
}
```

## Notes

- `monday_add_update` accepts HTML in the body (`<ul><li>..</li></ul>`,
  `<b>`, `<br>`). Mentions are passed as `mentions: [{id, name}]` of internal
  users; Monday appends the mention chip at the end of the update and sends
  the user's native notification.
- `monday_edit_update` replaces the body. For a substantive change, fetch the
  current body first and append a dated section instead of overwriting it.
- Large boards: `monday_board_items` returns one page (`limit`, default 25);
  prefer `monday_search` or group-level reads when you only need a subset.
