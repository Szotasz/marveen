# Deterministic conversation continuity (pending-message ledger)

**Problem.** The channel-watchdog respawns the channels session as a *fresh* claude
(`channels.sh`, no `--continue` — because `--continue` breaks `--channels`
activation). A fresh session has **zero memory** of the live conversation, so if
Gyula is mid-conversation when a respawn happens, his last unanswered question is
lost. This must be impossible to miss — guaranteed by a **deterministic harness**
(hooks + a durable ledger), never by agent behaviour (which can fail or restart).

**Mechanism (zero agent discretion).**

1. **Durable ledger** — `store/claudeclaw.db` → table `pending_messages`
   (`chat_id, message_id, text, ts, answered, answered_at, created_at`,
   `UNIQUE(chat_id, message_id)`). Created by the `db.ts` `initDatabase()`
   migration; `scripts/hooks/ledger_lib.py` re-creates it defensively too.
2. **Inbound capture** — `UserPromptSubmit` hook `scripts/hooks/ledger-capture.py`
   parses every inbound `<channel source="plugin:telegram:telegram" …>` block from
   the prompt and `INSERT OR IGNORE`s it `answered=0`, **before** the agent acts.
3. **Answered flip** — `PostToolUse` hook `scripts/hooks/ledger-answered.py` on the
   telegram reply tool flips the chat's open rows to `answered=1` (resolves the
   `chat_id=0` shorthand to the owner chat).
4. **Startup replay** — `SessionStart` hook `scripts/hooks/ledger-replay.py` injects
   any still-`answered=0` message as hidden `additionalContext` at the top of the
   fresh session's context: "MEGVÁLASZOLATLAN … válaszolj rá MOST". The agent does
   not need to *remember* to look — it's already in front of it.

**Scope.** Wire the hooks in the **project** `/home/marveen/marveen/.claude/settings.json`
(NOT user scope). The main channels session runs with cwd `/home/marveen/marveen`,
so it picks these up; sub-agents (Dia, Ernő bá) run from a different cwd and do NOT
— their separate-bot chats never enter Gyula's main ledger.

## settings.json block to add (`/home/marveen/marveen/.claude/settings.json`)

Merge this `hooks` object (the file currently has none). `$CLAUDE_PROJECT_DIR` is
substituted by Claude Code (→ `/home/marveen/marveen` for the main session).

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-capture.py\"", "timeout": 15 } ] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__plugin.telegram.telegram__reply", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-answered.py\"", "timeout": 15 } ] }
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
  replay is idempotent (no open rows → no-op).

**No systemd needed** — these are event-driven Claude Code hooks, not timers. The
hooks read `store/claudeclaw.db` via `python3` stdlib `sqlite3` (no node startup,
no `jq`). Take effect on the next session start after the settings change.

## Tests

- `bash scripts/__tests__/conversation-ledger.test.sh` — 17 cases (capture / answered
  / replay / idempotency / edges) against the real hooks, isolated via
  `LEDGER_DB_PATH` + `LEDGER_OWNER_CHAT`.
- `npx vitest run src/__tests__/conversation-ledger-schema.test.ts` — schema-drift
  guard (db.ts migration == ledger_lib.py).
