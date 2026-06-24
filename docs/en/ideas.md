# Idea Box (Ideas)

> Quick idea capture, AI-powered kanban breakdown, and one-click promotion of approved subtasks to the board.

---

## What it does / why it matters

The Idea Box is a **lightweight idea card system** that guides ideas from impulse to actionable tasks — without having to decide how to break them down right away.

Flow:

1. Quick capture (title, description, category)
2. Optional AI breakdown: the LLM suggests 3-5 subtasks with assignees and priorities
3. Approved subtasks go on the kanban board **with one click**, including a parent card
4. After promotion the idea's status changes to `kanban`, referencing the created card

---

## API

### List ideas

```
GET /api/ideas[?status=<status>][&category=<category>]
```

Statuses: `new` | `kanban` (promoted) | `archived`

### List categories

```
GET /api/ideas/categories
```

Returns the set of existing categories (dynamic, from the database).

### Create an idea

```
POST /api/ideas
Content-Type: application/json

{
  "title": "Short name of the idea",
  "description": "Detailed description (optional)",
  "category": "Development",
  "source": "manual"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Short name of the idea |
| `description` | no | Detailed text |
| `category` | no | Default: `Other` |
| `source` | no | `manual` / `agent` / any string |

Response: `{ "ok": true, "id": "<8-char id>" }`

### Update an idea

```
PUT /api/ideas/<id>
Content-Type: application/json

{ "title": "...", "description": "...", "category": "..." }
```

### Delete an idea

```
DELETE /api/ideas/<id>
```

---

## AI breakdown

### Request a breakdown

```
POST /api/ideas/<id>/breakdown
```

The LLM analyses the idea's title and description, then suggests **3-5 subtasks**:

```json
{
  "subtasks": [
    {
      "title": "Design API endpoint",
      "description": "Design the REST endpoint...",
      "assignee": "zack",
      "priority": "high"
    },
    {
      "title": "Frontend integration",
      "assignee": "marveen",
      "priority": "normal"
    }
  ]
}
```

The breakdown **does not write to the database** — the user reviews and optionally edits the suggested subtasks, then saves them with the promote-breakdown call.

### Save breakdown and promote

```
POST /api/ideas/<id>/promote-breakdown
Content-Type: application/json

{
  "subtasks": [
    { "title": "...", "description": "...", "assignee": "zack", "priority": "high" }
  ]
}
```

- Creates a parent kanban card (`status: planned`) with the idea's name
- Creates a child card for each subtask (with `parent_id` reference)
- Updates the idea's status to `kanban`, writes the `kanban_id`
- At least 1 subtask is required

Response:
```json
{ "ok": true, "parent_id": "<parent card id>", "child_count": 3 }
```

---

## Quick promote (without breakdown)

If the idea is clear enough and LLM breakdown isn't needed:

```
POST /api/ideas/<id>/promote
Content-Type: application/json

{ "phase": "detail" }
```

| `phase` value | Created card status | Title prefix |
|---------------|---------------------|--------------|
| `detail` | `waiting` | `[Detail work] <idea name>` |
| `plan` | `planned` | `<idea name>` (no prefix) |

---

## Dashboard

The **Idea Box** page on the dashboard shows ideas in a kanban-style view. Available buttons:

- **AI breakdown** — generate breakdown, subtask editor panel
- **Promote** — direct conversion to a kanban card
- **Delete** — archive/delete the idea

---

## Examples

```bash
TOKEN=$(cat store/.dashboard-token)

# Create a new idea
curl -s -X POST http://localhost:3420/api/ideas \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Automatic PR summary generation",
    "description": "Short summary on Telegram after every merged PR.",
    "category": "Automation"
  }'

# Request AI breakdown
curl -s -X POST http://localhost:3420/api/ideas/<id>/breakdown \
  -H "Authorization: Bearer $TOKEN"

# Promote with approved subtasks
curl -s -X POST http://localhost:3420/api/ideas/<id>/promote-breakdown \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "subtasks": [
      { "title": "GitHub webhook listener", "assignee": "zack", "priority": "high" },
      { "title": "Telegram message template", "assignee": "marveen", "priority": "normal" }
    ]
  }'

# List all new ideas
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/ideas?status=new"
```

---

## Related documents

- [Kanban](kanban.md) — where promoted ideas end up
- [Agent fleet](agent-fleet.md) — list of assignee agents
