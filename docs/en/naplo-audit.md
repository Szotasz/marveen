# Audit Log (Napló)

The dashboard "Napló" (Audit Log) page provides a unified, read-only view of system-auditable events: settings changes, idea-box status transitions, and store-directory file events.

---

## Data Sources

### Config change log (`config_change_log`)

Every successful `POST /api/settings` request writes an audit row to this table. For secret settings (`secret: true`), `old_value` and `new_value` are stored as `null` -- the fact of the change is recorded, but the value never is.

Fields: `key`, `old_value`, `new_value`, `actor`, `created_at`

### Idea-box audit (`idea_status_log`)

Every idea status transition (e.g. `new` -> `kanban`, or reversal back to `new`) is recorded. The `promote-breakdown` path also generates a row.

Fields: `idea_id`, `from_status`, `to_status`, `actor`, `note`, `created_at`

### Store file audit (`store_file_audit`)

On startup the server attaches an `fs.watch()` listener to the `store/` directory. Every `change` and `rename` event (file write, rename, delete) is recorded. File content is never stored -- only the path, event type, and file size (if determinable at the time of the event).

Sensitive files (`.dashboard-token`, `vault.json`, `.vault-key`) receive `is_sensitive=1`; the UI labels them "sensitív".

Automatically excluded: atomic-write temp files (`.tmp.<hex>`), `.migrated` and `.bak` suffixed files.

Fields: `rel_path`, `event_type`, `is_sensitive`, `file_size`, `created_at`

---

## API

### `GET /api/audit-log`

Bearer token required.

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | string | Comma-separated source filter: `config`, `idea`, `store`. Empty = all. |
| `from` | int | Unix timestamp, inclusive lower bound. |
| `to` | int | Unix timestamp, inclusive upper bound. |
| `q` | string | Free-text search (key, path, note, actor, etc.). |
| `limit` | int | Maximum entries (default: 200, max: `AUDIT_LOG_MAX_ENTRIES`). |

Response:
```json
{
  "entries": [
    {
      "id": 1,
      "source": "config",
      "created_at": 1718000000,
      "key": "KANBAN_WIP_IN_PROGRESS",
      "old_value": "5",
      "new_value": "8",
      "actor": "dashboard"
    },
    {
      "id": 2,
      "source": "idea",
      "created_at": 1718000100,
      "idea_id": "abc123",
      "from_status": "new",
      "to_status": "kanban",
      "actor": "jarvis",
      "note": "promote:planning"
    },
    {
      "id": 3,
      "source": "store",
      "created_at": 1718000200,
      "rel_path": "config-overrides.json",
      "event_type": "change",
      "is_sensitive": 0,
      "file_size": 512
    }
  ],
  "total": 3
}
```

Results are sorted `created_at DESC`; the merged order is source-agnostic.

---

## Configuration

The following keys (Settings page, Audit module) control log behaviour:

| Key | Default | Description |
|-----|---------|-------------|
| `AUDIT_LOG_RETENTION_DAYS` | 90 | Entries older than this many days are deleted during the daily sweep. |
| `AUDIT_LOG_MAX_ENTRIES` | 10 000 | Maximum entries the API returns per request. |

Deletion is performed by `pruneAuditLogs()`, called from `runDecaySweep()` which runs on a 24-hour cycle.

---

## Dashboard UI

The "Napló" entry in the left-hand navigation opens the page.

**Source tabs**: Összes (All) / Config / Ötletláda (Ideas) / Store-fájlok (Store Files) -- clicking a tab filters immediately.

**Date range**: "From" / "To" date inputs; both optional. When both are empty, all entries up to `limit` are returned.

**Search field**: free-text filter mapped to the `q` parameter (key, rel_path, note, actor, etc.).

**Refresh button**: manually re-fetches with the current filter state.

The page is read-only: entries cannot be edited, and are only deleted by the automatic retention sweep.

---

## Related Documents

- [Settings System](config-reference.md#settings-system)
- [Idea Box](ideabox.md)
