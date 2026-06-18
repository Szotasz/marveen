# Archived Cards

> A dedicated view for kanban cards removed from the active board, with search and restore.

---

## Overview

The kanban board auto-archives `done` cards older than `KANBAN_ARCHIVE_DONE_DAYS` days (default: 30) during the next `listKanbanCards()` call. The Archived view lets you browse and search those cards without cluttering the board, and restore any card back to active status.

Features:
- Full-text search (title, project, assignee).
- Filter by project and date range.
- Per-card restore button (sets `archived_at = NULL`).

---

## Configuration

| Key | Description | Default |
|-----|-------------|---------|
| `KANBAN_ARCHIVE_DONE_DAYS` | Days after which `done` cards are auto-archived. | 30 |
| `KANBAN_ARCHIVED_MAX_ROWS` | Maximum cards returned by the archived view at once. | 500 |

Both settings are hot-reloaded; no restart required.

---

## API

### GET /api/kanban/archived

Returns archived cards with embedded labels per card.

Query parameters (all optional):

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Free-text search (title, project, assignee). |
| `project` | string | Exact project name filter. |
| `label` | string | Label name filter. |
| `from` | unix timestamp | Archived-at lower bound. |
| `to` | unix timestamp | Archived-at upper bound. |
| `limit` | int | Max rows returned (capped at 5000; defaults to `KANBAN_ARCHIVED_MAX_ROWS`). |

Response:

```json
{
  "cards": [
    {
      "id": "AB12CD34",
      "title": "Card title",
      "status": "done",
      "project": "Project name",
      "priority": "normal",
      "assignee": "jarvis",
      "archived_at": 1718000000,
      "updated_at": 1718000000,
      "labels": [{ "id": "x1", "name": "AI", "color": "#3b82f6" }]
    }
  ],
  "total": 1,
  "limit": 500
}
```

### POST /api/kanban/:id/unarchive

Restores a single archived card (`archived_at = NULL`). Returns 404 if the card is not archived or does not exist.

```bash
curl -s -X POST http://localhost:3420/api/kanban/AB12CD34/unarchive \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"
```

Response: `{ "ok": true }`

---

## Notes

- The archived view is read-only. Editing or moving a card is only possible after restoring it to the active board.
- `listKanbanCards()`, `listKanbanCardsSummary()`, `getChildCards()`, `listKanbanProjects()` and the heartbeat summary all retain their `archived_at IS NULL` filters unchanged.
