# Idea Box

The idea box is a lightweight idea-capture and prioritisation system built into the Marveen dashboard. Ideas can be promoted to kanban cards, broken down into subtasks with AI assistance, and ranked by impact×effort scoring.

## Using the idea box

### Statuses and filtering

Each idea is in one of four states: **new** (just captured), **reviewed** (evaluated, not yet a running task), **kanban** (promoted, now a kanban card), **rejected** (discarded). The idea box defaults to the active view (new + reviewed combined). Switch the view with the filter tabs:

- **Active** -- new + reviewed; what you're working from
- **On kanban** -- promoted ideas where a task is already running
- **Rejected** -- ideas don't disappear; you can look back at why you said no

### Comment thread

Click an idea's title to open its detail view. A comment thread appears at the bottom where you can attach notes, review decisions, or reasoning to the idea. This keeps the discussion on the idea itself instead of scattering it across chat history.

### Impact×Effort scoring

In the detail view, fill in two fields:

- **Impact** (1-5): how much value the idea delivers -- 5 is the highest
- **Effort** (1-5): how much work it takes -- 5 is the most

**Score** = Impact - Effort. A positive score means high value for relatively low work. The idea card shows an `I{n}·E{n}` badge with the score. Leave both fields empty to keep the idea unscored -- unscored ideas are not included in the daily recommendations.

**Why score?** Each day the system builds a top-3 list of open tasks and ideas worth picking up next. An idea with a score of 2 or more is eligible to appear in that list -- so high-value ideas don't get buried in a growing backlog.

### AI breakdown and promotion

When an idea is concrete enough, use the "Breakdown" button to let the AI propose subtasks. You can edit and approve the suggestions, then create kanban cards for all of them in one click. If the idea is clear enough to skip the breakdown, "Promote" turns it directly into a card.

**Definition of done:** during an AI breakdown, before you approve the subtasks you can enter a short success criterion ("what does done look like?"). It is automatically appended to the parent kanban card's description so everyone working on the task knows what the finish line is.

### Stale ideas

If an idea hasn't changed for a while (7 days by default) and is still unevaluated, its card gets an orange left border and a "Stale" badge. Nothing is blocked -- it's a reminder to make a decision: evaluate it, reject it, or delete it if it's no longer relevant.

### What happens when a promoted idea's card dies?

If a previously promoted idea's kanban card is deleted or archived, the idea automatically reverts to "reviewed" status -- as if it had returned to the evaluated-but-not-yet-running pile. The idea isn't lost: it can be reconsidered at a later point or in a different context. The reversal can also be triggered manually from the idea's detail view.

### Status history

The idea's detail view shows a full log of every status change: who made it, when, and from which state to which. If the reasoning behind a decision wasn't captured in the comment thread, the log at least records who changed it and when.

---

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

The "Breakdown" button calls `POST /api/ideas/:id/breakdown`, which generates 3-N subtasks with AI assistance (default N=10). The max subtask count (2-20) is configurable:

```bash
# In .env or the launchd plist:
IDEA_BREAKDOWN_MAX_SUBTASKS=8
```

This key is also editable on the dashboard **Settings** page (Ötletláda section); the config layer reads it live, so a change takes effect without a restart.

After user approval in the UI, `POST /api/ideas/:id/promote-breakdown` creates the parent kanban card and one child card per approved subtask.

## Stale ideas

If a `new` idea's `updated_at` is older than `IDEA_STALE_DAYS` days (default 7), the API returns `stale: true` on that idea. Stale cards show an amber left border and an "Elavult" (stale) badge in the UI.

```bash
# In .env or the launchd plist:
IDEA_STALE_DAYS=14
```

This key is also editable on the dashboard **Settings** page (Ötletláda section); the config layer reads it live, so a change takes effect without a restart.

## Audit trail (status log)

Every status change is recorded in `idea_status_log`: who changed it, when, from which status, to which status, and an optional note. Queried via API:

```bash
GET /api/ideas/:id/status-log
# Response: { log: [{ id, idea_id, from_status, to_status, actor, note, created_at }, ...] }
```

## Promotion loop (reversal)

When a `kanban`-status idea's kanban card is deleted or archived, the idea is automatically reverted to `reviewed` (`kanban_id` is cleared and the transition is logged as `actor: 'system'`). Manual reversal is also available:

```bash
POST /api/ideas/:id/revert
# Only works on ideas with status 'kanban'; reverts to 'reviewed' and clears kanban_id.
```

## Definition of Done

When using breakdown promotion, an optional success criteria string can be submitted. It is appended to the parent kanban card's description under a `## Siker-kritérium` (Definition of Done) heading.

```bash
POST /api/ideas/:id/promote-breakdown
{
  "subtasks": [...],
  "success_criteria": "Feature tested, documented, and running on staging."
}
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ideas` | List ideas (`?status=`, `?category=` filters; includes `stale` field) |
| POST | `/api/ideas` | Create idea |
| PUT | `/api/ideas/:id` | Update (title, description, category, status, impact, effort) |
| DELETE | `/api/ideas/:id` | Delete |
| GET | `/api/ideas/:id/comments` | List comments |
| POST | `/api/ideas/:id/comments` | Add comment |
| GET | `/api/ideas/:id/status-log` | Get status audit log |
| POST | `/api/ideas/:id/revert` | Revert kanban idea back to reviewed |
| POST | `/api/ideas/:id/promote` | Promote to kanban card (phase: `detail` or `plan`) |
| POST | `/api/ideas/:id/breakdown` | Generate AI breakdown |
| POST | `/api/ideas/:id/promote-breakdown` | Create kanban cards; accepts optional `success_criteria` |

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

-- idea_comments (Phase 1)
id INTEGER PRIMARY KEY AUTOINCREMENT
idea_id TEXT NOT NULL
author TEXT NOT NULL
content TEXT NOT NULL
created_at INTEGER NOT NULL

-- idea_status_log (Phase 2 -- audit trail)
id INTEGER PRIMARY KEY AUTOINCREMENT
idea_id TEXT NOT NULL
from_status TEXT              -- NULL for creation
to_status TEXT NOT NULL
actor TEXT NOT NULL DEFAULT 'system'
note TEXT
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
