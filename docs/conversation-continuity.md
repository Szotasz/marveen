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
   parses every inbound `<channel source="plugin:<provider>:<server>" …>` block from
   the prompt and `INSERT OR IGNORE`s it as `direction='in'`, **before** the agent
   acts. The `UNIQUE` constraint makes re-capture idempotent. The match is on the
   source *shape*, so **every** channel plugin (telegram, discord, slack, …) is
   captured into the same transcript.
3. **Outbound capture** — `PostToolUse` hook `scripts/hooks/ledger-outbound.py` on a
   channel plugin's reply tool records the reply text as `direction='out'` (resolves
   the `chat_id=0` shorthand to the owner chat). The hook accepts any
   `mcp__plugin_<provider>_<server>__reply` tool, but **`PostToolUse` matchers are not
   automatic — register one per installed channel plugin** (see the settings block
   below). A missing matcher is the silent-failure case described under
   *Provider coverage*.
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
      { "matcher": "mcp__plugin_telegram_telegram__reply", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-outbound.py\"", "timeout": 15 } ] },
      { "matcher": "mcp__plugin_discord_discord__reply", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-outbound.py\"", "timeout": 15 } ] }
    ],
    "SessionStart": [
      { "matcher": "startup|resume|clear", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-replay.py\"", "timeout": 15 } ] }
    ]
  }
}
```

- `UserPromptSubmit` takes no matcher (fires on every prompt).
- **One `PostToolUse` entry per installed channel plugin.** Drop the discord line if
  that plugin is not installed; add a line for any other channel plugin you run.

## Provider coverage — the silent failure to avoid

The transcript is only as complete as the set of channels it captures, and a
missing channel does **not** look like a failure. The replay still emits a
non-empty block from the channels that *are* captured, so a respawned session
reads what looks like a full history while the conversation that actually
matters is absent. An empty block invites suspicion; a full block from the wrong
channel reads as normal operation.

Check coverage by channel, not by row count:

```sql
SELECT chat_id, direction, COUNT(*), MAX(created_at)
FROM conversation_log GROUP BY chat_id, direction;
```

Every channel you actually converse on should appear, in **both** directions. If
your primary channel is missing, the inbound hook is not matching its envelope or
its reply tool has no `PostToolUse` matcher — continuity is not working for it,
however healthy the totals look.
- `PostToolUse` matcher `mcp__plugin.telegram.telegram__reply`: the `.` are regex
  wildcards that match the sanitized tool name `mcp__plugin_telegram_telegram__reply`
  (the hook also double-checks `tool_name` contains `telegram`+`reply`).
- `SessionStart` matcher `startup|resume|clear`: the matcher is a **regex over the
  `source` field**, whose only values are `startup` / `resume` / `clear` / `compact`.
  There is no `auto` source — an `"auto"` matcher silently matches nothing, so the
  replay never fires (this was the 2026-06-02 deafness-replay bug). `compact` is
  intentionally excluded: the compaction summary already preserves live context.
  The replay is a no-op when the transcript is empty.

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

## The `/clear` path (every agent, not just the channel ones)

The ledger above carries a **channel** conversation across a respawn. A `/clear`
is a different event with a different blast radius: it wipes the session in
place, and it used to be unprotected at **both** ends.

- **Nothing saved before it.** The `PreCompact` agent-hook (memory save, skill
  reflection, task-state) is wired to the *compact* path. A `/clear` does not
  fire `PreCompact`, so nothing wrote a record.
- **Nothing restored after it.** The harness restarts the session with
  `source=clear`, but the sub-agent `SessionStart` hook was registered on
  `compact|resume` and `REPLAY_SOURCES` in `agent-taskstate.ts` excluded
  `clear`, so the task-state replay stayed silent. `ledger-replay.py` handles
  `clear`, but it is wired in the **repo's project settings** only (the main
  agent) and a sub-agent's `conversation_log` is empty anyway unless its channel
  turns are being captured.

That gap also sat under the **context-restart gate**, which sends `/clear`
itself and then nudges the fresh session to read the restored blocks.

The pair that closes it:

| Hook | Event | Fires on | Does |
| --- | --- | --- | --- |
| `scripts/hooks/clear-capture.py` | `SessionEnd` | `reason == "clear"` | Extracts the owner's last prompts + the agent's last reply from the session transcript and writes `store/agent-clearstate/<agent>.json` |
| `scripts/hooks/clear-replay.py` | `SessionStart` | `source == "clear"` | Injects that record as `additionalContext`, then deletes it (single replay) |

Notes that matter when touching this:

- **`SessionEnd` is registered without a matcher on purpose.** The script filters
  on `reason` itself, so the wiring stays correct regardless of what the harness
  matches `SessionEnd` groups against. The reasons the harness emits are
  `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.
- **Agent resolution is stricter than the ledger's.** The main agent's hooks live
  in the user-global `~/.claude/settings.json`, so they fire for the owner's own
  Claude Code sessions in unrelated repositories too. `clearstate_lib.agent_id_from_cwd()`
  returns `None` for a cwd outside the install instead of falling back to the
  main agent, so an unrelated `/clear` elsewhere on the machine cannot write a
  record the real main agent then reads back as its own.
- **The injected block is deliberately non-directive.** A `/clear` can be a
  deliberate fresh start as easily as a gate-driven restart, and the hook cannot
  tell them apart. The block states what the previous thread was; the next
  prompt (the owner's, or the gate's wake nudge) decides what to do with it.
- **A matcher-only template change does not reach existing agents by itself.**
  `ensureAgentHooks()` dedupes on the exact command string, so the group is
  considered present and its stale matcher survives. `syncHookMatchers()` in
  `agent-scaffold.ts` is what carries a widened matcher onto the fleet.
