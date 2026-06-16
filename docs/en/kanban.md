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
### Swimlane view

The swimlane view splits the board into horizontal lanes, so instead of one big column you immediately see where cards are piling up -- by owner or by priority.

**What you see**

When grouping is turned on, cards are arranged into horizontal lanes instead of (or within) columns. Each lane starts with a sticky header (always visible while scrolling) showing:

- the assignee's avatar and name (when grouping by owner), or the priority label (when grouping by priority),
- the number of cards in the lane,
- a small chevron icon to collapse the lane.

**Switching the grouping**

A control above the board lets you choose how cards are split into lanes:

- **By owner** -- one lane per assignee, so you can tell at a glance who has how much in flight.
- **By priority** -- cards land in `low`/`normal`/`high`/`urgent` lanes, so urgent work doesn't get lost in the crowd.

Your choice is remembered in the browser, so you don't have to re-select it every time you open the board.

**Collapsing a lane**

If a lane isn't relevant right now (e.g. an assignee with everything closed out), click the chevron in its header -- the lane collapses to just the header (with the card count). Click again to reopen it.

**What it's for**

On a large board with lots of cards, the plain column view gets hard to scan. The swimlane view immediately shows the load distribution -- if cards are piling up for one owner (or at one priority level), you see it at a glance, before reading through each one.

### Swimlanes -- technical details

The kanban board can optionally split into horizontal lanes (swimlanes), grouped by one of two fields: assignee or priority. By default (no grouping) the board uses the usual 4-column layout, unchanged.

**Layout in grouped view:**

Each swimlane is a full-width band containing all 4 status columns (planned/in_progress/waiting/done), but only with cards belonging to that group. A 44px header bar precedes each lane:

- **Left side:** a 28px round avatar (assignee-type color + initial, or a priority-color marker with no text), followed by the bold name/priority label.
- **Right side:** a card-count badge (total cards in the lane across all statuses), followed by a chevron button (▼/▶) to collapse the lane.

The header uses `position: sticky` (both top and left), so it stays in view during both horizontal and vertical scrolling. A 2px dashed separator runs between lanes.

**Grouping key:**

- **By assignee:** based on the card's `assignee` field, matched case-insensitively against the `/api/kanban/assignees` list; unmatched or missing assignees fall into an "Unassigned" catch-all lane.
- **By priority:** based on the card's `priority` field (`urgent` > `high` > `normal` > `low` order).

Empty (cardless) swimlanes are not rendered.

**Persistence:**

The grouping choice is stored in `localStorage` (key `marveen.kanbanGroupBy`), so the user's last choice survives a page reload in that browser and overrides the `.env`-configured default. Lane-collapse state, by contrast, only lives in the page's in-memory state (cleared on reload), though it survives board refreshes (e.g. card moves, the 30-second auto-refresh).

**Drag and drop:**

The existing card-move logic (status + order) works in swimlane view too, per column -- a card can be dragged into a different status column within its own lane. Dragging into a different lane does not change the card's assignee/priority, only its status.

**Configuration keys (`.env`):**

```
KANBAN_SWIMLANE_DEFAULT_GROUP=none         # none (default) | assignee | priority
KANBAN_SWIMLANE_SEPARATOR_COLOR=           # empty = CSS default (var(--border))
```

Data flow: `src/config.ts` → `/api/marveen` (`kanbanSwimlanes` key) → `window._marveen.kanbanSwimlanes` (frontend). The frontend is static, no build step -- a server restart is enough to pick up config changes.

### Quick filters and labels

Cards can carry coloured labels, which both visually group the board and let you filter with a single click.

**Adding/removing a label**

Open a card, and in the detail view's "Labels" section:

- pick an existing label from the dropdown to attach it to the card,
- or create a new label (name + a colour from the offered palette),
- next to each attached label there's a button to remove it from the card.

**What do the pills at the bottom of a card mean?**

Each card shows up to 3 attached labels at the bottom as cool-toned "pills" (in `#label-name` form, in the label's own colour). If a card has more than 3 labels, the rest are shown as a "+N" badge. Clicking a pill immediately filters by it -- every other card carrying that same label also shows up in the filtered view.

**Filtering with the header chip row**

A chip appears in the toolbar above the board for every existing label, in its own colour, with a count (how many cards match the label given the other currently active filters). Clicking a chip activates it, narrowing the board to cards carrying that label. Multiple chips can be selected at once -- they combine with OR logic (a card matching any of the selected labels shows up). The × icon on an active chip removes that filter; the "Clear filters" button empties all active label filters at once.

**How does it combine with other filters?**

The label filter combines with the project and assignee filters using AND logic: a visible card must match the project filter, the assignee filter, AND at least one active label filter (if any are active). In swimlane view, lanes are built from the already-filtered card set, so the two features work together seamlessly.

Your chosen label filters persist in the browser, so you don't have to re-select them every time you open the board.

### Quick filters and labels -- technical details

**Data model:**

Labels live in their own registry (`labels` table: `id`, `name`, `color`, `created_at`), linked to cards through a join table (`kanban_card_labels`: `card_id`, `label_id`, `created_at`). This lets the same label appear on many cards and be recoloured/renamed in one place. Deleting a card or a label drops the join rows transactionally, so no orphaned associations are left behind.

A label's colour is not free text: it must be one of the entries in the `KANBAN_LABEL_COLORS` configuration palette (validated server-side; an invalid or missing value falls back to the first palette colour). This keeps the colour assignment traceable to a single configurable source instead of a hardcoded mapping in the code.

**API endpoints:**

```
GET    /api/kanban/labels              -- list all labels
POST   /api/kanban/labels              -- create a label ({ name, color })
PUT    /api/kanban/labels/:id          -- rename/recolour a label
DELETE /api/kanban/labels/:id          -- delete a label (+ all its card associations)
GET    /api/kanban/:id/labels          -- a card's labels
POST   /api/kanban/:id/labels          -- attach a label to a card ({ labelId })
DELETE /api/kanban/:id/labels/:labelId -- detach a label from a card
```

The board list endpoint (`GET /api/kanban`) embeds each card's `labels` array using a single bulk JOIN query (not an N+1 per-card lookup), so the footer pills get everything they need in one round trip.

**Card editor (CRUD UI):**

The card detail view's "Labels" section shows attached labels as removable pills, a dropdown adds an existing label, and an inline form creates a new one (name + palette swatch picker). A newly created label is attached to the open card immediately.

**Label quick-filter chip row:**

The toolbar above the board, right-aligned next to the project filter, shows one pill per defined label (from `/api/kanban/labels`), tinted in the label's own colour. Clicking a chip activates it (filled colour + × icon); multiple active chips combine with OR semantics -- this is the same `kanbanLabelFilter` set that the card footer pills also drive, just a second entry point into it. Each chip also shows a count: how many cards would match that label under the currently active project/assignee filters -- independent of whether the chip itself is active, so the number stays meaningful either way.

**Label footer pills (on the card):**

Each card's footer shows up to 3 of its attached labels as cold-toned pills (`#label-name`, in the label's own colour), with a non-clickable "+N" badge for the rest. Clicking a pill toggles that label into the same active label filter the header chip row uses.

**Filter-combination semantics:**

All filter dimensions combine with AND:

```
visible = project filter AND assignee filter AND (label1 OR label2 OR ...)
```

An empty label filter (no active label selected) doesn't narrow anything -- every card matches that dimension. The swimlane grouping renders from the already-filtered card set, so the quick filter and the swimlane view work together automatically, with no extra integration code. The "Clear filters" link in the toolbar (shown only when at least one label filter is active) empties the set.

**Persistence:**

The label filter is stored in `localStorage` (key `marveen.kanbanLabelFilter`, as a JSON array), the same way the swimlane grouping choice is -- it survives a page reload in that browser.

**Configuration keys (`.env`):**

```
KANBAN_LABEL_COLORS=#3b82f6,#0ea5e9,#10b981,#14b8a6,#8b5cf6,#64748b  # selectable palette (cold tones)
```

Data flow: `src/config.ts` → `/api/marveen` (`kanbanLabels.colors` key) → `window._marveen.kanbanLabels` (frontend).

---

## Related documents

- [Ideas (Idea box)](ideas.md) — from ideas to kanban cards (with AI breakdown)
- [Agent fleet](agent-fleet.md) — assignee agents, delegation
- [Heartbeat autonomy](heartbeat-autonomy.md) — kanban audit autonomy level
