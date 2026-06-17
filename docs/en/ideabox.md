# Idea Box

The idea box is a lightweight idea-capture and prioritisation system built into the Marveen dashboard. Ideas can be promoted to kanban cards, broken down into subtasks with AI assistance, and ranked by impact×effort scoring.

## Status lifecycle

```
new → reviewed → kanban
              ↘ rejected
```

- **new**: received, not yet evaluated
- **reviewed**: evaluated, no kanban card yet
- **kanban**: promoted; `kanban_id` holds the card identifier
- **rejected**: discarded, will not be promoted

The dashboard filter defaults to the "active" view (new + reviewed combined).

## Impact×Effort scoring

Each idea accepts 1-5 integer values for:

- **Impact**: value delivered (5 = highest value)
- **Effort**: work required (5 = most work)
- **Score** = impact - effort (positive = high value with low effort)

The score badge is shown on the idea card (`I{n}·E{n}`). The Dream Engine Bucket 3 promotes high-score ideas (score ≥ 2) into the daily top-3 recommendations.

## Comment thread

Comments can be added to any idea via the detail view (opens by clicking the title). Comments are stored in the `idea_comments` table, and every new comment also bumps the idea's `updated_at`.

## AI breakdown

The "Breakdown" button calls `POST /api/ideas/:id/breakdown`, which generates 3-N subtasks with AI assistance (default N=5). The max subtask count is configurable:

```bash
# In .env or the launchd plist:
IDEA_BREAKDOWN_MAX_SUBTASKS=8
```

After user approval in the UI, `POST /api/ideas/:id/promote-breakdown` creates the parent kanban card and one child card per approved subtask.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ideas` | List ideas (`?status=`, `?category=` filters) |
| POST | `/api/ideas` | Create idea |
| PUT | `/api/ideas/:id` | Update (title, description, category, status, impact, effort) |
| DELETE | `/api/ideas/:id` | Delete |
| GET | `/api/ideas/:id/comments` | List comments |
| POST | `/api/ideas/:id/comments` | Add comment |
| POST | `/api/ideas/:id/promote` | Promote to kanban card (phase: `detail` or `plan`) |
| POST | `/api/ideas/:id/breakdown` | Generate AI breakdown |
| POST | `/api/ideas/:id/promote-breakdown` | Create kanban cards from approved subtasks |

### Impact/effort validation

`impact` and `effort` accept integers 1-5 or `null`. The API returns 400 for out-of-range values.

## Database schema

```sql
-- idea_box (existing table, extended)
id TEXT PRIMARY KEY
title TEXT NOT NULL
description TEXT
category TEXT NOT NULL DEFAULT 'Egyéb'
status TEXT NOT NULL DEFAULT 'new'   -- new|reviewed|kanban|rejected
source TEXT NOT NULL DEFAULT 'manual'
kanban_id TEXT                       -- set when status='kanban'
impact INTEGER                       -- 1-5, nullable
effort INTEGER                       -- 1-5, nullable
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL

-- idea_comments (new table)
id INTEGER PRIMARY KEY AUTOINCREMENT
idea_id TEXT NOT NULL REFERENCES idea_box(id)
author TEXT NOT NULL
content TEXT NOT NULL
created_at INTEGER NOT NULL
```

The `impact` and `effort` columns were added via `ALTER TABLE ... ADD COLUMN`; the upgrade is safe on existing databases (the code swallows the exception if the column already exists).

## Dream Engine integration

Dream Engine Bucket 3 (daily top-3 recommendations) queries the idea box alongside open kanban cards:

```sql
SELECT id, title, category, impact, effort, (impact - effort) AS score
FROM idea_box
WHERE status IN ('new','reviewed')
  AND impact IS NOT NULL AND effort IS NOT NULL
ORDER BY score DESC, impact DESC
LIMIT 5
```

If a high-score idea (score ≥ 2) exists, at most one is included in the top-3 with an `[Idea box]` prefix.
