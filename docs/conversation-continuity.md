# Deterministic conversation continuity (rolling-transcript ledger)

**Problem.** The channel-watchdog respawns the channels session as a *fresh* claude
(`channels.sh`, no `--continue` — because `--continue` breaks `--channels`
activation). A fresh session has **zero memory** of the live conversation, so if
Gyula is mid-conversation when a respawn happens, both his last unanswered question
**and the context it refers to** are lost. This must be impossible to miss —
guaranteed by a **deterministic harness** (hooks + a durable ledger), never by
agent behaviour (which can fail or restart).

**Mechanism (zero agent discretion).**

1. **Durable rolling transcript** — `store/claudeclaw.db` → table `conversation_log`
   (`id, agent_id, chat_id, direction('in'|'out'), message_id, text, ts, created_at`,
   `UNIQUE(agent_id, chat_id, direction, message_id)`). Every channel turn — inbound
   user messages AND outbound replies — is appended here. Created by the `db.ts`
   `initDatabase()` migration; `scripts/hooks/ledger_lib.py` re-creates it defensively
   too (a hook may run before the dashboard migration on a fresh boot).
2. **Inbound capture** — `UserPromptSubmit` hook `scripts/hooks/ledger-capture.py`
   parses every inbound `<channel source="plugin:telegram:telegram" …>` block from
   the prompt and `INSERT OR IGNORE`s it as `direction='in'`, **before** the agent
   acts. The `UNIQUE` constraint makes re-capture idempotent.
3. **Outbound capture** — `PostToolUse` hook `scripts/hooks/ledger-outbound.py` on the
   telegram reply tool records the reply text as `direction='out'` (resolves the
   `chat_id=0` shorthand to the owner chat). Outbound rows carry `message_id=NULL`, so
   they are never deduped against each other.
4. **Startup replay** — `SessionStart` hook `scripts/hooks/ledger-replay.py` injects
   hidden `additionalContext` at the top of the fresh session's context:
   - the **last N turns** of the transcript in chronological order, each prefixed
     `Gyula:` (inbound) / `Te:` (outbound), so the fresh session knows *what the
     conversation was about*;
   - a highlighted **OPEN QUESTION** — the most recent inbound with no later outbound
     ("NYITOTT KÉRDÉS … válaszolj rá MOST") — with its `chat_id` so the reply goes to
     the right chat.

   The agent does not need to *remember* to look — the context and the open question
   are already in front of it.
5. **Live-session drain** — `SessionStart` replay only fires on a *respawn*, but a
   message can also be lost in an **already-running** session (a mid-session
   deafness gap): capture still records it, yet the live session never sees it
   until the next respawn. `scripts/hooks/ledger-live-drain.py` (run every ~2 min
   by the `ledger-live-drain` scheduled task in the live session) re-surfaces the
   still-unanswered inbound — `OPEN_QUESTION chat_id=… message_id=…\n<text>` on
   stdout — so the running agent answers it without waiting for a respawn. Two
   safety rails: a **grace window** (`GRACE_SECONDS = 60` — never fight an in-flight
   reply) and a **dedup statefile** (`store/.ledger-drain-<agent_id>` — a missed
   question is surfaced once, not every tick). Never blocks (any error → exit 0,
   silent). NOT a settings.json hook — it is a heartbeat scheduled task whose
   prompt answers via the telegram reply tool only when a block is printed.

**Multi-agent scope.** The hooks are **generic across all channel agents**
(marveen / dia / erno-ba): `agent_id` is derived from the session's cwd
(`<install>/agents/<id>` → `<id>`; `<install>` → `MAIN_AGENT_ID`). Every read and
write is scoped by `agent_id`, so a session only ever replays its **own** chat and
agents never cross-contaminate.

**Tuning (env).**

- `LEDGER_CONTEXT_WINDOW` — number of recent turns to replay (default `20`). If the
  rendered window exceeds ~4000 tokens (`CONTEXT_CHAR_BUDGET = 16000` chars in
  `ledger-replay.py`), the **oldest** turns are dropped so injected context stays
  bounded.
- `LEDGER_OWNER_CHAT` / `ALLOWED_CHAT_ID` — resolves the reply tool's `chat_id=0`
  shorthand to the owner chat in `ledger-outbound.py`.
- `LEDGER_DB_PATH` — test-only DB path override.

## settings.json block to add (`/home/marveen/marveen/.claude/settings.json`)

Wire the hooks in the **project** settings (NOT user scope). The main channels
session runs with cwd `/home/marveen/marveen`, so it picks these up. The hooks
self-scope by cwd, so they are safe even if inherited. Merge this `hooks` object
(`$CLAUDE_PROJECT_DIR` → `/home/marveen/marveen` for the main session).

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-capture.py\"", "timeout": 15 } ] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__plugin.telegram.telegram__reply", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-outbound.py\"", "timeout": 15 } ] }
    ],
    "SessionStart": [
      { "matcher": "auto", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-replay.py\"", "timeout": 15 } ] }
    ]
  }
}
```

- `UserPromptSubmit` takes no matcher (fires on every prompt).
- `PostToolUse` matcher `mcp__plugin.telegram.telegram__reply`: the `.` are regex
  wildcards that match the sanitized tool name `mcp__plugin_telegram_telegram__reply`
  (the hook also double-checks `tool_name` contains `telegram`+`reply`).
- `SessionStart` matcher `auto`: fires on startup / resume / clear / compact — the
  replay is a no-op when the transcript is empty.

**No systemd needed** — these are event-driven Claude Code hooks, not timers. The
hooks read `store/claudeclaw.db` via `python3` stdlib `sqlite3` (no node startup,
no `jq`). Take effect on the next session start after the settings change.

## Tests

- `bash scripts/__tests__/conversation-ledger.test.sh` — 34 cases (inbound/outbound
  capture / replay context window / N-limit / chronological order + prefixes /
  open-question / answered-no-block / idempotency / multi-agent scope / live-drain
  grace + dedup + answered / edges) against the real hooks, isolated via
  `LEDGER_DB_PATH` + `LEDGER_OWNER_CHAT`.
- `npx vitest run src/__tests__/conversation-ledger-schema.test.ts` — schema-drift
  guard (db.ts migration == ledger_lib.py).
