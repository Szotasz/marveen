# Memory System

> The assistant doesn't forget between messages. Layered memory with hybrid search that prioritises and forgets on its own — like human memory.

---

## 🎯 What it does / why it matters

Language models are "amnesiac" by default: every session starts with a blank slate. Marveen solves this with a **layered, self-cleaning memory** that mimics human memory:

- **hot** — what's happening NOW (active tasks, pending decisions)
- **warm** — stable knowledge (preferences, configuration, project context)
- **cold** — long-term lessons, historical decisions, archive
- **shared** — info relevant to other agents too

Memories go through **salience decay**: what hasn't been used in a while fades; what comes up often stays "at the front". Search is **hybrid** (keyword + semantic at the same time), and every evening a **daily log** is written — a human-readable summary of what happened that day.

**Highlight:** the agent doesn't "query a database" — it reads memory entries just like anything else in its context. The experience is natural: real remembering, not searching. All data is local (SQLite + local embedding), no cloud dependency, survives session restarts — what the agent has learned persists. On the dashboard it's also browsable as an Obsidian-style connection graph.

---

## 🛠 How it works

### Storage and tiers

SQLite (`store/`), FTS5 index. Each memory: content + tier + keywords + timestamps + optional 768-dim embedding.

| Tier | When | Example |
|------|------|---------|
| **hot** | active task, pending decision | "ongoing research" |
| **warm** | stable config, preference | "prefers brief replies" |
| **cold** | lesson, historical decision | "cache TTL of 5 min was optimal" |
| **shared** | other agents need it too | "the X API key is in the vault" |

Tier selection is automatic: task done → delete from hot + write to daily log; preference → warm; lesson → cold; multiple agents need it → shared.

### Hybrid search (FTS5 + Vector + RRF)

Search runs on two parallel channels, then fuses:

- **FTS5** — SQLite native full-text, exact word match, fast.
- **Vector** — every memory gets a 768-dim embedding on save (Ollama `nomic-embed-text`); cosine similarity ranks by meaning, not just words.
- **RRF (Reciprocal Rank Fusion, k=60)** — merging the two lists: `score(d) = Σ 1/(k + rank)`. Advantage: no need to normalise scores, only the rank order matters.

Ollama is optional — everything works without it, using FTS5 only.

### Salience decay

- First **7 days**: no decay.
- After 7 days: **0.5%/day** reduction (`salience * 0.995`).
- Minimum **0.01** — never deleted, just pushed to the background.
- On access: **+0.1 boost** (max 5.0) — frequently searched memories stay relevant.

The "gentle decay": old memories don't pollute search, but are always retrievable. The nightly [dream-engine](dream-engine.md) moves stale hot entries to cold (never deletes).

### Daily log

Append-only, per agent: automatic entries during the day + nightly summary at 23:00. Never modified — a chronological archive, fed into the morning digest.

### PreCompact hook (automatic save)

Before Claude Code compresses the context window, the `PreCompact` hook reviews the conversation, extracts important decisions/preferences/lessons, saves them to the appropriate tier, and writes a daily log entry — so nothing important is lost on compaction.

### Graph view + embedding backfill

The dashboard memory page shows a force-directed (HTML5 Canvas) graph: zoom/pan, search-highlight, click-to-expand panel, showing keyword connections between agents. Old memories without embeddings get vectors automatically (and manually via `POST /api/memories/backfill`).

### API

```bash
POST /api/memories                       # save (agent_id, content, tier, keywords)
GET  /api/memories?agent=&q=&tier=        # search (keyword)
GET  /api/memories/search?agent=&q=&hybrid=true   # hybrid (FTS5 + vector)
POST /api/daily-log                       # daily log (append-only)
POST /api/memories/backfill               # embedding backfill
```

```bash
# Date-based recall (see recall.md)
GET /api/recall?date=yesterday&agent=jarvis
GET /api/recall/dates?agent=jarvis
```

Zero-config: SQLite is created automatically, embeddings are generated on save.

---

## Related documents

- [Recall](recall.md) — date-based retrieval of log entries
- [Dream Engine](dream-engine.md) — nightly memory maintenance and reorganisation
- [Agent fleet](agent-fleet.md) — list of agent_ids
