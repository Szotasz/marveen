# Kanban + automatic task breakdown

> Every task lives on a card. Drop in a big goal and the assistant breaks it down into subtasks on its own.

---

## 🎯 What it does / why it matters

You don't need to micro-manage the fleet — that's the point of this kanban system. Throw in a large, vague goal ("let's get X done") and the agent automatically breaks it into a subtask hierarchy, assigns the right owner, and tracks progress. You see the result and milestones, not the internal steps.

Two things make it special:

1. **Automatic breakdown:** the LLM turns a task into a card hierarchy (linked with `parent_id`), which you can approve or refine — no need to hold the full to-do list in your head.
2. **Self-driving audit:** every 4 hours the system reviews the board itself — archives old closed cards and follows up with the responsible agent on stalled tasks. You don't need to knock and ask "how's that thing going?"

**Highlight:** card statuses are automatically included in every agent's context. Nobody needs a separate briefing on "where we are" — everyone sees the full picture and picks up where the other left off.

---

## 🛠 How it works

### Storage

SQLite (`store/`): `kanban_cards` (id, title, status, project, priority, assignee, sort_order, archived_at, timestamps) + `kanban_comments` (card-level log).

- **Statuses:** `planned`, `in_progress`, `waiting`, `done`
- **Priorities:** `low`, `normal`, `high`, `urgent`

### Automatic breakdown

For a new large task, a single LLM call (headless `claude -p` via the existing subscription, no external API key) proposes a subtask hierarchy as cards linked with `parent_id`. The user/orchestrator approves, refines, or rejects.

### 4-hour audit

Scheduled task (at 8/12/16/20) relying on a state file (`last_audit_at`):
1. Archive cards closed 7+ days ago.
2. Stalled task = `in_progress` that hasn't moved since the previous audit (`updated_at < last_audit_at`) → message to the responsible agent.
3. Behaviour governed by [progressive autonomy](heartbeat-autonomy.md) level (3: acts; 2: suggests; 1: only notifies).

### Kanban-first workflow

Every project task runs on a card: the orchestrator records it as a card, delegates to the responsible agent (`assignee`), who updates status and comments back. Meta-tasks (like the audit itself) don't get cards.

### Access

Direct SQLite, or the dashboard kanban interface. Card status is automatically included in every agent's context.

### Dashboard kanban interface

Key behaviours in the card editor on the web dashboard (`http://localhost:3420`):

- **Comment author default:** the primary human assignee (`owner` type) is pre-selected as the comment author for new comments, not the bot.
- **Add subtask:** parent cards (not subtasks themselves) show a "New subtask" form. The new subtask inherits the parent's current status. Adding a subtask to a `done` parent is not allowed.
- **Delete subtask:** each subtask row shows a Delete button with a confirmation dialog. The button is hidden when the parent is `done`.
- **Parent assignment editing:** in the subtask detail view (`planned` and `waiting` status only), a dropdown lets you change or detach the parent task. It appears in the card properties row, full-width.

### Stuck cards -- visual indicators

Every non-done card automatically shows a visual warning when it hasn't moved for a while:

**Left-side coloured stripe** -- visible at a glance:

| Colour | What it means |
|--------|--------------|
| Yellow | Unchanged for 1 day -- worth keeping an eye on |
| Orange | Unchanged for 3 days -- will soon need attention |
| Red (pulsing) | Unchanged for 1 week -- stuck, needs immediate attention |

**Hourglass + day counter** (top-right corner) -- e.g. `⏳ 4d` = hasn't moved in 4 days. Hover to see the exact timestamp of the last change.

Cards in `done` status show no indicators -- only active tasks age.

**What to watch for:** if you see many red or orange cards on the board, check them in order: either the task is stuck (the agent didn't receive it or got blocked), or it should be closed or deleted.

### Card aging -- technical details

The dashboard computes an aging level for every non-done card based on the `updated_at` unix timestamp.

**Three tiers, both indicators shown simultaneously:**

| Tier | Default threshold | Left stripe + badge |
|------|------------------|---------------------|
| `warn` | 24 h | yellow |
| `caution` | 72 h | orange |
| `critical` | 168 h (7 days) | red, pulsing |

**Display:**
- Left 3px stripe (`border-left`) — overrides the priority border, uses `--card-aging-color` CSS custom property.
- Top-right `⏳ Xd` / `⏳ Xh` badge — hover tooltip shows the exact last-modified timestamp.
- At critical tier, a subtle CSS `animation: aging-pulse` plays on the badge.
- `done` cards show no indicator.

**Configuration (`.env`):**

```
KANBAN_AGING_WARN_H=24
KANBAN_AGING_CAUTION_H=72
KANBAN_AGING_CRITICAL_H=168
KANBAN_AGING_WARN_COLOR=#c9a000
KANBAN_AGING_CAUTION_COLOR=#d46b00
KANBAN_AGING_CRITICAL_COLOR=#c53030
```

Config flow: `src/config.ts` → `/api/marveen` (`kanbanAging` key) → `window._marveen.kanbanAging` (frontend). The frontend is static (`web/app.js`, no build step) — a server HUP is sufficient to pick up threshold changes.
### Column WIP limits

A WIP (Work In Progress) limit tells you when a column is overloaded -- meaning it has more active tasks than it's sensible to handle at once.

**What you see in the column header**

A round badge at the top of each column shows the current state, e.g. `4/5` (4 cards, limit is 5). The badge colour reflects how close you are to the limit:

| Badge | What it means |
|-------|--------------|
| Grey | Plenty of room, all good |
| Yellow | Approaching the limit -- worth keeping an eye on |
| Orange | One away from the limit -- avoid adding new cards here |
| Red, pulsing | Limit exceeded -- the column is overloaded, resolve something before adding more |

**What to do**

If a column is flashing a red badge, don't push new work into it. Close or move an existing card first. The limit doesn't block new cards -- it's a warning, not a lock.

**How to configure the limit**

WIP limits are set per column in the `.env` file (see the technical documentation for details). If no limit is configured for a column, the badge doesn't appear.

### Column WIP limits -- technical details

Each kanban column accepts an optional card-count ceiling. When set, the existing count badge in the column header switches to `count/limit` format and changes colour based on utilisation:

| State | Condition | Appearance |
|-------|-----------|------------|
| ok | < `WARN_PCT`% | dark grey, no animation |
| warn | >= `WARN_PCT`% (default 80%) | yellow |
| full | exactly at limit (100%) | orange + mild pulse |
| over | exceeds limit | red + stronger pulse + 10% scale |

The badge is implemented by updating the existing `kanban-col-count` span -- no additional HTML element is added.

**Configuration keys (`.env`):**

```
KANBAN_WIP_PLANNED=0        # 0 = unlimited
KANBAN_WIP_IN_PROGRESS=0
KANBAN_WIP_WAITING=0
KANBAN_WIP_DONE=0
KANBAN_WIP_WARN_PCT=80      # % threshold for yellow tier
KANBAN_WIP_OK_COLOR=#6b7280
KANBAN_WIP_WARN_COLOR=#c9a000
KANBAN_WIP_FULL_COLOR=#d46b00
KANBAN_WIP_OVER_COLOR=#c53030
```

Data flow: `src/config.ts` → `/api/marveen` (`kanbanWip` key) → `window._marveen.kanbanWip` (frontend). The frontend is static -- a server HUP is sufficient to apply limit changes.

---

## Related documents

- [Ideas (Idea box)](ideas.md) — from ideas to kanban cards (with AI breakdown)
- [Agent fleet](agent-fleet.md) — assignee agents, delegation
- [Heartbeat autonomy](heartbeat-autonomy.md) — kanban audit autonomy level
