# Telegram "working…" progress indicator

A lightweight, plugin-independent "the agent is working…" indicator for the
Telegram channel, plus a watchdog (sentry) that turns a stuck turn into a clear
error. Built entirely with Claude Code hooks + a standalone watchdog, so it
needs **no changes to the official telegram plugin** and survives plugin
updates.

## Why

When you message a Telegram-bridged agent there is no reliable signal about what
is happening: did the bot receive the message, is it thinking, or is it
stuck/offline? The plugin fires a one-shot `sendChatAction('typing')`, but
Telegram clears that after ~5s and the model usually thinks longer, so the
indicator vanishes and the user is left guessing.

A `typing…` action was rejected on purpose: it is dishonest (the model is
thinking, not typing) and it expires. This gives honest, unambiguous status:

1. Message received -> a visible `✍️ Dolgozom rajta…` placeholder appears.
2. Answer sent -> the placeholder disappears and the real reply lands as a
   fresh, notifying message.
3. Turn never completes (agent crashed / wedged / unreachable) -> the
   placeholder is rewritten into a clear error, so the user always gets
   **either an answer or an explicit failure**.

## How it works

Four small stdlib-Python pieces. Token + state dir are resolved exactly like the
plugin (honor `TELEGRAM_STATE_DIR`, else `~/.claude/channels/telegram`), so each
piece stays correct per-agent even with different bots.

| Piece | Trigger | Job |
|-------|---------|-----|
| `telegram_progress.py` | `UserPromptSubmit` hook | If the prompt contains a Telegram `<channel … chat_id … message_id>` block, post the placeholder and record its message id in a per-session state file. |
| `telegram_progress_reply_clear.py` | `PostToolUse` hook (matcher `telegram.*reply`) | Delete the placeholder(s) for the replied chat the instant a reply is sent. **Primary clear path.** |
| `telegram_progress_clear.py` | `Stop` hook | Delete any placeholder still recorded at turn end, **and enforce delivery** (see below). |
| `telegram_progress_watchdog.py` | launchd / systemd, ~60s | Scan every agent's per-agent state dir; for an orphan (the agent's `agent-<name>` tmux session is gone + older than a short grace, OR older than a generous "wedged" threshold) rewrite the placeholder via `editMessageText` into the error text. The only layer that can speak when the agent itself is down. |

### Why both PostToolUse and Stop

Originally the placeholder was cleared **only** at `Stop`. That breaks on a long,
multi-reply turn: if the agent emits several replies before the turn ends, the
original `Dolgozom rajta…` lingers for the whole (possibly very long) turn even
though the user already has an answer — it *looks* stuck. Clearing on the
`reply` tool (PostToolUse) makes the placeholder vanish exactly when the answer
appears; `Stop` is kept as a fallback and the watchdog as the crash backstop.

### Reply enforcement (the "answered only in the CLI" bug)

Goal #3 above — *the user always gets either an answer or an explicit failure* —
has one more failure mode the watchdog can't catch: the agent finishes normally
(so `Stop` fires) but never actually called the `reply` tool, so its answer lives
only in the CLI/transcript and the Telegram user sees nothing. The `Stop` hook
closes this: if a placeholder is still pending at turn end (= a Telegram turn
with no reply sent to that chat) it

1. **blocks the stop once** and instructs the agent to send its answer via the
   `reply` tool (the agent re-enters and replies properly, with its own
   formatting), and
2. if it *still* didn't reply after that single nudge, **delivers the agent's
   final answer** (last assistant message from the transcript) to the chat as a
   guaranteed fallback.

Loop-safe: a per-session `enforce-<sid>.marker` guarantees at most one block, and
`stop_hook_active` is honored. Turns that never had a Telegram placeholder
(plain CLI sessions, silent heartbeats) are untouched.

### Hardening

- **Dedup guard**: an atomic `O_EXCL` marker keyed by the inbound message id, so
  even if the hook is registered at two scopes (global + project, which Claude
  Code merges additively) it can never post a double placeholder.
- **Fleet-wide**: the hooks live in the global `~/.claude/settings.json`, so
  every existing and future agent gets it automatically; the watchdog scans all
  agents under `$MARVEEN_ROOT` (default `~/marveen`).

## Install

```bash
bash ~/ClaudeClaw/scripts/install-telegram-progress-hook.sh
```

It is idempotent and is auto-run by `scripts/sync-hooks.sh` on every update. It:

1. Copies the four hook scripts to `~/.claude/hooks/`.
2. Patches `~/.claude/settings.json` (UserPromptSubmit / PostToolUse / Stop).
3. Installs the watchdog as a **launchd** agent (macOS) or **systemd** user
   service+timer (Linux), running every ~60s.

## Tuning

- `telegram_progress_watchdog.py`: `DOWN_GRACE_SEC` (default 120s — agent down +
  placeholder older than this -> error) and `WEDGED_SEC` (default 15m — agent up
  but placeholder this old -> error).
- `MARVEEN_ROOT` env var overrides the fleet root the watchdog scans.

## Remove

Delete the four `~/.claude/hooks/telegram_progress*.py` files and their entries
in `~/.claude/settings.json`, then unload the watchdog
(`launchctl unload ~/Library/LaunchAgents/com.marveen.telegram-progress-watchdog.plist`
on macOS, or `systemctl --user disable --now marveen-telegram-progress-watchdog.timer`
on Linux).
