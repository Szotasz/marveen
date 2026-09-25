# Google Workspace MCP server (per-agent Gmail, Calendar, Drive, Sheets)

`scripts/google-mcp.py` is a dependency-free Python stdio MCP server that gives
an agent access to **its own** Google account: Gmail, Calendar, Drive, Sheets
and (optionally) the Workspace directory.

Why a local server instead of the claude.ai Google connectors: a hosted
connector is bound to the single claude.ai login, so whatever Google account is
authorised there is visible to every agent that shares the login. This server
is isolated per agent purely through environment variables: the same script,
a different token file per agent.

## Tools

24 tools, read-oriented first:

- `whoami`
- Gmail: `gmail_search`, `gmail_get`, `gmail_get_attachment`, `gmail_create_draft`, `gmail_send`, `gmail_labels`, `gmail_apply_label`
- Calendar: `calendar_list_events`, `calendar_get_event`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_freebusy`
- Drive: `drive_search`, `drive_download`, `drive_create_doc`, `drive_share`, `drive_upload`
- Sheets: `sheets_create`, `sheets_append`, `sheets_read`, `sheets_update` (with `value_input` RAW / USER_ENTERED and `value_render`)
- Directory: `people_search`

`gmail_send` only sends to **internal** recipients (the agent's own domain, or
`GOOGLE_INTERNAL_DOMAINS`); any external recipient is refused with a `blocked`
result, so the agent has to create a draft and get approval instead. The
server needs the `gmail.send` scope only if you want this tool to work at all.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_CLIENT_JSON` | yes | Path to the OAuth **desktop client** JSON (`{"installed": {...}}`), shared by all agents. |
| `GOOGLE_TOKEN_JSON` | yes | Path to THIS agent's token file (`{"refresh_token": "...", "scope": "..."}`), unique per agent. |
| `GOOGLE_ACCOUNT` | no | Expected account email, for a startup sanity check and the default internal domain. |
| `GOOGLE_INTERNAL_DOMAINS` | no | Comma-separated domains treated as internal by `gmail_send`. Default: the account's own domain. |
| `GOOGLE_MCP_OWNER_CWD` | no | Serve tools only when launched from this directory. Claude Code merges `.mcp.json` from parent directories, so a project-root entry is otherwise inherited by every sub-agent under `agents/<name>/` that has no entry of its own. When set and launched elsewhere, the server exposes **no tools** (an empty list, not an exit, so health checks stay green). |

## Setup

1. **OAuth client (once).** In a Google Cloud project enable the Gmail,
   Calendar, Drive and (if you use them) Sheets and People APIs, and create an
   OAuth client of type **Desktop app**. Download its JSON as the
   `GOOGLE_CLIENT_JSON` file. (Service-account keys are often blocked by org
   policy; the desktop client avoids that.)
2. **Per-agent token.** For each agent account run the standard loopback OAuth
   flow once: open
   `https://accounts.google.com/o/oauth2/v2/auth?client_id=<id>&redirect_uri=http://localhost&response_type=code&access_type=offline&prompt=consent&scope=<scopes>`
   while signed in as that account, take the `code` from the redirect, and
   exchange it at `https://oauth2.googleapis.com/token` for a refresh token.
   `access_type=offline` and `prompt=consent` are both needed, otherwise no
   refresh token comes back. Store `{"refresh_token": "...", "scope": "..."}`
   as the agent's `GOOGLE_TOKEN_JSON` (mode 0600).
   Typical scopes: `gmail.modify`, `calendar`, `drive` (Sheets works with the
   `drive` scope), plus `gmail.send` and `directory.readonly` if needed.
3. **Wire it into the agent's `.mcp.json`:**

   ```json
   {
     "mcpServers": {
       "google": {
         "command": "python3",
         "args": ["<install>/scripts/google-mcp.py"],
         "env": {
           "GOOGLE_CLIENT_JSON": "<install>/store/secrets/google-client.json",
           "GOOGLE_TOKEN_JSON": "<install>/store/secrets/<agent>-google-token.json",
           "GOOGLE_ACCOUNT": "<agent>@<your-domain>"
         }
       }
     }
   }
   ```

4. **Restart the agent fresh** so the MCP server is loaded, then ask it to
   call `whoami`: it must report the agent's own account.

## Notes

- Shared Drives: Drive calls pass `supportsAllDrives=true`; without it a
  Shared Drive folder answers 404 even when the account has access.
- `people_search` needs the People API, the `directory.readonly` scope and, in
  the Admin console, directory contact sharing turned on. It uses
  `listDirectoryPeople` plus a local accent-insensitive match, which works on
  small organisations where `searchDirectoryPeople` returns nothing.
- `gmail_get` returns both the `Date` header and Gmail's `internalDate`.
- A changed MCP server is only picked up when the agent restarts.
