#!/bin/bash
# Single-flight launcher for a `claude --channels` poller.
#
# WHY: Telegram (and every channel provider) allows only ONE getUpdates poller
# per bot token. The main Boss session and each fleet agent each own a DISTINCT
# bot token, distinguished by TELEGRAM_STATE_DIR. The failure we guard against is
# TWO processes polling the SAME token at once -> HTTP 409 Conflict, inbound
# updates split randomly between them (the "two Boss sessions" bug).
#
# Multiple independent launch paths exist (systemd marveen-channels.service,
# channels.sh + its EPERM fallback, channel-watchdog.sh, stuck-modal-guard.sh,
# watchdog.sh, a manual VS Code start, /api/marveen/restart). None of them
# coordinated, so two could fire close together. This wrapper makes the bot
# token single-owner: every launch path routes through here and must hold a
# per-token advisory lock for the lifetime of the claude process.
#
# KEY DESIGN: the lock is keyed on the RESOLVED state dir, NOT global. Different
# tokens (main vs each agent) get different locks, so legitimate agents never
# block each other -- only a true same-token duplicate is refused.
#
# The lock is an flock(2) advisory lock tied to an open fd. When the holding
# claude dies, the kernel releases it automatically -- there is no stale-lock
# problem and nothing to clean up.
#
# -w timeout (not -n): a legitimate REPLACEMENT (e.g. respawn-pane -k kills the
# old claude, then relaunches) must wait briefly for the predecessor's fd to
# close, then acquire. A true concurrent DUPLICATE waits the timeout, fails to
# acquire, and exits without ever starting claude -> no second poller. If the
# legitimate owner never dies, the duplicate simply gives up: correct.
#
# Usage: replace `"$CLAUDE" --channels ...` with
#        `"$INSTALL_DIR/scripts/launch-channels-claude.sh" --channels ...`
# All claude args are passed through verbatim. Honors $CLAUDE if exported.

set -u

PROVIDER="${CHANNEL_PROVIDER:-telegram}"
STATE_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/$PROVIDER}"

# Lock lives inside the token's own state dir, so it is inherently per-token.
mkdir -p "$STATE_DIR" 2>/dev/null || true
LOCK_FILE="$STATE_DIR/.poller.lock"

LOCK_WAIT="${CHANNELS_LOCK_WAIT:-25}"

CLAUDE_BIN="${CLAUDE:-$(command -v claude 2>/dev/null || echo /usr/bin/claude)}"
FLOCK_BIN="$(command -v flock 2>/dev/null || echo /usr/bin/flock)"

# If flock is somehow unavailable, FAIL OPEN (launch claude unguarded) rather
# than break channels entirely -- a missing util-linux must never sever the
# Telegram lifeline. This is the one case we prefer the old (racy) behaviour.
if [ ! -x "$FLOCK_BIN" ]; then
  echo "$(date '+%F %T') [launch-channels] WARN flock not found, launching UNGUARDED" >&2
  exec "$CLAUDE_BIN" "$@"
fi

# flock -E 9 sets a distinct exit code (9) for "lock not acquired within -w",
# so a refused duplicate is distinguishable from claude's own exit codes in logs.
exec "$FLOCK_BIN" -w "$LOCK_WAIT" -E 9 "$LOCK_FILE" \
  bash -c '
    echo "$(date "+%F %T") [launch-channels] acquired poller lock '"$LOCK_FILE"' (token state dir: '"$STATE_DIR"')" >&2
    exec "$@"
  ' _ "$CLAUDE_BIN" "$@"
