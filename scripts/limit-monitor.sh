#!/bin/bash
# Claude usage-limit monitor (token-free, systemd --user timer).
#
# WHY bash and not a Claude scheduled-task: a Claude agent invocation itself
# consumes the very quota we're guarding. This runs as a plain shell script,
# greps for limit signals, and alerts the owner via the Telegram Bot API.
# Zero Claude tokens.
#
# Signals: rate-limit / usage-limit / 429 / "resets at" in the channels+dashboard
# logs AND in the live channels tmux pane (where Claude Code prints the limit msg).
# Dedupes via a state hash so the same event isn't re-alerted.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
STATE="$STORE/.limit-monitor-state"
LOG="$STORE/limit-monitor.log"

log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Install-specific values come from .env, never hardcoded: a renamed install
# (BOT_NAME/MAIN_AGENT_ID) has a differently named tmux session, and every
# install has its own owner chat. Resolved the same way as
# channel-keepalive-probe.sh so a rename moves both together.
env_val() { grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' '; }

MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

BOT_NAME="$(env_val BOT_NAME)"
BOT_NAME="${BOT_NAME:-$MAIN_AGENT_ID}"

CHAT_ID="$(env_val ALLOWED_CHAT_ID)"
if [ -z "$CHAT_ID" ]; then
  # No owner chat configured: there is nobody to alert, and guessing one would
  # send a quota warning to a stranger. Stay silent rather than misdeliver.
  log "no ALLOWED_CHAT_ID in .env, monitor cannot alert -- exiting"
  exit 0
fi

# Collect candidate text: recent log lines + live tmux pane
CANDIDATE="$(
  { tail -n 200 "$STORE/channels.log" "$STORE/channels.error.log" "$STORE/dashboard.log" 2>/dev/null;
    tmux capture-pane -t "$SESSION" -p 2>/dev/null;
  } | grep -iE "usage limit reached|reached your (usage|plan|weekly) limit|your limit will reset|approaching your usage limit|rate_limit_error|429 too many requests|quota exceeded|out of (usage|credits)" \
    | grep -viE "rate.?limit.?error class|no rate|within limit|limit-monitor|LIMIT-FIGYELMEZT|email/nap|req/nap|/nap free|kérés/hó|/hó\b|approaching\.\*limit"
)"

if [ -z "$CANDIDATE" ]; then
  # healthy: no signal. Touch a heartbeat so we know the monitor ran.
  echo "ok $(date +%s)" > "$STORE/.limit-monitor-heartbeat"
  exit 0
fi

# Dedupe: hash the signal; only alert if new. The stamp is written ONLY after
# a confirmed send (below): stamping up front buried every failed alert under
# its own dedupe -- the send failed, the hash said "already alerted", and the
# warning was lost forever, precisely during quota/network degradation
# (NOTIFYVAKSWEEP826, the worst row of the sweep).
HASH="$(printf '%s' "$CANDIDATE" | md5sum | awk '{print $1}')"
PREV="$(cat "$STATE" 2>/dev/null)"
if [ "$HASH" = "$PREV" ]; then
  log "signal unchanged, already alerted ($HASH)"
  exit 0
fi

# Alert the owner via Bot API (token-free path; no Claude invocation)
TOKEN="$(grep -oE '[0-9]+:[A-Za-z0-9_-]+' "$HOME/.claude/channels/telegram/.env" 2>/dev/null | head -1)"
SNIP="$(printf '%s' "$CANDIDATE" | head -3)"
MSG="⚠️ LIMIT-FIGYELMEZTETÉS ($BOT_NAME monitor)
A logokban/sessionben limit-jel jelent meg:

$SNIP

Lehet hogy közeledünk vagy elértük a Claude előfizetés keretét. Ha kell, ritkítom a heartbeatet vagy szünetet tartok. Nézd meg a sessiont ha tudod."
if [ -n "$TOKEN" ]; then
  # Honest send via the shared contract (curl exit 0 AND "ok":true); the
  # dedupe stamp is written ONLY on success so a failed alert retries on the
  # next timer tick instead of vanishing.
  . "$INSTALL_DIR/scripts/lib/send-telegram.sh"
  if send_telegram_message "$TOKEN" "$CHAT_ID" "$MSG" --data-urlencode "disable_web_page_preview=true" 2>>"$LOG"; then
    echo "$HASH" > "$STATE"
    log "ALERT sent to $CHAT_ID: $HASH"
  else
    log "ALERT send FAILED (will retry next tick, stamp NOT written): $HASH"
  fi
else
  log "ALERT wanted but no bot token found: $HASH"
fi
