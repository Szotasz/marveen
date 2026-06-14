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

---

## Related documents

- [Ideas (Idea box)](ideas.md) — from ideas to kanban cards (with AI breakdown)
- [Agent fleet](agent-fleet.md) — assignee agents, delegation
- [Heartbeat autonomy](heartbeat-autonomy.md) — kanban audit autonomy level
