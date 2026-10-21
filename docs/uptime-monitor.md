# Uptime monitor (website + embedded service)

`scripts/uptime-monitor.py` measures one or more websites and embedded services
every 5 minutes and alerts the owner over the **direct Telegram Bot API**
(`scripts/lib/send-telegram.sh`). It runs from a systemd `--user` timer, so it is
**independent of the dashboard**, the dashboard scheduler and the tmux sessions:
it still reports when those are down. Linux/systemd only.

What it does per run (the full contract is the script's docstring):

- **Measures** HTTP 200 plus the content signals of each target: part of the
  `<title>`, required text snippets, fields of a Next.js `__NEXT_DATA__`. There is
  no browser, so a client-rendered frame that loads empty is not visible to it.
- **Two strikes:** a target is alerted only if the first and a confirming
  measurement both fail. If in the confirming round no target and not the
  reference URL answers, the round is NOT MEASURABLE (no alert).
- **One alert per outage**, one recovery notice, and one notice when it has been
  unable to measure for `blind_notice_runs` runs in a row.
- Every text passes the outgoing-copy gate (`scripts/hooks/sender_check.py`).
- **Owner chat:** `scripts/lib/owner_chat.py` (the `.env` `ALLOWED_CHAT_ID`, else
  the single DM entry of the main channel's `access.json`), with
  `MARVEEN_ALERT_CHAT_ID` as an explicit override. The bot token is read from the
  main channel dir's `.env`.

Exit codes: `0` fine, `3` confirmed outage, `2` not measurable, `4` a send failed
or the send path (token, chat, helper, copy gate) is unusable, `1` internal or
config error. The unit treats `2` and `3` as success, so `1`, `4` and a timeout
start `OnFailure=marveen-notify@%n.service` (`scripts/unit-fail-notify.sh`).

## Configuration

Copy the example and edit it; the file is untracked and install-specific:

```bash
cp scripts/uptime-targets.example.json store/uptime-targets.json
```

Every target needs at least one content signal. The `reference` URL must not sit
behind the same CDN as the targets. The worst-case run time is checked when the
config loads (it must fit the unit's `TimeoutStartSec`); a config that does not
fit is refused with exit 1.

## Activation

The units are systemd **user** units. They carry three placeholders: replace
`/path/to/marveen` with your install dir, `/home/USER` with your home, and
`TZ=Europe/Budapest` with your own zone, before installing.

```bash
# 1. install the unit files (after editing the placeholders)
mkdir -p ~/.config/systemd/user
cp scripts/systemd/uptime-monitor.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
# 2. enable + start the timer
systemctl --user enable --now uptime-monitor.timer
# 3. keep user units running without a login session
loginctl enable-linger "$USER"
# 4. verify
systemctl --user list-timers | grep uptime-monitor
journalctl --user -u uptime-monitor.service -n 50
```

The measurement log is `store/uptime-log.jsonl`, the per-target state is
`store/uptime-state.json`.

## Tests

```bash
python3 scripts/__tests__/uptime-monitor.test.py   # hermetic: local HTTP server, local Bot API stub, mutant controls
```
