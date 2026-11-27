# Plan usage notice (QUOTANOTICE1126)

The fleet shares one Claude subscription (or a few). When its 5-hour or weekly window runs out, every agent on it
stops answering, and before this change nobody was told: the owner saw silence. `src/web/quota-notice.ts` runs in the
dashboard process every minute and costs no model tokens.

## What it does

The notice is **off by default**. Switch it on in the dashboard: Settings > Claude plans (`QUOTA_NOTICE`,
`QUOTA_NOTICE_PCT`, `QUOTA_PLAN_PROBE_MIN`). The keys are owner-gated: the shared fleet token cannot change them. They
are read every minute, no restart.

When a window reaches `QUOTA_NOTICE_PCT` (default 90), the owner gets one message on the install's owner channel (the
same route as other owner alerts, `notifyOwner`) with the subscription, the percentage and the local reset time. One
message per subscription and window: the window's reset instant is the key, so the next window re-arms it. The
threshold the window was announced at is kept too (`notifiedPct`): raising the threshold within the same window (back
to 90 after a test at 50) re-arms the notice, lowering it does not. A message that could not be delivered is tried
again on the next tick.

The notice only tells the owner. It sends nothing to the people who write to the agents, and it types nothing into
any agent's session.

## One notice per event: scripts/limit-monitor.sh

`scripts/limit-monitor.sh` (an operator-installed systemd `--user` timer; the repo ships no unit or installer for it)
alerts the owner on the same event for the **default** plan: it reads the statusLine numbers
(`store/.claude-rate-limits.json`) through `scripts/lib/quota-check.py` and alerts at its own `QUOTA_WARN_PCT`.
Without coordination the owner would get two messages. The rule, for the default plan only:

- **Already delivered:** limit-monitor writes `store/.limit-monitor-quota-state` only after a confirmed send. Its
  content is the HIT key of `quota-check.py`: `<kind>:<level>:<resets_at>` per hit window, joined by `|` (e.g.
  `five_hour:90:1795710000`). If an entry has our window's kind, a reset instant within 15 minutes of ours, and a
  level at or above `QUOTA_NOTICE_PCT`, our notice is dropped and the window recorded as notified (one log line:
  `default plan skipped, scripts/limit-monitor.sh already alerted the owner for this window`).
- **Active, not yet delivered:** limit-monitor counts as active when it ran in the last 30 minutes (the epoch in
  `store/.limit-monitor-heartbeat`, written on quiet runs, or the mtime of `store/limit-monitor.log`, written on every
  run that saw a signal). Then our notice is held for up to 15 minutes from the first tick that wanted to send it
  (one log line, `default plan held ...`), waiting for the stamp above. No stamp by then: ours is sent.
- **Not active** (no run in 30 minutes, or never installed): ours is sent at once.

Named plans are always notified by the dashboard: limit-monitor reads only the default plan's numbers.

Why 30 and 15 minutes: the repo has no timer for limit-monitor (searched 2026-11-27), so its interval is the
operator's choice and not knowable here. The two constants (`LIMIT_MONITOR_ACTIVE_MAX_AGE_SEC`,
`LIMIT_MONITOR_GRACE_SEC`) assume a tick of at most about 15 minutes. With a slower timer the worst case is two
notices for one event, never none.

### limit-monitor on an install without Telegram

limit-monitor can only send through the Telegram Bot API. When it finds no Telegram bot token (a Discord or Slack
install), it no longer drops the alert: it writes it into `store/owner-alert-outbox/<epoch>-<pid>-<tag>.txt` (temp
file + rename, mode 600, at most 4000 bytes) and counts it as handled, so its dedupe stamp is written and the rule
above works there too. The dashboard checks the outbox every minute (whether or not `QUOTA_NOTICE` is on: the files
only exist where limit-monitor runs), delivers each file through `notifyOwner`, and deletes it only after a confirmed
delivery; a failed delivery stays for the next minute. A file older than 24 hours is dropped with a log line. The
content is delivered as plain text, control characters removed, capped at 1900 characters (under Discord's limit).
With a Telegram token limit-monitor behaves as before, including its exit without an owner chat (`no ALLOWED_CHAT_ID`).
Without a Telegram token it no longer exits there: `ALLOWED_CHAT_ID` is a Telegram setting and is empty on a
Discord/Slack install, and the outbox needs no chat id.

## Per subscription (plan)

An install can register several Claude subscriptions (Settings > Claude plans) and point agents at them. The notice
names the subscription and fires once per subscription and window.

Where the numbers come from:

- **Default subscription** (the fleet token / host login): the fresher of the statusLine block
  (`store/.claude-rate-limits.json`), the observer mod's readings and the usage collector's `store/usage-latest.json`.
  On a setup-token install only the collector gives numbers: switch on the `usage-collect` scheduled task. The
  collector reads one token, the default one.
- **Named subscription**: `store/claude-plans-state.json`. The plan rotation writes it (the active plan's reading, and
  the live probe of idle token plans), and so does the per-plan probe below. A plan with no fresh numbers gets no
  percentage notice.

### Per-plan probe (`src/web/quota-plan-probe.ts`)

While `QUOTA_NOTICE` is on, every named **token-mode** plan is read every `QUOTA_PLAN_PROBE_MIN`
minutes (default 15, owner-gated) with the plan rotation's own probe (`probePlanUsage`): one Messages call
(`claude-haiku-4-5`, a 2-character prompt, `max_tokens: 5`) with the plan's own token from the vault, whose
rate-limit headers give the 5-hour and weekly used % and reset. The token is never logged. The result is recorded into
`claude-plans-state.json` like the rotation's probe. Cost: about 10 input + up to 5 output tokens per plan per probe,
from that plan's own quota (with 2 named plans at 15 minutes: 192 calls a day).

- Notice off (the default): no call.
- **Only active plans** (owner decision 2026-11-26): a plan is probed only when at least one agent running on it was
  active since the plan's last look. Active = the agent's transcript was written (newest `.jsonl` mtime in its
  transcript dirs, the same files channel-intake-monitor and inbound-probe read): every turn, tool call and channel
  message lands there. An idle plan is not probed and its last numbers age out. An agent that turns active after a
  long idle gets its plan probed on the very next tick (the interval counts from the last look).
- A plan looked at (by the rotation or this probe) within the interval is skipped.
- Backoff: 429 waits 4 intervals, a rejected token a day, any other error 2 intervals.
- configDir-mode plans are not probed (no token this code may read); the default plan is not probed (usage-collect
  covers it).
- A named plan's reading counts as fresh for two probe rounds (at least 45 minutes).

A stale or missing reading triggers nothing.

## Trying it safely

`QUOTA_NOTICE_DRY_RUN=1` logs every owner notice (`quota-notice DRY-RUN: ...` in the dashboard log) instead of
sending it; outbox files are logged once and kept for a real run. State lives in `store/quota-notice-state.json`
(an older file with an `autoReplies` list is read fine; the list is ignored and dropped on the next save).
