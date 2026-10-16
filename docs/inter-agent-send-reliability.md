# Inter-agent send reliability (verify + retry)

## The problem
Agents send inter-agent messages with `POST /api/messages`. A common shorthand is a `curl` whose output
is discarded and success inferred from the shell `&&`:

    curl -s ... -d @- <<HEREDOC >/dev/null && echo sent
    ...
    HEREDOC

This is **dangerous**: `curl` exits `0` on a completed HTTP request even when the server **rejected** it
(401 unauthorized, 400 bad body, 5xx), because `>/dev/null` discards the response and `&&` only checks
curl's exit code. The agent sees its own `echo sent` and believes the message went out. Result: a **silent
send failure** — the recipient never gets the message, and two agents can wait on each other indefinitely.

Observed in the field (2026-07): a sub-agent's completion callbacks were silently lost this way, costing
~30–60 minutes of an idle main+sub deadlock. The `/api/messages` router was healthy the whole time
(HTTP 200 + a message `id`); the defect was purely sender-side (never checking the result).

## The rule
**A message counts as sent only when the response returned an `id`** (`{"id":<n>,"status":"pending",...}`
with HTTP 200). Verify the HTTP status **and** the returned id, and resend if missing.

## The fix
- `scripts/agent-msg.sh <from> <to> "<content>"` — builds the JSON body with `json.dumps` (no quoting
  pitfalls), checks HTTP status + `id`, retries up to 3×, logs failures to `store/agent-msg-failures.log`.
  Large/multi-line content may come from STDIN with a `-` third arg. Base dir is auto-detected, port from
  `MARVEEN_WEB_PORT` (default 3420), so it runs from any CWD / any install.
- The generated agent `CLAUDE.md` (from `templates/CLAUDE.md.template`) now documents this rule and points
  at the helper, so every agent in every fleet verifies its sends by default.

## Belt-and-suspenders
For delegated tasks, pairing the callback with a **DONE-marker file** (written as the final step) lets the
orchestrator detect completion by file signal even if a callback is ever lost. But the primary fix is that
the sender must not treat an unchecked `curl` as success.

## Delivery to the MAIN agent: the one queue nothing inside the process watches

Everything above is about the *sender*. There is a second, independent gap on the *receiving* side, and it
exists only for the main agent.

A sub-agent's pending row is failed by the router once its session has been absent for the whole
`MESSAGE_ABANDON_WINDOW_MS` (1h) and the orchestrator gets a handoff-failure notice. The main agent's rows
never take that path: `message-router.ts` `continue`s for `MAIN` *before* the abandon check, on purpose
(the PULL model - tmux-injecting the perpetually busy channels session once wedged delivery for ~1h). The
only reader of `getPendingMessages(MAIN_AGENT_ID)` is `inbox-nudge-watcher.ts`, which lives inside
`web.ts -> index.ts`, i.e. the dashboard process. So when that process is down or wedged, the watcher is
down with it and mail to the main agent sits pending with nobody to notice.

Two cheap in-tree candidates were measured for the observer and both failed:

- the hourly heartbeat summary is a `setTimeout` in `src/index.ts`, the **same process**;
- `scripts/watchdog.sh` is architecturally external, but **nothing in the repository registers it**: it
  needs a crontab entry, a launchd plist or a systemd unit that no install step creates, so it can sit at
  zero runs indefinitely. Its own `logs/` directory, which it `mkdir -p`s on every run, is the cheapest
  way to tell that it never did.

The mechanism that *is* proven to fire outside the dashboard process is the scheduled-unit pair already
used by the channel keepalive probe: a registered unit that keeps advancing its own stamp file on its
configured period while the dashboard process is untouched. The observer is installed the same way:

    scripts/install-main-inbox-observer.sh --load     # macOS (launchd, every 300s)
    # Linux: scripts/systemd/main-inbox-observer.{service,timer}

Neither line is something an operator has to remember: `install-macos.sh` runs the launchd installer,
`install-linux.sh` writes and enables the systemd pair, and `update.sh` installs whichever of the two
belongs on a machine that already exists. A probe nobody schedules is the defect one level up from the
one this observer is about, so the installation is part of the fix rather than a note in a README. The
launchd installer refuses to run anywhere but Darwin: writing a plist that nothing reads and reporting
success is worse than failing, because the failure is what sends you to the systemd twin.

`scripts/main-inbox-observer.sh` reads the queue with `sqlite3` directly (the only path that does not go
through the dashboard). It opens `-readonly` first and falls back to a normal open with `query_only=ON`,
because `-readonly` **cannot read a WAL database whose `-shm` is missing** -- and SQLite deletes the
`-wal`/`-shm` pair when the last connection closes, so that is precisely the shape a stopped dashboard
leaves behind. Measured: `-readonly` fails there with *unable to open database file (14)*, i.e. the
observer would report `unknown` in the one situation it exists for; the fallback answers correctly and
still leaves the file byte-identical (a write through it is refused with error 8) and alerts over the **direct Bot API**, never `/api/*` - the API dies with the
process the observer exists to outlive. Defaults: alert when a row addressed to `MAIN_AGENT_ID` has been
pending for `MAIN_INBOX_STALL_SECONDS` (1800s), at most one alert per hour, and the cooldown is dropped as
soon as the queue drains so the next stall is reported at once.

Why 30 minutes: the in-process nudge watcher gives up after `MAX_STALE_NUDGES` (3) spaced by
`STALE_NUDGE_COOLDOWN_MS` (5 min) on top of its 55s start delay, so ~20 min is the outside of "the watcher
is still trying". A row still pending at 30 min means nothing is coming.

Checking the observer itself, from outside:

    cat store/.main-inbox-observer          # "<epoch> <verdict> pending=<n> oldest_age_s=<s>", rewritten every tick
    bash scripts/main-inbox-observer.sh --check store/claudeclaw.db   # 0 = ok, 1 = stalled, 2 = unreadable

The stamp is not decoration. Without it, an observer that stopped running is indistinguishable from a
healthy queue - which is exactly the failure mode that lets an unregistered watchdog sit at zero runs
unnoticed.
