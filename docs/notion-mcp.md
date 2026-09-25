# Notion MCP server

`scripts/notion-mcp.py` is a dependency-free Python stdio MCP server for the
Notion API (`Notion-Version: 2022-06-28`), meant for an agent that maintains
a knowledge base in Notion.

Guardrail: read plus controlled write. There is deliberately **no delete or
archive tool**, so the agent cannot remove pages or blocks regardless of the
token's scope.

Tools (8): `notion_search`, `notion_get_page` (page text), `notion_list_blocks`,
`notion_create_page`, `notion_append_text`, `notion_update_text` (edit one
block's text), `notion_update_table_cell`, `notion_append_table_row`.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `NOTION_TOKEN` | yes | A Notion internal-integration token. Inject it from the dashboard Vault via a binding. The integration only sees pages that were shared with it in Notion. |

## .mcp.json

```json
{
  "mcpServers": {
    "notion": {
      "command": "python3",
      "args": ["<install>/scripts/notion-mcp.py"],
      "env": { "NOTION_TOKEN": "vault:<your-notion-key-id>" }
    }
  }
}
```
