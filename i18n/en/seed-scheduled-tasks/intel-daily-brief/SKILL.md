---
name: intel-daily-brief
description: Proactive intelligence gatherer -- daily brief at 07:00 from the intel registry (store/intel.db). The counterpart of intel-collector; enable the two together.
---

# Proactive intelligence gatherer -- daily brief

> ⚠️ TEMPLATE: ships DISABLED by default (task-config.json: `"enabled": false`).
> Enable it together with the intel-collector task -- the brief is built from the
> registry that the collector fills.

## Loading the data

Run: `python3 {{INSTALL_DIR}}/scripts/intel_db.py --dump`
(JSON: registry for the last 14 days + watchlist + active_focus.)

## Priority Score (done by Claude, not by the collector)

For every Registry item: Relevance 40% + Urgency 25% + Impact on the owner
20% + Reliability (source tier) 15%. A low-confidence item: at most a
Watchlist mention; it does not go into the body of the brief.

## Brief format (Telegram, MarkdownV2)

```
📊 Today's state: Calm / Worth watching / Tense / Critical
⭐ Top 3 decision signals today: 1. ... 2. ... 3. ...

🟦 [DOMAIN NAME]
• What happened: [1 sentence, source + tier]
  → Why it matters: [...] → Impact: 🔴/🟠/🟢
  → What you can do: [action or "just watch it"]

🔍 Left out: X repeats · Y weak sources
👁 Watchlist: [...] 🎯 Active focus: [...]
```

Empty domain: leave it out entirely; do not write "no movement" lines.

## Sending

Telegram to the owner ({{OWNER_NAME}}) with the reply tool, in MarkdownV2 format.
These characters must be escaped: . - ( ) + = ! { } [ ] | ~ > #

## If the Registry is empty

Send: "📊 Morning brief: data collection is still initializing. The hourly
cycle will fill the Registry today." If it has been empty for 2+ days, report that the
intel-collector task is probably not running or not writing to the registry.
