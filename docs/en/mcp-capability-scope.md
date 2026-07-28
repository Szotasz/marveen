# MCP capability scope (per-agent tool restrictions)

Opt-in, per-agent allowlisting of MCP tools. When configured, only the tools
you explicitly permit can be called; everything else is denied at the
settings.json level, even under `--dangerously-skip-permissions`.

## Setting it up

Open an agent → **MCP capability scope** tab → choose a preset:

| Preset | Behaviour |
|--------|-----------|
| Full access (profile-based) | No restrictions. Default. |
| Read-only | Auto-allows `list_`, `get_`, `search_`, etc. per server; all write/delete tools denied. |
| Custom | Check individual tools per server. Dangerous tools (push, merge, delete) are highlighted in red and require confirmation. |

Save → written to `agent-config.json` immediately.

## Schema

```json
{
  "mcpScope": {
    "github": ["get_issue", "list_pull_requests"],
    "gitlab": "*"
  }
}
```

- String array: only those tools are allowed for that server.
- `"*"`: entire server allowed.
- Server present in `.mcp.json` but absent from `mcpScope`: all its tools are denied (fail-closed).
- `mcpScope` key missing from config: unmanaged, no restrictions (backward-compatible).

## Enforcement

On save, the scaffold writes explicit `deny` entries to `.claude/settings.json`:

```json
{ "permissions": { "deny": ["mcp__github__push_files", "mcp__gitlab__delete_branch"] } }
```

Deny rules are enforced before the permissions bypass, so the fail-closed
guarantee holds in all modes.
