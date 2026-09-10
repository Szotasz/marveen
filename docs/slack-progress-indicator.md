# Slack "working…" progress indicator

A Slack counterpart of [`telegram-progress-indicator.md`](telegram-progress-indicator.md):
a lightweight, plugin-independent "the agent is working…" indicator, plus a
watchdog (sentry) that turns a stuck turn into a clear error. Built entirely
with Claude Code hooks + a standalone watchdog, so it needs **no changes to
the Slack channel plugin** and survives plugin updates.

## Why

Slack's modern Web API (`chat.postMessage`) has no bot "typing…" bubble —
that only ever existed on the legacy RTM API (a `type: typing` websocket
frame), which new Slack apps have not been allowed to use for years. So the
official Slack channel plugin cannot show one either. The fix is the exact
same one already built for Telegram: post an honest, persistent placeholder
instead of a fake, expiring "typing" signal.

1. Message received -> a visible `✍️ Dolgozom rajta…` placeholder appears
   (in the same thread as the inbound message, if any).
2. Answer sent -> the placeholder is deleted and the real reply lands as a
   fresh `chat.postMessage` call.
3. Turn never completes (agent crashed / wedged / unreachable) -> the
   placeholder is rewritten into a clear error, so the user always gets
   **either an answer or an explicit failure**.

## Design choice: delete + repost, not edit-in-place

Slack has two ways to remove/replace the placeholder: `chat.update` (edit in
place) or `chat.delete` + a fresh `chat.postMessage`. This deliberately uses
**delete + repost for the real answer**, not edit-in-place:

- A `chat.update` edit does **not** push a notification in Slack (silent,
  no highlight/badge) — using it for the final answer would mean the user's
  answer arrives invisibly, same failure mode the Telegram doc rejected the
  "typing…" action for (looks fine in the log, useless in practice).
- `chat.postMessage` for the real answer always lands as a normal, notifying
  message.

`chat.update` is still used, deliberately, for the **watchdog's error
rewrite**: that is a backstop condition, not the normal path, so silence is
acceptable there (the placeholder itself already got the user's attention).

## How it works

Four small stdlib-Python pieces, mirroring the Telegram set exactly. Token +
state dir are resolved exactly like the plugin: `SLACK_STATE_DIR` if set
(per-agent), else the install-scoped `<install>/.claude/channels/slack` once
it holds the `.env` (#915), else the legacy shared `~/.claude/channels/slack`.
So each piece stays correct per-agent.

| Piece | Trigger | Job |
|-------|---------|-----|
| `slack_progress.py` | `UserPromptSubmit` hook | If the prompt contains a Slack `<channel … source="plugin:slack-channel:slack" chat_id … >` block, post the placeholder (in-thread via `thread_ts` if present) and record its `ts` in a per-session state file. |
| `slack_progress_reply_clear.py` | `PostToolUse` hook (matcher `slack.*reply`) | Delete the placeholder(s) for the replied `(chat_id, thread_ts)` the instant a reply is sent. **Primary clear path.** |
| `slack_progress_clear.py` | `Stop` hook | Delete any placeholder still recorded at turn end, **and enforce delivery** (same one-nudge-then-fallback contract as the Telegram Stop hook). |
| `slack_progress_watchdog.py` | launchd / systemd, ~60s | Scan every agent's per-agent state dir; for an orphan (agent down + placeholder old, OR a hung reply-tool call, OR a generic wedged backstop) either deliver the recovered answer for real, or rewrite the placeholder into the error text via `chat.update`. |

### Why match on `(chat_id, thread_ts)`, not just `chat_id`

Telegram's `chat_id` already identifies a single DM or group, so matching on
it alone is precise. A Slack **channel** can have several concurrent threads
in flight, each with its own placeholder — matching on `chat_id` alone in the
reply-clear hook could delete the wrong thread's placeholder. The reply-clear
hook therefore matches on the pair.

### Reply enforcement

Same contract as Telegram: if the turn ends with a placeholder still
pending, the `Stop` hook blocks once and instructs the agent to call the
Slack `reply` tool properly; if it still doesn't, the agent's last transcript
answer is delivered as a guaranteed fallback via `chat.postMessage`.

### Watchdog guards (TGORPHAN908, shared with Telegram)

- **Stale upper bound**: a placeholder older than 24h (`SLACK_WATCHDOG_STALE_SEC`)
  marks a dead round, not a stuck one. Nothing is delivered; the marker is
  dropped and the placeholder message deleted. Without this, a fleet restart
  after a long outage walked weeks-old orphans into the backstop and posted
  internal work logs to the owner's channel.
- **Round-scoped answer**: the recovered answer is read only from the round
  that posted the placeholder (anchored on the timestamped user prompt at the
  marker's mtime), never from a later internal turn's text.
- **Already delivered**: if that round's own `reply` call did return a result,
  the marker is leftover bookkeeping — the placeholder is cleared silently,
  nothing is resent.

## Install

```bash
bash ~/ClaudeClaw/scripts/install-slack-progress-hook.sh
```

Idempotent, auto-run by `scripts/sync-hooks.sh` on every update (any
`scripts/install-*-hook.sh` is picked up automatically). It:

1. Copies the four hook scripts to `~/.claude/hooks/`.
2. Patches `~/.claude/settings.json` (UserPromptSubmit / PostToolUse / Stop).
3. Retires the Telegram progress plumbing (`scripts/retire-progress-watchdog.sh telegram`)
   so exactly one provider's indicator is live. The Telegram installer does
   the same in reverse; `scripts/doctor.sh` warns about drift between
   `CHANNEL_PROVIDER` and the wired hooks/timers.
4. Installs the watchdog as a **launchd** agent (macOS) or **systemd** user
   service+timer (Linux), running every ~60s.

### The PostToolUse matcher

The default matcher is the loose regex `slack.*reply`: it matches the real
reply tool name `mcp__plugin_slack-channel_slack__reply` regardless of the
exact plugin id, mirroring the Telegram matcher `telegram.*reply`. If a given
install needs a stricter or different matcher, override before installing:

```bash
SLACK_REPLY_TOOL_MATCHER='mcp__plugin_<your-id>_slack__reply' \
  bash scripts/install-slack-progress-hook.sh
```

The hook scripts themselves are more forgiving than the matcher: they only
check that the tool name contains `slack` and `reply`, so a slightly-off
matcher still degrades gracefully (the PostToolUse hook simply won't fire,
leaving the Stop hook and watchdog as backstops) instead of erroring.

## Language

The user-facing texts (the placeholder, the watchdog's error rewrite) and the
Stop hook's block instruction come in Hungarian and English. Resolution, per
hook run: `MARVEEN_LANG` env if set, else the install's `.lang` file (written
by `install.sh` at the install root, found by walking up from the agent's state
dir), else `hu`. Values: `hu`, `en`.

## Tuning

- `slack_progress_watchdog.py`: `DOWN_GRACE_SEC` (default 120s), `WEDGED_SEC`
  (default 15m), `SLACK_WATCHDOG_WEDGED_UP_SEC` (default 180s for a detected
  hung reply-tool call), `SLACK_WATCHDOG_STALE_SEC` (default 24h upper bound).
- `MARVEEN_ROOT` env var overrides the fleet root the watchdog scans.
- `SLACK_API_BASE` overrides the Slack Web API base (tests point it at a
  local stub); defaults to `https://slack.com/api`.

## Tests

```bash
bash scripts/__tests__/install-slack-progress-hook.test.sh
bash scripts/__tests__/slack-watchdog-wedged.test.sh
bash scripts/__tests__/retire-progress-watchdog.test.sh
```

## Remove

```bash
bash scripts/retire-progress-watchdog.sh slack --force
```

This unwires the four hooks from `~/.claude/settings.json` and stops +
removes the watchdog daemon (launchd agent on macOS, systemd user timer on
Linux). The hook files under `~/.claude/hooks/` are left in place; they are
inert once unwired.
