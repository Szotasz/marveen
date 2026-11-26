# Plan usage notices (QUOTANOTICE1126)

The fleet shares one Claude subscription. When its 5-hour or weekly window runs out, every agent stops answering,
and before this change nobody was told: the owner saw silence, and a person writing to an agent got no reply and no
reason. `src/web/quota-notice.ts` runs in the dashboard process every minute and costs no model tokens.

## What it does

Both parts are **off by default**. Switch them on in the dashboard: Settings > Claude plans (`QUOTA_NOTICE`,
`QUOTA_NOTICE_PCT`, `QUOTA_AUTOREPLY`, `QUOTA_AUTOREPLY_PCT`, `QUOTA_AUTOREPLY_GRACE_SEC`). The keys are owner-gated:
the shared fleet token cannot change them. They are read every minute, no restart.

1. **Owner notice** (`QUOTA_NOTICE`). When a window reaches `QUOTA_NOTICE_PCT` (default 90), the owner gets one
   message on the install's owner channel (the same route as other owner alerts, `notifyOwner`) with the percentage
   and the local reset time. One message per window: the window's reset instant is the key, so the next window
   re-arms it. A message that could not be delivered is tried again on the next tick.
2. **Channel auto-reply** (opt-in, `QUOTA_AUTOREPLY=1`). An agent counts as walled when its own pane shows the CLI's
   usage-limit banner, or when the shared plan is at `QUOTA_AUTOREPLY_PCT` (default 95) or more. Then every channel
   message that has stayed unanswered for `QUOTA_AUTOREPLY_GRACE_SEC` (default 120) gets one automatic reply from
   the agent's own bot: the quota is used up, it resets at the given time, the answer comes then. One reply per agent,
   chat and wall.
3. **Hand-back.** When the wall lifts and such a message is still unanswered, the dashboard types one short notice
   into the agent's session (`[KVOTA-VISSZATERES]` / `[QUOTA-RESUME]`, with chat id, message id and the quoted
   message as data), so the agent answers it without the sender writing again. A chat that got an answer meanwhile
   is closed without a hand-back.

Unanswered messages are read from the agent's own transcript (the channel envelope in, a `*__reply` tool call out),
so it works for every channel agent, not only those with the conversation ledger.

## Per subscription (plan)

An install can register several Claude subscriptions (Settings > Claude plans) and point agents at them. The notice
names the subscription and fires once per subscription and window; an agent's auto-reply uses the numbers of the
subscription THAT agent runs on (the rotation's active plan, else its `claudePlan`, else the default plan).

Where the numbers come from:

- **Default subscription** (the fleet token / host login): the fresher of the statusLine block
  (`store/.claude-rate-limits.json`), the observer mod's readings and the usage collector's `store/usage-latest.json`.
  On a setup-token install only the collector gives numbers: switch on the `usage-collect` scheduled task. The
  collector reads one token, the default one.
- **Named subscription**: `store/claude-plans-state.json`, which the plan rotation writes (the active plan's reading,
  and the live probe of idle token plans). Without rotation nothing refreshes it: such a plan gets no percentage
  notice, and its agents are judged by their own pane's limit banner only.

A stale or missing reading triggers nothing.

## Trying it safely

`QUOTA_NOTICE_DRY_RUN=1` logs every owner notice, auto-reply and hand-back (`quota-notice DRY-RUN: ...` in the
dashboard log) instead of performing it. State lives in `store/quota-notice-state.json`.

## Limits

- The 95 % threshold is a shared-plan reading: an agent on its own plan (per-agent `claudeConfigDir`) is judged by
  the shared plan's numbers unless its pane shows the banner.
- Between 95 % and the wall the agents still answer on their own; the auto-reply only fires for a message left
  unanswered for the grace period, so a working agent is not double-answered.
- Only the newest unanswered message per chat is replied to and handed back.
