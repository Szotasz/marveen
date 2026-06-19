#!/bin/bash
# Disk-space guard for the host (systemd --user timer, every minute).
#
# Incident it fixes (2026-06-03 dawn): the root filesystem filled to 100% from a
# 2.2G orphaned /tmp/health_* Apple Health export (the apple-health skill's
# scratch cleanup didn't run). A full root wedged the main session in a /mcp
# modal and every disk-touching watchdog gave false signals. This guard is the
# independent net: it reaps known-safe scratch BEFORE the disk fills, and when it
# can't recover it alerts the owner over the DIRECT Telegram Bot API (the in-session
# MCP plugin is dead under disk-full).
#
# Determinism + safety:
#   - Thresholds are constants at the top.
#   - Reaping is restricted to an explicit allowlist of scratch globs AND an age
#     guard, so a CURRENTLY-RUNNING export (recent mtime) is never deleted -- only
#     orphans are reaped. Never recurses outside the scratch dir.
#   - Alerts go via direct Bot API (token from channels/.env), never via MCP.
#   - Every stamp/log write is best-effort: under ENOSPC a failed write must not
#     wedge or crash the guard (that is the whole point).
#
# Test hooks (env, used only by scripts/__tests__/disk-space-guard.test.sh):
#   DISK_GUARD_USAGE_OVERRIDE   - use this usage% instead of df (integer)
#   DISK_GUARD_SCRATCH_DIR      - reap base dir (default /tmp)
#   DISK_GUARD_STATE_DIR        - cooldown-stamp dir (default <install>/store)
#   DISK_GUARD_REAP_MIN_AGE_MIN - override the reap age guard (minutes)
#   DISK_GUARD_ALERT_DRYRUN     - if 1, print "ALERT_DRYRUN: <msg>" not curl

set -u

# --- thresholds (tunable constants) ---
DISK_PATH="/"
REAP_THRESHOLD=90        # >= this %: reap safe scratch
ALERT_THRESHOLD=95       # >= this % (after reap): alert the owner directly
REAP_MIN_AGE_MIN="${DISK_GUARD_REAP_MIN_AGE_MIN:-30}"   # only reap orphans older than this
# Numeric-validate the age guard BEFORE use: a malformed env (e.g. "abc", "-1")
# OR literal 0 must NOT degrade into "reap everything" (-mmin +0 matches an
# in-progress export). Fall back to a very conservative day.
case "$REAP_MIN_AGE_MIN" in (''|0|*[!0-9]*) REAP_MIN_AGE_MIN=1440;; esac
ALERT_COOLDOWN=3600      # at most one disk-full alert per hour

# Explicit allowlist of scratch globs reaped under SCRATCH_DIR (maxdepth 1).
# Space-separated env override DISK_GUARD_REAP_GLOBS; the default targets the
# apple-health analysis scratch that caused the original incident. Extend
# deliberately -- every entry here is `rm -rf`-able once age-guarded.
if [ -n "${DISK_GUARD_REAP_GLOBS:-}" ]; then
  read -r -a REAP_GLOBS <<< "$DISK_GUARD_REAP_GLOBS"
else
  REAP_GLOBS=("health_*")
fi

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH_DIR="${DISK_GUARD_SCRATCH_DIR:-/tmp}"
STATE_DIR="${DISK_GUARD_STATE_DIR:-$INSTALL_DIR/store}"
ALERT_STAMP="$STATE_DIR/.disk-guard-alerted"
TG_ENV="$HOME/.claude/channels/telegram/.env"
LOG_TAG="disk-space-guard"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# Current usage% of DISK_PATH (0-100), or the test override.
disk_usage() {
  if [ -n "${DISK_GUARD_USAGE_OVERRIDE:-}" ]; then
    echo "$DISK_GUARD_USAGE_OVERRIDE"; return
  fi
  df -P "$DISK_PATH" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}'
}

# Reap age-guarded scratch matching the allowlist. Prints how many entries it
# removed. Defensive: only operates strictly under SCRATCH_DIR, maxdepth 1, and
# only on entries matching an allowlisted glob older than REAP_MIN_AGE_MIN.
reap_scratch() {
  local glob removed=0 path real
  [ -d "$SCRATCH_DIR" ] || { echo 0; return; }
  # HARD location guard: reaping is only ever allowed inside the system scratch
  # tree. Resolve symlinks and require the REAL path to be /tmp or
  # $XDG_RUNTIME_DIR (or a dir directly beneath them); refuse a symlinked
  # SCRATCH_DIR outright. A misconfigured/hostile DISK_GUARD_SCRATCH_DIR can then
  # never aim the reaper at real data.
  [ -L "$SCRATCH_DIR" ] && { echo 0; return; }
  # realpath is not on every host -> fall back to readlink -f, then `cd && pwd -P`.
  real="$(realpath "$SCRATCH_DIR" 2>/dev/null \
        || readlink -f "$SCRATCH_DIR" 2>/dev/null \
        || (cd "$SCRATCH_DIR" 2>/dev/null && pwd -P))"
  [ -z "$real" ] && { echo 0; return; }
  case "$real/" in
    /tmp/*) : ;;
    "${XDG_RUNTIME_DIR:-/nonexistent-xdg}"/*) : ;;
    *) echo 0; return ;;
  esac
  for glob in "${REAP_GLOBS[@]}"; do
    while IFS= read -r -d '' path; do
      # Guard: the path must live directly under SCRATCH_DIR (no traversal).
      case "$path" in
        "$SCRATCH_DIR"/*) : ;;
        *) continue ;;
      esac
      # A directory's own mtime does NOT change when files INSIDE it are written,
      # so a long-running export dir can look "old" by mtime while still active.
      # Skip a matched DIRECTORY if it contains ANY file newer than the age guard.
      if [ -d "$path" ] && [ ! -L "$path" ]; then
        if find "$path" -type f -mmin "-$REAP_MIN_AGE_MIN" -print -quit 2>/dev/null | grep -q .; then
          continue   # has a recently-written file -> in-progress, leave it
        fi
      fi
      rm -rf -- "$path" 2>/dev/null && removed=$((removed + 1)) || true
    done < <(find "$SCRATCH_DIR" -maxdepth 1 -name "$glob" -mmin "+$REAP_MIN_AGE_MIN" -print0 2>/dev/null)
  done
  echo "$removed"
}

# DIRECT-BOT-API alert (mirrors channel-watchdog.sh alert_owner). Bypasses MCP
# because under disk-full the in-session plugin cannot send.
alert_owner() {
  local msg="$1" token chat
  if [ "${DISK_GUARD_ALERT_DRYRUN:-}" = "1" ]; then
    echo "ALERT_DRYRUN: $msg"; return 0
  fi
  # Token + owner chat id both come from config, never hardcoded: token from the
  # channels env, chat id from .env ALLOWED_CHAT_ID (or TELEGRAM_CHAT_ID in the
  # channels env). If either is missing, skip the alert silently.
  # `tr -d '\r '` strips a trailing CR (CRLF-edited .env) / stray spaces so the
  # value doesn't corrupt the URL or the comparison.
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "ALERT (no bot token or owner chat id configured, could not Telegram): $msg"; return 1
  fi
  curl -s -m 10 -o /dev/null "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg}" \
    && log "owner alerted via direct Bot API" || log "ALERT sendMessage FAILED: $msg"
}

main() {
  local usage removed now last
  # Ensure the state dir exists UP FRONT so the cooldown stamp write below always
  # succeeds. Otherwise (missing STATE_DIR) the stamp never persists, `last` stays
  # 0 every tick, and a stuck-full disk re-alerts up to 60x/hour.
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  usage="$(disk_usage)"
  case "$usage" in (''|*[!0-9]*) log "could not read disk usage (got '$usage') -- no-op"; return 0;; esac

  if [ "$usage" -lt "$REAP_THRESHOLD" ]; then
    return 0   # plenty of room
  fi

  log "disk ${usage}% >= ${REAP_THRESHOLD}% -- reaping scratch under $SCRATCH_DIR"
  removed="$(reap_scratch)"
  log "reaped $removed scratch entr$( [ "$removed" = 1 ] && echo y || echo ies )"
  usage="$(disk_usage)"
  log "post-reap disk ${usage}%"

  if [ "$usage" -ge "$ALERT_THRESHOLD" ]; then
    # Cooldown so a stuck-full disk alerts at most once/hour (best-effort stamp).
    now="$(date +%s)"
    last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
    case "$last" in (''|*[!0-9]*) last=0;; esac
    if [ $(( now - last )) -ge "$ALERT_COOLDOWN" ]; then
      alert_owner "🔴 Disk space critical: ${DISK_PATH} is at ${usage}% after reaping ${removed} scratch item(s). Manual cleanup needed -- a full disk can wedge the channel session (deafness)."
      echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
    else
      log "disk ${usage}% critical but within alert cooldown ($(( now - last ))s) -- skip alert"
    fi
  fi
}

main "$@"
exit 0
