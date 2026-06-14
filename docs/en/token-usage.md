# Token Usage Monitor

> Raw token consumption tracking per agent, per session, per time period.

---

## What it does / why it matters

Records every Claude Code API call's token usage: input, output, cache read, cache creation. Data is collected from Claude Code JSONL transcripts, stored in SQLite, and visualised on the dashboard as a timeline + detailed table.

Helps understand:
- Which agent consumes how much
- When peak periods occur
- Which tasks are most expensive (kanban correlation)
- Cache efficiency (cache read vs. creation ratio)

---

## Architecture

### Data collection (`src/web/token-usage.ts`)

1. **Agent discovery**: identifies agents from the `~/.claude/projects/` directory based on directory names (`-agents-NAME` pattern for sub-agents, `-MAIN_AGENT_ID` for the main agent).

2. **JSONL parsing**: recursively traverses project directories (including `subagents/` subdirs) and processes `.jsonl` files. Only considers `assistant` type messages that have a `usage` field.

3. **Cursor tracking**: stores the last processed line and file size per file (`token_usage_cursors` table). Unchanged files are skipped; modified files are continued from the last position.

4. **Deduplication**: `UNIQUE INDEX` on `(agent, session_id, timestamp, input_tokens, output_tokens)` + `INSERT OR IGNORE`. The same record is never stored twice.

### API endpoints (`src/web/routes/token-usage.ts`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/token-usage/collect` | POST | Collect new token data from JSONL files |
| `/api/token-usage/summary` | GET | Per-agent aggregated summary |
| `/api/token-usage/timeline` | GET | Timeline buckets (for charts) |
| `/api/token-usage` | GET | Detailed records (for table) |

### Query parameters

**Summary** (`/api/token-usage/summary`):
- `from` / `to`: Unix timestamp (epoch seconds)

**Timeline** (`/api/token-usage/timeline`):
- `bucket`: Bucket size in minutes (default: 60)
- `from` / `to`: Unix timestamp
- `agent`: Filter to one agent

**Details** (`/api/token-usage`):
- `agent`: Agent filter
- `from` / `to`: Unix timestamp
- `limit`: Max rows (default: 100, max: 500)
- `offset`: For pagination
- `min_tokens`: Minimum input token filter
- `q`: Free-text search (agent, tool_name, content_preview, task_title)

### Kanban correlation

The `correlateWithKanban()` function matches token usage to tasks using the `kanban_cards` table. It pairs by assignee and time interval, so the dashboard shows how many tokens each agent spent per task.

---

## DB schema

```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  content_preview TEXT,
  tool_name TEXT,
  task_title TEXT,
  project TEXT
);

CREATE UNIQUE INDEX idx_token_usage_dedup
  ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);

CREATE TABLE token_usage_cursors (
  file_path TEXT PRIMARY KEY,
  last_line INTEGER DEFAULT 0,
  last_size INTEGER DEFAULT 0
);
```

---

## claude.ai usage scraper

The dashboard fetches **real usage percentages** from claude.ai/settings/usage by connecting to an already-running Chrome instance via the Chrome DevTools Protocol (CDP). This bypasses bot-detection because we drive the user's own Chrome (already logged in) rather than launching a separate browser.

### Setup (one-time)

Start Chrome with a **dedicated profile** and the remote debugging port. Chrome 149+ ignores `--remote-debugging-port` on the default profile (security restriction), so a separate `--user-data-dir` is required.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.claude/chrome-cdp-profile" \
  --no-first-run
```

Sign in to claude.ai in the window that opens. The session is stored in `~/.claude/chrome-cdp-profile/` and reused on every subsequent scrape. You can leave this Chrome instance running in the background.

Optional: override the default endpoint with `CLAUDE_USAGE_CDP_URL` (default: `http://127.0.0.1:9222`).

### How it works

- The scraper connects to Chrome via CDP, finds or opens a tab at `/settings/usage`, waits for the `[role="progressbar"]` elements (this also covers any Cloudflare challenge that may run first), then extracts the two percentages and reset times.
- It runs **every 15 minutes** as a background poller in `src/web.ts`, plus once at startup (10-second delay).
- Results are cached in `store/claude-usage.json` (gitignored, 14-min TTL) so a dashboard restart does not trigger an immediate rescrape.
- `/api/claude-usage` serves cached data; `/api/claude-usage/refresh` triggers a one-off rescrape.
- If Chrome is not reachable at the CDP endpoint, the scraper logs an info message and returns null — no crash, no error shown to users.

### Security

- No credentials, cookies, or session tokens are written to code, logs, or git.
- The scraper only reads the usage page; it never modifies Chrome's profile.
- `store/claude-usage.json` is gitignored.

---

## Dashboard UI (`web/app.js` + `web/index.html`)

- **Summary cards**: per-agent total consumption (input/output/cache), call count, last activity
- **Timeline chart**: Canvas-based bar chart with dynamic bucket size (1h period = 5-min buckets, otherwise 1-hour)
- **Usage limit progress bars**: below the Timeline, two progress bars showing **real claude.ai percentages** — "Current session" and "Weekly / all models". Countdowns show when each resets. Data comes from the claude.ai scraper above; if unavailable, the card shows an "adat nem elérhető" state with setup instructions.
- **Sidebar widget**: the same progress bar pair in compact form at the bottom of the navigation sidebar (appears once data is loaded), with a countdown refreshed every 10 seconds.
- **Detail table**: individual API calls, time, agent, tool, token breakdown, content preview
- **Filters**: time period (1h/24h/7d/30d), agent card click
- **Collect button**: manual data collection trigger

All user-originated data (agent name, tool name, preview) passes through `escapeHtml()` for XSS protection.

---

## Limitations

- JSONL files live on the current machine; if Claude Code runs elsewhere those transcripts are not visible.
- Cursor tracking is file-size based: if a file gets shorter (truncated), the cursor resets and reprocessing starts — dedup prevents duplicates.
- Kanban correlation is heuristic: pairs by task time window, not exact session-to-task mapping.
