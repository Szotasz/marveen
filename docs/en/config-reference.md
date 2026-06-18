# Configuration Reference

> Which file does what, where it lives, what it contains. All configuration files in one place.

---

## store/ -- Runtime State

These files are managed by the dashboard and change at runtime. They are not checked into git (`.gitignore`).

| File | Editable | Description |
|------|----------|-------------|
| `store/.dashboard-token` | no | Dashboard Bearer token -- required for all `/api/*` calls |
| `store/autonomy-config.json` | dashboard UI | Heartbeat autonomy levels by category (1=notify, 2=propose, 3=autonomous) |
| `store/dashboard-settings.json` | dashboard UI | GitHub repo integration, update settings |
| `store/agents-desired.json` | dashboard UI | Which sub-agents to keep alive (auto-restart list) |
| `store/auto-restart.json` | dashboard UI | Per-agent auto-restart config (enabled, mode, dailyTime) |
| `store/vault.json` | dashboard UI | Encrypted secrets (AES-256-GCM) |
| `store/.vault-key` | no | Vault decryption key (migrated to OS keychain when available) |
| `store/schedule-last-run.json` | automatic | Last-run timestamps for scheduled tasks (crash-safe skip guard) |
| `store/kanban-audit-state.json` | automatic | Last kanban audit timestamp |
| `store/claudeclaw.db` | not directly | SQLite database -- memory, kanban, messages, token log, etc. |
| `store/config-overrides.json` | dashboard UI | Settings-page overrides (plain values only, never contains secrets) |
| `store/update.pid` | automatic | Update process PID file (concurrency lock) |

### Dashboard language

A `HU / EN` button appears in the bottom-left corner of the sidebar. Clicking it switches the entire interface immediately -- navigation labels, buttons, messages, and the Documentation page all re-render in the newly selected language. The choice persists within the browser session.

To make a particular language the default for every new visit, set `DASHBOARD_LANG` to `hu` or `en` on the Settings page (System module). The sidebar button overrides the server default; if no client-side choice has been stored, `DASHBOARD_LANG` takes effect.

The Documentation page follows the global language setting -- there is no separate docs language selector.

---

### Settings page

The "Settings" entry in the dashboard's left-hand navigation opens the configuration UI, where env-backed parameters can be viewed and changed directly in the browser -- no `.env` editing or server access required.

**How to change a value**

Settings are grouped by module (Kanban, System, Heartbeat). Each row shows:
- the key name and its description,
- the current value in an editable input (number fields show the valid range; colour fields show a colour picker with a preview swatch; enum-style keys show a dropdown).

Editing an input marks the row as dirty. A sticky save bar appears at the bottom of the page showing the number of pending changes, with two buttons:
- **Save** -- saves all dirty rows at once. Rows that fail validation are flagged with an error; the rest are saved.
- **Reset** -- restores all inputs to their last-loaded values; the save bar disappears.

**What does a validation error mean?**

If you enter an invalid value (e.g. 150 where the maximum is 100, or a colour that isn't in `#rrggbb` format), an error message appears directly below the row after you press Save. The other rows are saved; only the failing row stays dirty. Fix the value and press Save again.

**Unsaved-change guard**

If you try to leave the Settings page (by clicking another menu entry or closing the browser tab) while there are unsaved changes, the browser shows a confirmation dialog. Dismissing it keeps you on the page with the dirty values intact.

**When is a restart required?**

Some rows carry a "Requires restart" badge -- changes to those settings (e.g. `DASHBOARD_PUBLIC_URL`, `OLLAMA_URL`, `HEARTBEAT_AGENT_ENABLED`) only take effect after the next server restart. Kanban and heartbeat window settings (e.g. `KANBAN_WIP_*`, `KANBAN_AGING_*`, `HEARTBEAT_START_HOUR`) apply immediately, no restart needed.

**What can you configure?**

Settings are organised into three modules:

*Kanban* -- how the kanban board behaves:
- WIP limits and badge colours: how many cards per column before the badge turns yellow or red (available since v1)
- Card aging: after how many hours a stale-card indicator appears in yellow, orange, or red -- if your team works in longer cycles, raise the default 24h/72h/168h thresholds accordingly
- Archiving: how many days after a card is closed before it moves to the archive automatically (default: 30 days)
- Swimlane default: which grouping the kanban board opens in ("none", "by assignee", "by priority")

*System* -- infrastructure parameters:
- The publicly accessible URL of the dashboard (used by webhooks and external links; restart required)
- The Ollama embedding server URL (used for memory search; restart required)
- Default UI language (`DASHBOARD_LANG`): `hu` or `en` -- the sidebar button overrides this per-session, but when no client-side choice is stored this value applies on every new visit (no restart needed)

*Heartbeat* -- the background summary agent:
- On/off toggle: "1" = active, "0" = stopped (restart required)
- Active window: which hours of the day the agent is allowed to run (e.g. 9-23 = daytime only)

---

### Settings System

The dashboard Settings page manages a three-layer configuration system.

**Resolution order (first match wins):**
1. `store/config-overrides.json` -- overrides saved by the dashboard
2. `.env` -- project-level values (read fresh on every request, not frozen at boot)
3. Registry default (`src/config-registry.ts`)

**`store/config-overrides.json` structure:**

```json
{
  "KANBAN_WIP_PLANNED": 10,
  "KANBAN_WIP_WARN_PCT": 80,
  "KANBAN_WIP_OK_COLOR": "#6b7280"
}
```

Only overridden keys appear in the file; the rest fall through to the registry default. Writes are atomic (tmp file + rename), so partial writes are impossible.

**Settings registry (`src/config-registry.ts`):**

Every dashboard-editable setting is a registry entry with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | ENV-compatible key (e.g. `KANBAN_WIP_PLANNED`) |
| `type` | `int` / `color` / `string` | Value type (drives validation + UI widget) |
| `default` | any | Fallback when no override and no `.env` entry |
| `description` | string | Human-readable description shown in the UI |
| `module` | string | Grouping label on the Settings page (e.g. `kanban`) |
| `secret` | boolean | If `true`: the API never returns the value; POST is rejected |
| `requiresRestart` | boolean | If `true`: a badge warns the user that the value takes effect after restart |
| `min` / `max` | number? | Bounds for `int` type |
| `valueSet` | string[]? | If set: only these values are accepted (select widget in UI) |

**Registry -- Kanban module:**

| Key | Type | Default | Constraint | Restart |
|-----|------|---------|------------|---------|
| `KANBAN_WIP_PLANNED` | int | 0 (unlimited) | max 100 | no |
| `KANBAN_WIP_IN_PROGRESS` | int | 0 | max 100 | no |
| `KANBAN_WIP_WAITING` | int | 0 | max 100 | no |
| `KANBAN_WIP_DONE` | int | 0 | max 100 | no |
| `KANBAN_WIP_WARN_PCT` | int | 80 | min 1, max 100 | no |
| `KANBAN_WIP_OK_COLOR` | color | `#6b7280` | #rrggbb | no |
| `KANBAN_WIP_WARN_COLOR` | color | `#c9a000` | #rrggbb | no |
| `KANBAN_WIP_FULL_COLOR` | color | `#d46b00` | #rrggbb | no |
| `KANBAN_WIP_OVER_COLOR` | color | `#c53030` | #rrggbb | no |
| `KANBAN_ARCHIVE_DONE_DAYS` | int | 30 | min 1, max 365 | no |
| `KANBAN_AGING_WARN_H` | int | 24 | min 1, max 8760 | no |
| `KANBAN_AGING_CAUTION_H` | int | 72 | min 1, max 8760 | no |
| `KANBAN_AGING_CRITICAL_H` | int | 168 | min 1, max 8760 | no |
| `KANBAN_AGING_WARN_COLOR` | color | `#c9a000` | #rrggbb | no |
| `KANBAN_AGING_CAUTION_COLOR` | color | `#d46b00` | #rrggbb | no |
| `KANBAN_AGING_CRITICAL_COLOR` | color | `#c53030` | #rrggbb | no |
| `KANBAN_SWIMLANE_DEFAULT_GROUP` | string | `none` | `none`, `assignee`, `priority` | no |
| `KANBAN_SWIMLANE_SEPARATOR_COLOR` | color | `#374151` | #rrggbb | no |

**Registry -- System module:**

| Key | Type | Default | Description | Restart |
|-----|------|---------|-------------|---------|
| `DASHBOARD_PUBLIC_URL` | string | (empty) | Publicly accessible URL of the dashboard | yes |
| `OLLAMA_URL` | string | `http://localhost:11434` | Ollama API base URL | yes |

**Registry -- Heartbeat module:**

| Key | Type | Default | Constraint | Restart |
|-----|------|---------|------------|---------|
| `HEARTBEAT_START_HOUR` | int | 9 | min 0, max 22 | no |
| `HEARTBEAT_END_HOUR` | int | 23 | min 1, max 24 | no |
| `HEARTBEAT_AGENT_ENABLED` | string | `1` | `0` or `1` | yes |
**Registry -- Idea-box module:**

| Key | Type | Default | Constraint | Restart |
|-----|------|---------|------------|---------|
| `IDEA_BREAKDOWN_MAX_SUBTASKS` | int | 10 | min 2, max 20 | no |
| `IDEA_STALE_DAYS` | int | 7 | min 1, max 365 | no |

**API endpoints:**

`GET /api/settings` -- fetch all non-secret settings:

```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/settings
```

Response: `{ "settings": [ { "key", "type", "value", "default", "description", "module", "requiresRestart", "min", "max", "valueSet" }, ... ] }`

`POST /api/settings` -- save a single setting:

```bash
curl -s -X POST http://localhost:3420/api/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"key": "KANBAN_WIP_WARN_PCT", "value": 75}'
```

Success response: `{ "ok": true, "key": "KANBAN_WIP_WARN_PCT", "value": 75, "requiresRestart": false }`

Error response: `{ "error": "..." }` (400 validation error, 403 secret key, 404 unknown key)

**Hot-reload:** after a successful POST, the `/api/marveen` `kanbanWip` block immediately reflects the new value with no restart needed (for keys where `requiresRestart: false`).

**Change log:** every successful POST appends an audit row to the `config_change_log` SQLite table (key, old value, new value, actor, timestamp). For secret keys the value is stored as `null`. There is no UI for this table; query it directly:

```sql
SELECT key, old_value, new_value, actor, datetime(created_at, 'unixepoch', 'localtime')
FROM config_change_log ORDER BY created_at DESC LIMIT 20;
```

---

### autonomy-config.json Structure

```json
{
  "version": 1,
  "categories": [
    {
      "key": "kanban_archive_done",
      "label": "Archive done cards older than 7 days",
      "level": 2,
      "locked": false,
      "maxLevel": 3
    }
  ]
}
```

Autonomy levels: `1` = notify only, `2` = propose + approval required, `3` = autonomous + reports afterwards. `locked: true` means max level is 1 (cannot be raised due to hard safety rule).

---

## agents/<name>/ -- Sub-agent Configuration

Every sub-agent's directory is gitignored (`agents/` folder), keeping secrets safe.

| File | Editable | Description |
|------|----------|-------------|
| `agents/<name>/agent-config.json` | dashboard UI | Model, team hierarchy, permission profile |
| `agents/<name>/.mcp.json` | manually | MCP servers for this agent (gitignored!) |
| `agents/<name>/.claude/settings.json` | scaffold + manually | Claude Code permissions, hooks, allowed tools |
| `agents/<name>/CLAUDE.md` | manually | Agent instructions and persona |
| `agents/<name>/SOUL.md` | manually | Optional deeper persona descriptor |
| `agents/<name>/avatar.png` | manually | Agent Telegram bot profile picture |

### agent-config.json Structure

```json
{
  "model": "claude-sonnet-4-6",
  "profileId": "developer-senior",
  "team": {
    "role": "member",
    "reportsTo": "marveen",
    "delegatesTo": [],
    "autoDelegation": false,
    "trustFrom": []
  }
}
```

---

## templates/ -- Agent Creation Templates

These templates are populated during agent scaffolding and placed into `agents/<name>/`.

| File / Folder | Description |
|---------------|-------------|
| `templates/CLAUDE.md.template` | Default CLAUDE.md template for new agents |
| `templates/SOUL.md.template` | Default SOUL.md template |
| `templates/settings.json.template` | Claude Code settings template (hooks, permissions) |
| `templates/profiles/` | Permission profile templates (JSON files) |
| `templates/scheduled-tasks/` | Built-in scheduled tasks (morning briefing, memoria-heartbeat, etc.) |

### Permission Profiles (templates/profiles/)

| Profile | permissionMode | Description |
|---------|---------------|-------------|
| `default.json` | permissive | Default fallback, everything allowed |
| `developer-senior.json` | permissive | SSH/AWS/sudo blocked, otherwise unrestricted |
| `developer-junior.json` | strict | Strict sandbox, only allowed paths |
| `marketer.json` | strict | Marketing-specific access |
| `researcher.json` | strict | Researcher profile, limited writes |

Profile is set via the `profileId` field in `agent-config.json` and configurable from the dashboard "Agents" view.

---

## ~/.claude/scheduled-tasks/ -- Scheduled Tasks

Each task lives in its own folder with two files. Detailed description: [scheduled-tasks.md](scheduled-tasks.md).

| File | Description |
|------|-------------|
| `SKILL.md` | YAML frontmatter (name, description) + prompt body |
| `task-config.json` | Cron expression, agent, type, behaviour flags |

---

## ~/.claude/channels/ -- Channel Access

| File | Description |
|------|-------------|
| `~/.claude/channels/telegram/access.json` | Telegram allowFrom list, paired senders |
| `~/.claude/channels/slack/access.json` | Slack allowFrom list |

---

## .mcp.json -- MCP Servers

MCP configurations are scoped: agent `agents/<name>/.mcp.json` files contain only the servers relevant to that agent. The `.mcp.json` at the project root applies to the main agent (marveen/Jarvis).

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@zereight/mcp-gitlab"],
      "env": {
        "GITLAB_PERSONAL_ACCESS_TOKEN": "...",
        "GITLAB_API_URL": "https://gitlab.com/api/v4"
      }
    },
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp", "serve"]
    }
  }
}
```

**Important:** the `agents/` folder is gitignored, so secrets in `.mcp.json` files don't end up in the repository. Verify the project-root `.mcp.json` is also gitignored.

---

## Environment Variables (.env / launchd plist)

Key configuration variables live in the launchd plist (`~/Library/LaunchAgents/com.marveen.dashboard.plist`) or `.env` file.

| Variable | Description |
|----------|-------------|
| `CHANNEL_PROVIDER` | `telegram` or `slack` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token |
| `ALLOWED_CHAT_ID` | The single allowed Telegram chat ID |
| `SLACK_BOT_TOKEN` | Slack bot token (if Slack provider) |
| `SLACK_CHANNEL_ID` | Slack channel ID |
| `WEB_PORT` | Dashboard port (default: 3420) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `OWNER_NAME` | Owner name (e.g. "Jónás Gergő") |
| `BOT_NAME` | Main agent name (e.g. "Jarvis") |

---

## Related Documents

- [Vault and Encryption](vault.md)
- [MCP Configuration](mcp-config.md)
- [Scheduled Tasks](scheduled-tasks.md)
- [Security Model](security.md)
- [Migration](MIGRATION.md)
