# Scheduled Tasks

> Cron-based, filesystem-driven automations — every task is a folder, the runner checks every 60 seconds and delivers the prompt into the agent's tmux session.

---

## How it works

The schedule runner runs as part of the dashboard process. Every 60 seconds it scans all tasks in `~/.claude/scheduled-tasks/` and delivers any whose cron expression matches the current minute into the specified agent's tmux session as a text prompt.

After delivery the agent processes it as a normal Claude Code session — exactly as if you had typed the prompt yourself.

```
60s tick → cron match? → session alive? → prompt delivery
                              ↓ no
                        auto-start + retry queue
```

---

## File structure

Every task lives in its own folder:

```
~/.claude/scheduled-tasks/
  morning-digest/
    SKILL.md          ← the prompt (YAML frontmatter + body)
    task-config.json  ← schedule, agent, behaviour flags
  memory-heartbeat/
    SKILL.md
    task-config.json
  ...
```

### SKILL.md

```markdown
---
name: task-name
description: Short description of what this task does
---

The agent receives this as the prompt. Can be multiple paragraphs,
lists, instructions — exactly as if you typed it in the chat.
```

### task-config.json

```json
{
  "schedule": "30 7 * * *",
  "agent": "jarvis",
  "enabled": true,
  "type": "task",
  "skipIfBusy": false,
  "forceSend": false,
  "createdAt": 1776153060
}
```

---

## Field reference

### task-config.json fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schedule` | string | `"0 9 * * *"` | Cron expression (min hour day month weekday) |
| `agent` | string | main agent | Target agent name (e.g. `"jarvis"`, `"rick"`) |
| `enabled` | boolean | `true` | If `false`, runner skips it |
| `type` | string | `"task"` | See Task types |
| `skipIfBusy` | boolean | `false` | If `true` and session is busy, silently discard tick |
| `forceSend` | boolean | `false` | If `true`, skip busy check, always deliver |
| `createdAt` | number | — | Unix timestamp (seconds), auto-filled |
| `description` | string | — | Optional description (if no SKILL.md frontmatter) |
| `targetSession` | string | — | Custom tmux session name override (default: `agent-<name>`) |

For `command` type tasks, extra fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | — | Raw shell command (runs under `bash -lc`) |
| `timeoutMs` | number | `10000` | Timeout in milliseconds |
| `failThreshold` | number | `2` | Sends Telegram alert after this many consecutive failures |

---

## Task types

| Type | Behaviour |
|------|-----------|
| `task` | Always notifies on Telegram with the result |
| `heartbeat` | Silent — only writes to Telegram if content is important/urgent |
| `command` | Raw shell command, no LLM — only notifies on error (if `failThreshold` exceeded) |

**When to use which:**
- `task`: morning digest, report, one-time important run
- `heartbeat`: 15-30 minute memory audit, kanban check — you don't want to read every tick
- `command`: shell-level check (e.g. disk usage, service ping) without spending LLM tokens

---

## Cron expressions

```
min  hour  day  month  weekday
 30     7    *      *        *    → every day 7:30
  0     8    *      *      1-5   → weekdays 8:00
*/15   *    *      *        *    → every 15 minutes
  0  8,12,16,20  *  *      *    → 4 times a day
  7     2    *      *        *    → 2:07 AM
  0     9    *      *        1   → Mondays 9:00
```

The runner uses the Europe/Budapest timezone (based on node's local TZ).

---

## skipIfBusy vs. forceSend

These two flags control busy session handling:

- **Default (both false)**: if the session is busy, the task goes into a retry queue (SQLite). The runner retries every tick until the session is free. If still pending after 1 hour, sends a Telegram alert.

- **skipIfBusy: true**: silently discard the tick. Only correct for frequently repeating tasks (every 15-30 min) where the next tick is coming anyway. Never use for daily/weekly tasks.

- **forceSend: true**: skip the busy check, inject the prompt into the tmux session. Claude processes it as soon as the current task finishes. For critical tasks (e.g. morning digest) that must not be skipped.

---

## Busy session handling and retry queue

If the target session is busy and `skipIfBusy` is not set, the task goes into the `pending_task_retries` table (SQLite, also visible on the dashboard). The runner retries every 60s tick. If still pending after 1 hour, sends a Telegram alert.

If the session isn't running at all:
1. The runner tries to auto-start the agent
2. The task goes into the retry queue
3. Once the session starts and Claude loads, it delivers the prompt

---

## Auto-start behaviour

If a scheduled task needs to run but the target session doesn't exist (e.g. the agent was stopped), the runner automatically starts the agent, then delivers the prompt via the retry queue. This ensures a once-daily task (e.g. `0 2 * * *`) isn't missed if the agent happened to be down.

---

## Security limits

Before injecting the prompt, an "untrusted" preamble is prepended so that content potentially arriving from user data cannot execute code injection in the agent's context. Maximum prompt length is 50,000 characters (~12K tokens) — larger requests are rejected with 413.

---

## API reference

Dashboard is Bearer-token protected (token: `store/.dashboard-token`).

```bash
TOKEN=$(cat store/.dashboard-token)
```

### List

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/schedules
```

### Create

```bash
curl -s -X POST http://localhost:3420/api/schedules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "task-name",
    "description": "Short description",
    "prompt": "The detailed prompt text the agent receives",
    "schedule": "0 8 * * *",
    "agent": "jarvis",
    "type": "heartbeat",
    "skipIfBusy": true
  }'
```

### Update

```bash
curl -s -X PUT http://localhost:3420/api/schedules/task-name \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"schedule": "0 9 * * *", "enabled": true}'
```

Only provided fields are updated — the rest remain unchanged.

### Delete

```bash
curl -s -X DELETE http://localhost:3420/api/schedules/task-name \
  -H "Authorization: Bearer $TOKEN"
```

### Enable / disable

```bash
curl -s -X POST http://localhost:3420/api/schedules/task-name/toggle \
  -H "Authorization: Bearer $TOKEN"
```

### Run now

```bash
curl -s -X POST http://localhost:3420/api/schedules/task-name/run \
  -H "Authorization: Bearer $TOKEN"
```

### Pending retry list and deletion

```bash
# list
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/schedules/pending

# delete a pending retry (id from the list response)
curl -s -X DELETE http://localhost:3420/api/schedules/pending/42 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Dashboard

Scheduled tasks can be managed visually at: http://localhost:3420/#schedules

- Task list (name, agent, cron, type, enabled state)
- Enable/disable toggle
- Run Now button (for testing)
- **Run history (ℹ button)**: last 10 runs — exact timestamp, status, and estimated token usage
- New task wizard: AI-expands a short description into a detailed prompt, with an interactive cron editor
- Pending retries panel: tasks waiting in the retry queue, with manual deletion

### Run statuses

| Status | Meaning |
|--------|---------|
| `fired` / OK | Prompt successfully delivered to the agent's session |
| `error` / Error | An exception occurred during delivery |
| `skipped` / Skipped | `skipIfBusy=true` and the session was occupied — tick intentionally dropped |

History covers the last 30 days; older rows are pruned automatically.

Statuses can also be queried via the API:

```bash
TOKEN=$(cat store/.dashboard-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/schedules/morning-digest/runs" | jq .
```

Token count is an approximation: it sums the agent's total token activity from the fire time until the next run starts (capped at 1 hour). If the agent handled other work in that window, those tokens are also included.

---

## Existing tasks

| Task | Agent | Schedule | Type | Description |
|------|-------|----------|------|-------------|
| `morning-digest` | jarvis | `30 7 * * *` | task | Daily morning digest (email, calendar, AI news) |
| `memory-heartbeat` | jarvis | `*/15 * * * *` | heartbeat | Memory audit and skill reflection every 15 minutes |
| `kanban-audit` | jarvis | `0 8,12,16,20 * * *` | heartbeat | Kanban board check 4 times daily |
| `dream-engine` | jarvis | `7 2 * * *` | dream-engine | Nightly analysis and suggestion generation |
| `bumblebee-hygiene-scan` | jarvis | `0 9 * * 1` | heartbeat | Weekly hygiene check on Mondays |
| `continuous-check` | jarvis | `*/30 * * * *` | heartbeat | General check (currently disabled) |

---

## Related documents

- [Background tasks](background-tasks.md) — one-off long-running tasks (not cron-based)
- [Memory system](memory-system.md)
- [Kanban](kanban.md)
