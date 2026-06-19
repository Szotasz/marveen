# Activity Log & Tool Log

> Real-time tool call logging, session statistics, and an automatic workflow candidate detector.

---

## What it does / why it matters

During every agent session, Claude Code tool calls (Bash, Read, Write, WebFetch, etc.) are **logged** to a shared SQLite table. This enables:

- **Transparency**: what is running right now, which tools an agent is calling
- **Diagnostics**: post-hoc analysis of slow or failing sessions
- **Workflow detector**: automatic detection of long, repeating session patterns — for skill-generation suggestions

The Dashboard **Activity** page shows this data in real time.

---

## API

### Log a tool call (from a hook)

The PostToolUse hook calls this automatically:

```
POST /api/tool-log
Content-Type: application/json

{
  "session_id": "abc-123",
  "tool_name": "Bash",
  "input_summary": "git push origin feat/...",
  "success": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `session_id` | yes | Claude Code session identifier |
| `tool_name` | yes | Tool name (Bash, Read, Write, WebFetch, ...) |
| `input_summary` | no | Short summary of the call's content |
| `success` | no | `true` if successful (default: `true`) |

### Retrieve recent tool calls

```
GET /api/tool-log?since=<seconds>
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `since` | How many seconds back to look | 3600 (1 hour) |

Response: list of tool calls in chronological order (newest first).

```json
[
  {
    "id": 1042,
    "session_id": "abc-123",
    "tool_name": "Bash",
    "input_summary": "git push origin feat/...",
    "success": true,
    "ts": 1748956800
  }
]
```

### Prune old entries

```
POST /api/tool-log/prune
Content-Type: application/json

{ "older_than_secs": 86400 }
```

Default: delete entries older than 86400 seconds (1 day).

---

## Workflow candidate detector

The analysis endpoint identifies **sessions that may be worth saving as a skill**: they contain at least N tool calls, occurred within a time window, and show a repeating pattern.

```
GET /api/tool-log/analyze?since=<s>&min_calls=<n>&gap=<s>
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `since` | Time window to look back | 3600 s |
| `min_calls` | Minimum tool call count for flagging | 5 |
| `gap` | Session boundary: new session after this many seconds of silence | 300 s |

Response: list of session summaries.

```json
[
  {
    "session_id": "abc-123",
    "tool_count": 14,
    "duration_minutes": 8.2,
    "start_ts": 1748956800,
    "end_ts": 1748957292,
    "tools": ["Bash", "Read", "Edit", "Write"],
    "steps_preview": [
      { "tool": "Bash", "description": "git worktree add ..." },
      { "tool": "Read", "description": "src/web/routes/agents.ts" }
    ]
  }
]
```

`steps_preview` contains the first 10 calls — enough to judge whether a skill is worth creating.

---

## Dashboard — Activity page

The Dashboard **Activity** page shows:

| Section | Content |
|---------|---------|
| Real-time calls | Most recent N tool calls, grouped by session |
| Session statistics | Per agent: call count, success rate, most-used tools |
| Workflow candidates | Automatically flagged sessions, with a "Create skill" button |

---

## Examples

```bash
TOKEN=$(cat store/.dashboard-token)

# Tool calls from the last 30 minutes
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/tool-log?since=1800"

# Workflow candidates from the last 2 hours (min. 8 calls)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/tool-log/analyze?since=7200&min_calls=8"

# Prune entries older than 1 day
curl -s -X POST http://localhost:3420/api/tool-log/prune \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"older_than_secs": 86400}'
```

---

## Related documents

- [Skill factory](skill-factory.md) — skill generation from session patterns
- [Agent fleet](agent-fleet.md) — agent lifecycle and hooks
- [Token usage](token-usage.md) — token consumption tracking
