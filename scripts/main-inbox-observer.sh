#!/bin/bash
# Out-of-process observer for the MAIN agent's inbox queue.
#
# THE HOLE IT COVERS. Every other delivery path in the fleet is watched by
# something: a sub-agent's queue is failed by the router after
# MESSAGE_ABANDON_WINDOW_MS and raises a handoff-failure notice. The main
# agent's queue is not. message-router.ts:539 `continue`s for MAIN *before* the
# abandon check (the PULL model: tmux-injecting the perpetually busy channels
# session once wedged delivery for ~1h), so a main-agent row is never failed and
# never reported. The only reader of getPendingMessages(MAIN_AGENT_ID) is
# inbox-nudge-watcher.ts -- and `graphify affected` puts that inside
# web.ts -> index.ts, i.e. the dashboard process itself. When that process is
# down or wedged, the watcher is down with it, and mail addressed to the main
# agent sits pending with nobody to notice.
#
# WHY A SEPARATE UNIT -- the two cheap in-tree candidates both failed their
# measurement:
#   1. the hourly heartbeat summary is a setTimeout in src/index.ts (initHeartbeat
#      from main()), i.e. the SAME process. It dies with the thing it would
#      report on.
#   2. scripts/watchdog.sh is architecturally external, but nothing in the
#      repository registers it: it needs a crontab entry, a launchd plist or a
#      systemd unit that no install step creates, and `graphify affected
#      scripts/watchdog.sh` finds no callers either. Its own logs/ directory,
#      which it mkdir -p's on every single run, is the cheapest way to tell that
#      it never ran. An observer put there would never fire, which is the same
#      defect as the router-tick watcher that was already measured and reverted
#      (f73f0c1, 887be1b).
# The one mechanism PROVEN to fire outside the dashboard process is the launchd
# StartInterval / systemd timer pair used by the channel keepalive probe: a
# registered unit that keeps advancing its own stamp file on its configured
# period, with a zero exit status, while the dashboard process is untouched.
# So this script is installed the same way
# (scripts/install-main-inbox-observer.sh, scripts/systemd/main-inbox-observer.*)
# and reads the queue the only independent way there is: SQLite, directly.
#
# It alerts over the DIRECT Bot API (scripts/lib/send-telegram.sh), never over
# /api/* or the MCP plugin -- both of those die with the process this observer
# exists to outlive.
#
# It also stamps store/.main-inbox-observer on EVERY run. Without that stamp the
# observer could quietly join watchdog.sh in never running, and its silence
# would be indistinguishable from a healthy queue.
#
# Usage:
#   scripts/main-inbox-observer.sh            # one tick (launchd/systemd)
#   scripts/main-inbox-observer.sh --check DB # evaluate DB, print, exit; no writes
#
# Exit codes of --check: 0 = ok, 1 = stalled, 2 = unknown (queue unreadable).
#
# Env:
#   MAIN_AGENT_ID                     - whose inbox to watch (default: .env, then marveen)
#   MAIN_INBOX_STALL_SECONDS          - stall threshold (default 1800)
#   MAIN_INBOX_OBSERVER_DB            - queue database (default <install>/store/claudeclaw.db)
#   MAIN_INBOX_OBSERVER_ALERT_DRYRUN  - if 1, print "ALERT_DRYRUN: <msg>" instead of sending

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE_DIR="$INSTALL_DIR/store"
DB_DEFAULT="$STORE_DIR/claudeclaw.db"
LIVENESS_STAMP="$STORE_DIR/.main-inbox-observer"
ALERT_STAMP="$STORE_DIR/.main-inbox-observer-alerted"
LOG_TAG="main-inbox-observer"

# One tick per 5 min against a 30-minute threshold: by then every in-process
# mechanism has had its full chance and failed. The nudge watcher gives up after
# MAX_STALE_NUDGES (3) spaced by STALE_NUDGE_COOLDOWN_MS (5 min) on top of its
# 55s start delay -- ~20 min at the outside -- so a row still pending at 30 min
# is not "the watcher is mid-retry", it is "nothing is coming".
STALL_SECONDS="${MAIN_INBOX_STALL_SECONDS:-1800}"
# A malformed or empty override must not silently disable the observer (0 would
# make every queue stalled, a non-number would make the comparison error out).
case "$STALL_SECONDS" in (''|0|*[!0-9]*) STALL_SECONDS=1800;; esac
ALERT_COOLDOWN=3600      # at most one inbox-stall alert per hour

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# The agent id lands inside a SQL string, so it is validated rather than
# escaped: an id is a tmux session name and a directory name in this fleet, so
# anything outside [A-Za-z0-9._-] is not a real id and must not reach sqlite3.
resolve_main_agent_id() {
  local id="${MAIN_AGENT_ID:-}"
  if [ -z "$id" ] && [ -f "$INSTALL_DIR/.env" ]; then
    id="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r "')"
  fi
  [ -n "$id" ] || id="marveen"
  case "$id" in
    *[!A-Za-z0-9._-]*) echo "" ;;
    *) echo "$id" ;;
  esac
}

# Read one row without writing to the queue. Two opens, in this order, because
# -readonly ALONE CANNOT READ THIS DATABASE IN THE ONE CASE THAT MATTERS: the
# queue is in WAL mode, and SQLite deletes the -wal/-shm pair when the last
# connection closes. A stopped dashboard therefore leaves a WAL-mode file with
# no -shm, and a -readonly open cannot create one -- measured 3/3 as
# "unable to open database file (14)", i.e. verdict=unknown exactly when the
# dashboard is down, which is the situation this observer exists for. Loud, but
# false. Positive control on the same file: the same query WITHOUT -readonly
# answers correctly, and with the -shm present -readonly answers correctly too,
# so the flag is the cause, not the file.
#
# So: try the strictly read-only open first (it is right whenever it works and
# cannot touch anything), and fall back to a normal open with query_only=ON.
# Measured on that fallback: content and mtime unchanged by the SELECT, and a
# DELETE through the same connection is refused with "attempt to write a
# readonly database (8)". It does create the -wal/-shm pair next to the file,
# which the next dashboard start uses as its own. If even the fallback fails
# (an unwritable directory, say), the caller keeps verdict=unknown -- honest,
# because at that point the queue really cannot be read.
read_queue_row() {
  local db="$1" sql="$2" out
  if out="$(sqlite3 -readonly -cmd '.timeout 3000' "$db" "$sql" 2>/dev/null)"; then
    printf '%s' "$out"
    return 0
  fi
  out="$(sqlite3 -cmd '.timeout 3000' "$db" "PRAGMA query_only=ON; $sql" 2>/dev/null)" || return 1
  printf '%s' "$out"
  return 0
}

# Evaluate one database. Sets PENDING / OLDEST_AGE / VERDICT, returns the exit
# code the --check contract promises. Reads only (see read_queue_row), and a
# missing file is an error instead of a freshly created empty database --
# "no such file" must never read as "nothing pending".
QUERY_PENDING=0
QUERY_OLDEST_AGE=0
QUERY_VERDICT=unknown
evaluate_queue() {
  local db="$1" agent="$2" row count oldest now
  QUERY_PENDING=0; QUERY_OLDEST_AGE=0; QUERY_VERDICT=unknown
  [ -n "$agent" ] || { log "MAIN_AGENT_ID is not a usable agent id -- refusing to query"; return 2; }
  [ -f "$db" ] || return 2
  row="$(read_queue_row "$db" \
    "SELECT COUNT(*), COALESCE(MIN(created_at),0) FROM agent_messages
      WHERE status='pending' AND to_agent='$agent';")" || return 2
  case "$row" in
    ''|*[!0-9\|]*) return 2 ;;
  esac
  count="${row%%|*}"; oldest="${row##*|}"
  case "$count" in (''|*[!0-9]*) return 2;; esac
  case "$oldest" in (''|*[!0-9]*) return 2;; esac
  now="$(date +%s)"
  QUERY_PENDING="$count"
  if [ "$count" = 0 ] || [ "$oldest" = 0 ]; then
    QUERY_OLDEST_AGE=0
  else
    QUERY_OLDEST_AGE=$(( now - oldest ))
    [ "$QUERY_OLDEST_AGE" -ge 0 ] || QUERY_OLDEST_AGE=0
  fi
  if [ "$count" -gt 0 ] && [ "$QUERY_OLDEST_AGE" -ge "$STALL_SECONDS" ]; then
    QUERY_VERDICT=stalled
    return 1
  fi
  QUERY_VERDICT=ok
  return 0
}

# Self-test hook: evaluate one database and exit before any alert, stamp or
# state write, so the contract can be tested from fixtures instead of requiring
# a live install with a bot token (scripts/__tests__/main-inbox-observer.test.sh).
if [ "${1:-}" = "--check" ]; then
  [ -n "${2:-}" ] || { echo "usage: main-inbox-observer.sh --check <db-path>" >&2; exit 2; }
  CHECK_AGENT="$(resolve_main_agent_id)"
  evaluate_queue "$2" "$CHECK_AGENT"; CHECK_RC=$?
  echo "pending=$QUERY_PENDING oldest_age_s=$QUERY_OLDEST_AGE threshold_s=$STALL_SECONDS agent=${CHECK_AGENT:-?} verdict=$QUERY_VERDICT"
  exit "$CHECK_RC"
fi

# DIRECT-BOT-API alert (mirrors disk-space-guard.sh alert_owner). Deliberately
# NOT the dashboard API: this observer exists for the case where that process is
# the thing that is down.
alert_owner() {
  local msg="$1" token chat tg_dir tg_env
  if [ "${MAIN_INBOX_OBSERVER_ALERT_DRYRUN:-}" = "1" ]; then
    echo "ALERT_DRYRUN: $msg"; return 0
  fi
  tg_dir="${TELEGRAM_STATE_DIR:-}"
  if [ -z "$tg_dir" ]; then
    tg_dir="$INSTALL_DIR/.claude/channels/telegram"
    [ -f "$tg_dir/.env" ] || tg_dir="$HOME/.claude/channels/telegram"
  fi
  tg_env="$tg_dir/.env"
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$tg_env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$tg_env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  # CHATID0: "0" is the installer placeholder, not a chat.
  [ "$chat" = "0" ] && chat=""
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "ALERT (no bot token or owner chat id configured, could not Telegram): $msg"; return 1
  fi
  # Honest send: curl exit 0 is not delivery (NOTIFYVAKSWEEP826). Only a
  # confirmed send may write the cooldown stamp.
  . "$(cd "$(dirname "$0")" && pwd)/lib/send-telegram.sh"
  local send_err
  if send_err="$(send_telegram_message "$token" "$chat" "$msg" 2>&1)"; then
    log "owner alerted via direct Bot API (delivery confirmed)"
    return 0
  fi
  log "ALERT sendMessage FAILED: ${send_err}"
  return 1
}

main() {
  local agent db rc now last minutes msg
  mkdir -p "$STORE_DIR" 2>/dev/null || true
  agent="$(resolve_main_agent_id)"
  db="${MAIN_INBOX_OBSERVER_DB:-$DB_DEFAULT}"
  evaluate_queue "$db" "$agent"; rc=$?
  now="$(date +%s)"
  # Liveness stamp on EVERY path, before anything can return early: this file is
  # the only way to tell "the queue is fine" apart from "the observer is not
  # running" -- the exact ambiguity that let watchdog.sh sit unnoticed at zero
  # runs. Best-effort: a failed stamp write must not wedge the tick.
  echo "$now $QUERY_VERDICT pending=$QUERY_PENDING oldest_age_s=$QUERY_OLDEST_AGE" \
    > "$LIVENESS_STAMP" 2>/dev/null || true

  if [ "$rc" = 0 ]; then
    # Spell over: drop the cooldown so the NEXT stall is reported at once
    # instead of serving out the rest of an hour that belonged to the last one.
    rm -f "$ALERT_STAMP" 2>/dev/null || true
    return 0
  fi

  last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
  case "$last" in (''|*[!0-9]*) last=0;; esac
  if [ $(( now - last )) -lt "$ALERT_COOLDOWN" ]; then
    log "verdict=$QUERY_VERDICT (pending=$QUERY_PENDING oldest_age_s=$QUERY_OLDEST_AGE) but within alert cooldown ($(( now - last ))s) -- skip alert"
    return 0
  fi

  if [ "$rc" = 2 ]; then
    msg="🔴 Main-agent inbox observer cannot READ the queue: $db (agent '${agent:-?}'). An unreadable queue is not an empty one -- inter-agent mail to the main agent may be piling up unseen."
  else
    minutes=$(( QUERY_OLDEST_AGE / 60 ))
    msg="🔴 Main-agent inbox stalled: $QUERY_PENDING message(s) pending for '${agent}', oldest ${minutes} min old (threshold $(( STALL_SECONDS / 60 )) min). Nothing inside the dashboard process reports this -- the router skips MAIN and the nudge watcher dies with the process. Check the channels session and the dashboard."
  fi
  log "$msg"
  if alert_owner "$msg"; then
    echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
  else
    log "alert not delivered -- cooldown stamp NOT written, will retry next tick"
  fi
}

main "$@"
exit 0
