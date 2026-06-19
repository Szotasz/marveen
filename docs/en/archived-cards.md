# Archived Cards

> A dedicated view for kanban cards removed from the active board, with search and restore.

---

## Using the archive

Open the view from the "Archivált" entry in the left-hand navigation. The kanban board automatically archives closed (`done`) cards once they have been in that state longer than the configured threshold (default: 30 days) -- they disappear from the board but remain searchable in the Archived view.

**Search**

Text typed in the search field matches across card title, project, and assignee simultaneously. Results narrow as you type.

**Filters**

Three filters sit alongside the search field:

- Project -- filter by exact project name
- Label -- filter by a single label
- Date range ("From" / "To") -- narrows by the time the card was archived; both inputs are optional

**Restoring a card**

Each row has a Restore button. Clicking it moves the card back to the active kanban board (in `done` status), where it reappears in the normal view and can be edited or moved to a different status.

**Key things to know**

- The archived view is read-only: editing and status changes are only possible after restoring the card to the active board
- Up to 500 cards are shown at once by default -- adjustable on the Settings page (`KANBAN_ARCHIVED_MAX_ROWS`)
- Archived cards do not appear on the kanban board and are excluded from heartbeat summaries

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
