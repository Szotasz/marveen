# Recall

> **Date-based retrieval** of daily logs and memories — with natural-language date expressions, filtering, and combined search.

---

## What it does / why it matters

Agents write every important event to the daily log and save context to the memory system. The Recall module lets you **retrieve these by date** — for a specific day, a time range, or combined with a keyword search.

Highlight: understands **Hungarian and English date expressions** naturally: `"tegnap"` (yesterday), `"múlt héten"` (last week), `"március 3"` (March 3), `"elmúlt 7 nap"` (last 7 days), `"2026-05-01 - 2026-05-15"`.

---

## API

### Retrieve by date

```
GET /api/recall?date=<expression>[&agent=<agent_id>][&q=<keyword>][&limit=50]
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `date` | Date expression (see below) | today |
| `agent` | Filter to a specific agent | all |
| `q` | Keyword filter (applied to logs + memories) | none |
| `limit` | Max items returned | 50 (max 200) |

If only `q` is provided without `date`: **full-text search** across all log entries and memories, regardless of date.

### Available dates list

```
GET /api/recall/dates?agent=<agent_id>[&limit=90]
```

Returns the dates (ISO date list) that have log entries — useful for a calendar view.

---

## Date expressions

### Relative days

| Expression | Meaning |
|------------|---------|
| `ma` / `today` | today |
| `tegnap` / `yesterday` | yesterday |
| `tegnapelőtt` | 2 days ago |
| `3 napja` / `3 days ago` | 3 days ago |
| `5 nappal ezelőtt` / `5 days ago` | 5 days ago |

### Weeks

| Expression | Meaning |
|------------|---------|
| `ezen a héten` / `this week` | Monday to today |
| `múlt héten` / `last week` | previous Monday through Sunday |
| `2 hete` / `2 weeks ago` | 2 weeks ago (full week) |
| `múlt hétfő` / `last monday` | most recent Monday |
| `előző szerda` / `last wednesday` | most recent Wednesday |

### Months

| Expression | Meaning |
|------------|---------|
| `ebben a hónapban` / `this month` | 1st through today |
| `múlt hónapban` / `last month` | previous full month |
| `március` / `march` | full month of March this year |
| `március 3` / `march 3` | March 3rd |
| `március második hét` | 2nd week of March |
| `március utolsó hét` | last week of March |
| `elmúlt 30 nap` / `last 30 days` | last 30 days |

### Exact dates

```
2026-05-03
2026-05-01 - 2026-05-15
```

---

## Response format

```json
{
  "dateRange": { "from": "2026-05-01", "to": "2026-05-31" },
  "logs": [
    {
      "id": 42,
      "agent_id": "jarvis",
      "content": "## 09:30 -- Morning digest\n...",
      "created_at": 1746091800,
      "created_label": "2026. május 1., 9:30:00"
    }
  ],
  "memories": [
    {
      "id": 17,
      "agent_id": "jarvis",
      "category": "warm",
      "content": "Jonas prefers concise answers...",
      "keywords": "preference, style",
      "created_label": "2026. május 1., 10:15:00"
    }
  ],
  "summary": {
    "logCount": 5,
    "memoryCount": 2,
    "agents": ["jarvis", "zack"]
  }
}
```

---

## Dashboard

On the **Dashboard > Recall** page the date expression can be typed as free text, and results are displayed in a timeline — log entries and memories side by side, colour-coded by agent.

---

## Examples

```bash
TOKEN=$(cat store/.dashboard-token)

# All events from yesterday (Jarvis)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?date=tegnap&agent=jarvis"

# Last week, filtered by keyword
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?date=mult+heten&q=kanban"

# March 5th
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?date=marc+5"

# Full-text search without a date
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?q=PR+review"

# Dates with entries (up to 90 days back)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall/dates?agent=jarvis"
```

---

## Related documents

- [Memory system](memory-system.md) — writing and reading memories
- [Daily log](memory-system.md#daily-log) — where log entries are stored
- [Agent fleet](agent-fleet.md) — list of agent_ids
