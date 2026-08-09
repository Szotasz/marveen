#!/bin/bash
# Mid-session stuck-modal guard for the main channels session (systemd --user
# timer, every minute).
#
# Incident it fixes (2026-06-03 dawn): a disk-full event left the main session
# wedged in a /mcp modal. A modal left open blocks the ENTIRE session -- inbound
# Telegram messages are lost while it sits there -- and nothing closed it until a
# human noticed. agent-context-guard.sh only watches the 1M-context credit wall,
# not a stuck modal. This guard closes that gap.
#
# Detection (grounded in src/pane-state.ts, the canonical classifier):
#   - IDLE  : pane shows the idle footer ("? for shortcuts" / "bypass
#             permissions on") -> healthy, never touched.
#   - BUSY  : pane shows a turn-scoped busy marker ("esc to interrupt" or the
#             "(Ns · ↓" token counter) -> legitimately working, never touched.
#   - STUCK : neither of the above. That is EXACTLY how channels.sh
#             ensure_modal_closed and channel-mcp-reconnect.ts define "modal
#             still open" -- the modal overlay hides the idle footer and there is
#             no live turn. We do NOT gate on an (unverified) modal-title string;
#             absence-of-healthy-markers is the proven contract.
#
# Safety against false positives:
#   - A STUCK pane must PERSIST for STUCK_SECONDS (the timer ticks every minute,
#     so this needs >= 2 consecutive stuck observations) before any action.
#   - 'esc to interrupt' + 'bypass permissions on' (a healthy working footer)
#     classify as BUSY/IDLE and are never disturbed.
#   - Recovery escalates gently: Escape (bounded, like ensure_modal_closed)
#     first; respawn-pane only if Escape can't reach the idle prompt.
#   - Respawn shares channel-watchdog.sh's respawn-grace stamp, so the two
#     watchdogs never double-respawn (no storm), plus its own consecutive cap.
#   - Stamp writes are best-effort (disk-full tolerance).
#
# Detection (extended):
#   - LIMITED: session usage-limit banner visible in the pane ("You hit your
#              session limit · resets Npm"). No idle/busy markers but the cause
#              is quota exhaustion, NOT a modal. Escape and respawn are useless;
#              only the quota reset clears it. The guard holds and alerts the
#              owner (rate-limited to once/hour) with the real reason + reset
#              time extracted from the pane.
#
# Modes (for tests; mirror the pure functions in src/pane-state.ts):
#   stuck-modal-guard.sh classify         < pane.txt   -> prints idle|busy|limited|stuck|empty
#   stuck-modal-guard.sh decide STATE FIRSTSEEN NOW     -> prints the action
#   stuck-modal-guard.sh                                -> run the guard live

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${STUCK_MODAL_STATE_DIR:-$INSTALL_DIR/store}"
FIRSTSEEN_STAMP="$STORE/.stuck-modal-firstseen"
RESPAWN_STAMP="$STORE/.channel-last-respawn"           # SHARED with channel-watchdog.sh
RESPAWN_COUNT_FILE="$STORE/.stuck-modal-respawns"
BACKOFF_STAMP="$STORE/.stuck-modal-backoff-alerted"
LIMIT_ALERTED_STAMP="$STORE/.stuck-modal-limit-alerted"
LIMIT_OVERDUE_STAMP="$STORE/.stuck-modal-limit-overdue-alerted"
LIMIT_OVERDUE_GRACE=600          # seconds past reset time before escalating
LIMIT_FALLBACK_SECONDS=21600     # 6 hours: cap when reset time is not parseable
TG_ENV="$HOME/.claude/channels/telegram/.env"
LOG_TAG="stuck-modal-guard"

STUCK_SECONDS="${STUCK_MODAL_SECONDS:-120}"   # must stay stuck this long before acting
# Validate: a non-integer override would make the `-ge` comparison error and
# short-circuit recovery. Fall back to the default.
case "$STUCK_SECONDS" in (''|*[!0-9]*) STUCK_SECONDS=120;; esac
GRACE_SECONDS=$(( 15 * 60 ))                   # shared respawn grace (matches watchdog)
MAX_CONSECUTIVE=3                              # respawns before backoff+alert
MAX_ESCAPES=4                                  # ensure_modal_closed bound
# Respawn target plugin: config-overridable so a non-default install (renamed or
# locally-built plugin) is never respawned with a WRONG plugin id -- a mismatch
# makes claude exit immediately while the alert would falsely say "respawned".
# %q-quoted at interpolation (like the model id), so a hostile value can't break
# out of the respawn shell-string.
RESPAWN_PLUGIN="${STUCK_MODAL_PLUGIN:-plugin:telegram@claude-plugins-official}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# --- pure classifier (mirrors src/pane-state.ts detectPaneState) ---------------
# Reads a captured pane on stdin; prints one of: empty | busy | idle | stuck.
classify_pane() {
  local pane
  pane="$(cat)"
  # 1. empty / whitespace-only -> inconclusive
  if [ -z "$(printf '%s' "$pane" | tr -d '[:space:]')" ]; then
    echo empty; return
  fi
  # 2. any busy marker anywhere -> busy (turn mid-flight)
  #    'esc to interrupt' footer, or the turn-scoped "(Ns · ↓" token counter.
  #    The counter separator may render as a Unicode middle-dot (·) OR an ASCII
  #    period depending on terminal/locale -- match BOTH, else a working pane is
  #    misread as STUCK and gets respawned mid-turn (dropping the live reply).
  if printf '%s' "$pane" | grep -qE 'esc to interrupt|\([0-9]+s (·|\.)'; then
    echo busy; return
  fi
  # 3. idle footer present -> idle (healthy prompt).
  #    Checked BEFORE the limit banner: if somehow both are visible (e.g. the
  #    limit text is in scrollback while the footer is live), the healthy state
  #    wins and the guard never sends Escape/respawn against a live session.
  if printf '%s' "$pane" | grep -qaF 'bypass permissions on' \
     || printf '%s' "$pane" | grep -qaF '? for shortcuts'; then
    echo idle; return
  fi
  # 4. session/usage limit banner -> limited (quota exhausted, NOT a modal).
  #    Observed text (bigme 2026-08-08): "You hit your session limit · resets 5:50pm".
  #    Additional canonical variants from src/model-fallback.ts USAGE_LIMIT_RX.
  #    The banner replaces the idle footer, so reaching here means no footer.
  if printf '%s' "$pane" | grep -qiE \
      'hit (your|the) (session|usage) limit|usage limit reached|[0-9]+-hour limit reached|limit will reset at|upgrade to increase your usage limit'; then
    echo limited; return
  fi
  # 5. neither -> the idle footer is hidden by a modal overlay and no live turn
  echo stuck
}

# --- pure decision (testable without tmux) -------------------------------------
# Args: STATE FIRSTSEEN_EPOCH NOW_EPOCH. Prints one of:
#   clear         -> pane healthy; drop any confirm window
#   hold          -> inconclusive (empty capture OR usage-limit); preserve confirm window
#   start-confirm -> first stuck observation; begin the confirm window
#   wait-confirm  -> stuck but not yet persisted long enough
#   act           -> stuck and persisted >= STUCK_SECONDS; recover now
decide_action() {
  local state="$1" firstseen="$2" now="$3"
  case "$state" in
    idle|busy) echo clear; return ;;
    empty)     echo hold;  return ;;
    limited)   echo hold;  return ;;   # quota exhaustion: Escape/respawn useless
    stuck)
      case "$firstseen" in (''|0|*[!0-9]*) echo start-confirm; return ;; esac
      if [ $(( now - firstseen )) -ge "$STUCK_SECONDS" ]; then echo act; else echo wait-confirm; fi
      return ;;
    *) echo hold; return ;;
  esac
}

# --- pure model-id sanitizer (testable) ----------------------------------------
# Keep only the model-id charset: letters, digits, . _ : - and the bracketed
# context-window suffix (e.g. "[1m]"). This strips shell metacharacters (quotes,
# $, backtick, ;, spaces) so the value is safe to interpolate into the respawn
# shell-string, while a legit "claude-opus-4-8[1m]" survives intact.
sanitize_model() {
  printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9._:[]-'
}

# --- portable file mtime (GNU stat -c / BSD stat -f / python3 fallback) --------
# Returns the Unix mtime of FILE, or 0 if unreachable. Never silent on failure.
stat_mtime() {
  local f="$1" result
  result="$(stat -c %Y "$f" 2>/dev/null)"
  [ -n "$result" ] && { echo "$result"; return; }
  result="$(stat -f %m "$f" 2>/dev/null)"
  [ -n "$result" ] && { echo "$result"; return; }
  result="$(python3 -c "import os; print(int(os.path.getmtime('$f')))" 2>/dev/null)"
  [ -n "$result" ] && { echo "$result"; return; }
  log "stat_mtime: all dialects failed for '$f' -- returning 0"
  echo 0
}

# --- parse reset epoch from pane text (pure, testable) -------------------------
# Reads pane text on stdin. Outputs the Unix epoch of the reset time printed on
# the pane (e.g. "resets 5:50pm" -> today's epoch at 17:50), or empty string if
# the reset time is absent or unparseable. Used to detect when the quota has
# already reset but the session is still showing the limit screen.
parse_reset_epoch() {
  local pane time_str
  pane="$(cat)"
  time_str="$(printf '%s' "$pane" \
    | grep -oiE 'resets? +[0-9]+(:[0-9]+)? *(am|pm)' | head -1 \
    | grep -oiE '[0-9]+(:[0-9]+)? *(am|pm)')"
  [ -z "$time_str" ] && { echo ""; return; }
  # Portable hh[:mm]am/pm -> epoch. Avoids GNU-only 'date -d'.
  # If any step fails the failure is logged explicitly rather than silently
  # folding into an empty return (which would be indistinguishable from "no
  # reset time present" and would suppress the overdue-detection path).
  local ts ampm digits hour min
  ts="$(printf '%s' "$time_str" | tr -d ' ')"
  ampm="$(printf '%s' "$ts" | grep -oiE '(am|pm)$' | tr '[:upper:]' '[:lower:]')"
  digits="$(printf '%s' "$ts" | grep -oE '^[0-9]+(:[0-9]+)?')"
  if [ -z "$digits" ] || [ -z "$ampm" ]; then
    log "parse_reset_epoch: unrecognised format '$time_str' -- returning empty"
    echo ""; return
  fi
  if printf '%s' "$digits" | grep -q ':'; then
    hour="${digits%%:*}"; min="${digits##*:}"
  else
    hour="$digits"; min=0
  fi
  case "$ampm" in
    pm) [ "$hour" -ne 12 ] 2>/dev/null && hour=$(( hour + 12 )) ;;
    am) [ "$hour" -eq 12 ] 2>/dev/null && hour=0 ;;
  esac
  if ! [ "${hour:-x}" -ge 0 ] 2>/dev/null || ! [ "$hour" -le 23 ] 2>/dev/null \
     || ! [ "${min:-x}" -ge 0 ] 2>/dev/null || ! [ "$min"  -le 59 ] 2>/dev/null; then
    log "parse_reset_epoch: out-of-range h=$hour m=$min from '$time_str' -- returning empty"
    echo ""; return
  fi
  # Today's midnight epoch: portable (date +%s and date +%H/%M/%S only)
  local now cur_h cur_m cur_s midnight_ep
  now="$(date +%s)"
  cur_h="$(date +%H)"; cur_m="$(date +%M)"; cur_s="$(date +%S)"
  midnight_ep=$(( now - 10#$cur_h * 3600 - 10#$cur_m * 60 - 10#$cur_s ))
  echo $(( midnight_ep + hour * 3600 + min * 60 ))
}

# --- overdue check (pure, testable) -------------------------------------------
# Args: RESET_EPOCH ANCHOR_EPOCH NOW_EPOCH
# ANCHOR_EPOCH is the time of first limit detection (LIMIT_ALERTED_STAMP mtime,
# or 'now' on the very first tick before the stamp exists).
# Midnight-rollover guard: if reset_ep < anchor the reset is actually tomorrow
# (e.g. "resets 1am" parsed at 19:00 gives today 01:00 < 19:00 → +86400).
# Prints 1 if the reset time has passed by >= LIMIT_OVERDUE_GRACE, else 0.
is_limit_overdue() {
  local reset_ep="$1" anchor="$2" now="$3"
  [ -z "$reset_ep" ] && { echo 0; return; }
  case "$reset_ep" in (''|*[!0-9]*) echo 0; return ;; esac
  # Roll forward to next day if reset looks like it's in the past relative to
  # when we first detected the limit (anchor). A fresh session limit always has
  # reset_ep >= anchor; if it's earlier the date has rolled over.
  [ "$reset_ep" -lt "$anchor" ] && reset_ep=$(( reset_ep + 86400 ))
  if [ $(( now - reset_ep )) -ge "$LIMIT_OVERDUE_GRACE" ]; then echo 1; else echo 0; fi
}

# --- session usage-limit notification (rate-limited to once/hour) --------------
alert_limited() {
  local pane_text="$1" now="$2"
  local bstamp=0
  [ -f "$LIMIT_ALERTED_STAMP" ] && bstamp="$(stat_mtime "$LIMIT_ALERTED_STAMP")"
  [ $(( now - bstamp )) -lt 3600 ] && return 0   # already alerted within the hour
  # Extract "resets Xpm" / "resets X:XXam" from the pane if present.
  local reset_str reset_info=""
  reset_str="$(printf '%s' "$pane_text" | grep -oiE 'resets? [0-9]+(:[0-9]+)?(am|pm)?' | head -1)"
  [ -n "$reset_str" ] && reset_info=", $reset_str"
  log "session usage limit hit${reset_info} -- holding (no Escape/respawn)"
  alert_owner "⏳ The ${SESSION} session hit its usage limit${reset_info}. This is NOT a /mcp modal -- auto-respawn would not help. The session will resume automatically when the quota resets. Messages sent during this window may be queued."
  date +%s > "$LIMIT_ALERTED_STAMP" 2>/dev/null || true
}

# --- overdue-limit alert: reset passed but session still frozen ----------------
# Rate-limited to once/hour. Called when parse_reset_epoch shows the reset time
# has already passed (+ LIMIT_OVERDUE_GRACE), or when the fallback 6-hour cap
# fires. After this, run_guard treats the state as 'stuck' so the normal
# Escape -> respawn path can actually recover the session.
alert_overdue_limit() {
  local pane_text="$1" now="$2"
  local bstamp=0
  [ -f "$LIMIT_OVERDUE_STAMP" ] && bstamp="$(stat_mtime "$LIMIT_OVERDUE_STAMP")"
  [ $(( now - bstamp )) -lt 3600 ] && return 0
  local reset_str reset_info=""
  reset_str="$(printf '%s' "$pane_text" | grep -oiE 'resets? +[0-9]+(:[0-9]+)? *(am|pm)?' | head -1)"
  [ -n "$reset_str" ] && reset_info=" ($reset_str)"
  log "session limit reset time passed${reset_info} but banner still visible -- escalating to stuck path"
  alert_owner "🔴 The ${SESSION} session's usage limit reset time has passed${reset_info} but the pane still shows the limit banner. The session did not auto-resume -- triggering recovery (Escape / respawn). If you messaged during the outage and got no reply, please resend."
  date +%s > "$LIMIT_OVERDUE_STAMP" 2>/dev/null || true
}

# --- direct Bot API alert (mirrors channel-watchdog.sh alert_owner) -------------
alert_owner() {
  local msg="$1" token chat
  # Token + owner chat id both from config, never hardcoded.
  # `tr -d '\r '` strips a trailing CR (CRLF-edited .env) / stray spaces.
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "ALERT (no bot token or owner chat id configured): $msg"; return 1
  fi
  curl -s -m 10 -o /dev/null "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg}" \
    && log "owner alerted via direct Bot API" || log "ALERT sendMessage FAILED: $msg"
}

# --- live guard ----------------------------------------------------------------
run_guard() {
  local TMUX_BIN CLAUDE MAIN_AGENT_ID SESSION pane state firstseen now action

  # NB: use TMUX_BIN, not TMUX -- the latter is tmux's own env var (socket,pid,
  # session); assigning the binary path to it corrupts server-socket detection.
  TMUX_BIN="$(command -v tmux)"; CLAUDE="$(command -v claude)"
  if [ -z "$TMUX_BIN" ]; then log "tmux not on PATH; cannot act"; return 0; fi

  # Ensure the state dir exists BEFORE any stamp/lock write. Without it, a cold
  # install / post-cleanup run fails `exec 9>` on the lock file; flock then reads
  # as "respawn in progress" and the guard defers recovery FOREVER -- exactly when
  # a modal is wedged (cross-model BLOCKER). Also covers the firstseen / backoff
  # stamp writes below.
  mkdir -p "$STORE" 2>/dev/null || true

  # Session name is config-driven, NO persona default baked in (review-mandated
  # contract, commit 0b7b671): CHANNELS_SESSION override wins; else
  # "<MAIN_AGENT_ID>-channels" from .env. If neither is set, skip -- we never
  # invent a persona-named target. (The sibling channel-watchdog.sh has a
  # pre-existing main-agent-id fallback; that is intentionally NOT mirrored here
  # and is out of scope for this guard.)
  SESSION="${CHANNELS_SESSION:-}"
  if [ -z "$SESSION" ]; then
    MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
    MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
    [ -n "$MAIN_AGENT_ID" ] && SESSION="${MAIN_AGENT_ID}-channels"
  fi
  if [ -z "$SESSION" ]; then
    log "no channels session configured (set CHANNELS_SESSION or MAIN_AGENT_ID in .env) -- no-op"; return 0
  fi
  "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null || { log "session $SESSION absent -- no-op"; return 0; }

  pane="$("$TMUX_BIN" capture-pane -t "$SESSION" -p 2>/dev/null || true)"
  state="$(printf '%s' "$pane" | classify_pane)"
  now="$(date +%s)"
  firstseen=0; [ -f "$FIRSTSEEN_STAMP" ] && firstseen="$(cat "$FIRSTSEEN_STAMP" 2>/dev/null || echo 0)"
  case "$firstseen" in (''|*[!0-9]*) firstseen=0;; esac

  # Session usage-limit: check whether the reset time has already passed.
  # If yes -> escalate (alert + fall through to the normal stuck path so
  # the session is actually recovered via Escape / respawn). If no -> hold.
  if [ "$state" = "limited" ]; then
    local reset_ep overdue anchor
    reset_ep="$(printf '%s' "$pane" | parse_reset_epoch)"
    # Anchor: time of first limit detection (stamp mtime), or now on first tick.
    anchor="$now"
    [ -f "$LIMIT_ALERTED_STAMP" ] && {
      local fs; fs="$(stat -c %Y "$LIMIT_ALERTED_STAMP" 2>/dev/null || echo 0)"
      [ "$fs" -gt 0 ] && anchor="$fs"
    }
    if [ -n "$reset_ep" ]; then
      overdue="$(is_limit_overdue "$reset_ep" "$anchor" "$now")"
    else
      # No parseable reset time: stamp-based 6-hour cap.
      overdue=0
      [ "$anchor" -lt "$now" ] \
        && [ $(( now - anchor )) -ge "$LIMIT_FALLBACK_SECONDS" ] \
        && overdue=1
    fi
    if [ "$overdue" = "1" ]; then
      alert_overdue_limit "$pane" "$now"
      state="stuck"   # engage Escape -> respawn recovery
    else
      alert_limited "$pane" "$now"
    fi
  fi

  action="$(decide_action "$state" "$firstseen" "$now")"
  case "$action" in
    clear)
      if [ "$firstseen" != 0 ]; then log "session healthy ($state) -- clearing confirm window"; fi
      rm -f "$FIRSTSEEN_STAMP" "$RESPAWN_COUNT_FILE" "$BACKOFF_STAMP" \
            "$LIMIT_ALERTED_STAMP" "$LIMIT_OVERDUE_STAMP" 2>/dev/null || true
      return 0 ;;
    hold)
      return 0 ;;
    start-confirm)
      log "STUCK candidate (no idle/busy markers) -- starting ${STUCK_SECONDS}s confirm window"
      echo "$now" > "$FIRSTSEEN_STAMP" 2>/dev/null || true
      return 0 ;;
    wait-confirm)
      log "stuck $(( now - firstseen ))s (< ${STUCK_SECONDS}s) -- still confirming"
      return 0 ;;
    act)
      log "STUCK modal confirmed ($(( now - firstseen ))s) -> Escape (max ${MAX_ESCAPES}x)" ;;
  esac

  # --- recovery: Escape (bounded), like ensure_modal_closed --------------------
  local i p
  for i in $(seq 1 "$MAX_ESCAPES"); do
    p="$("$TMUX_BIN" capture-pane -t "$SESSION" -p 2>/dev/null || true)"
    case "$(printf '%s' "$p" | classify_pane)" in
      idle|busy) log "modal closed via Escape -- session healthy"; rm -f "$FIRSTSEEN_STAMP" 2>/dev/null || true; return 0 ;;
    esac
    "$TMUX_BIN" send-keys -t "$SESSION" Escape 2>/dev/null || true
    sleep 0.5
  done
  p="$("$TMUX_BIN" capture-pane -t "$SESSION" -p 2>/dev/null || true)"
  case "$(printf '%s' "$p" | classify_pane)" in
    idle|busy) log "modal closed via Escape -- session healthy"; rm -f "$FIRSTSEEN_STAMP" 2>/dev/null || true; return 0 ;;
  esac

  # --- still stuck: respawn-pane (cross-watchdog coordination via grace stamp) --
  # NON-BLOCKING lock serialising CONCURRENT runs of THIS guard (so two ticks
  # can't both respawn). The actual cross-watchdog coordinator is the shared
  # .channel-last-respawn grace stamp checked below -- channel-watchdog.sh keys
  # off that, not this lock. If `exec 9>` fails we must NOT fall through: bash's
  # `flock -n 9` would then operate on fd 0 (stdin) and SUCCEED, silently
  # bypassing the lock -- so treat an open failure as "defer".
  exec 9>"$STORE/.channel-respawn.lock" || { log "cannot open respawn lock file -- deferring"; return 0; }
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || { log "another respawn in progress (lock held) -- deferring"; return 0; }
  fi

  if [ -f "$RESPAWN_STAMP" ]; then
    local last; last="$(stat -c %Y "$RESPAWN_STAMP" 2>/dev/null || echo 0)"
    if [ $(( now - last )) -lt "$GRACE_SECONDS" ]; then
      log "Escape failed but a respawn happened $(( now - last ))s ago (< grace) -- deferring"
      return 0
    fi
  fi
  local count; count="$(cat "$RESPAWN_COUNT_FILE" 2>/dev/null || echo 0)"
  case "$count" in (*[!0-9]*|'') count=0;; esac
  if [ "$count" -ge "$MAX_CONSECUTIVE" ]; then
    log "ALERT: stuck modal after $count respawns -- backing off, manual check needed"
    local bstamp=0; [ -f "$BACKOFF_STAMP" ] && bstamp="$(stat -c %Y "$BACKOFF_STAMP" 2>/dev/null || echo 0)"
    if [ $(( now - bstamp )) -ge 3600 ]; then
      alert_owner "🔴 The ${SESSION} session is stuck in a /mcp modal and ${count} auto-respawns did not clear it. Manual check needed: tmux attach -t ${SESSION}. Messages sent during the outage may be lost -- please resend."
      date +%s > "$BACKOFF_STAMP" 2>/dev/null || true
    fi
    return 0
  fi

  local MAIN_MODEL="" MODEL_FLAG="" CLAUDE_Q
  if [ -f "$INSTALL_DIR/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
    MAIN_MODEL="$(jq -r '.model // empty' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
  fi
  # W1: sanitize the model id before interpolating it into the respawn shell
  # string (defense in depth -- settings.json is local config). Preserves the
  # "[1m]" context suffix while stripping shell metacharacters.
  MAIN_MODEL="$(sanitize_model "$MAIN_MODEL")"
  # W1/I: %q-quote the (already-sanitized) model id too, so MODEL_FLAG stays safe
  # even if the sanitizer charset ever widens. Same treatment as CLAUDE_Q.
  [ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model $(printf '%q' "$MAIN_MODEL") "
  # W4: %q-quote the claude path so a path with spaces/specials can't break out
  # of the respawn command string.
  CLAUDE_Q="$(printf '%q' "$CLAUDE")"
  # W2: %q-quote the (config-overridable) plugin id, same treatment as the model.
  local PLUGIN_Q; PLUGIN_Q="$(printf '%q' "$RESPAWN_PLUGIN")"
  local RESPAWN_CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\" && $CLAUDE_Q --dangerously-skip-permissions ${MODEL_FLAG}--channels $PLUGIN_Q"

  log "stuck modal not cleared by Escape -- respawn-pane $SESSION (respawn #$((count+1)))"
  # G: alert ONLY after the respawn-pane actually succeeds, so a failed respawn
  # never sends the owner a false "respawned" message.
  if [ -n "$CLAUDE" ] && "$TMUX_BIN" respawn-pane -k -t "$SESSION" "$RESPAWN_CMD" 2>/dev/null; then
    date +%s > "$RESPAWN_STAMP" 2>/dev/null || true
    echo $(( count + 1 )) > "$RESPAWN_COUNT_FILE" 2>/dev/null || true
    rm -f "$FIRSTSEEN_STAMP" 2>/dev/null || true
    log "respawn-pane issued"
    alert_owner "⚠️ The ${SESSION} session was stuck in a /mcp modal -- auto-respawn #$((count+1)) issued. If you messaged during the outage and got no reply, please resend."
  else
    log "respawn-pane FAILED (or claude not on PATH) for $SESSION"
  fi
  return 0
}

case "${1:-}" in
  classify)           classify_pane ;;
  decide)             decide_action "${2:-}" "${3:-0}" "${4:-0}" ;;
  sanitize-model)     sanitize_model "${2:-}" ;;
  parse-reset-epoch)  printf '%s' "${2:-}" | parse_reset_epoch ;;
  is-overdue)         is_limit_overdue "${2:-}" "${3:-0}" "${4:-0}" ;;
  stat-mtime)         stat_mtime "${2:-}" ;;
  *)                  run_guard ;;
esac
exit 0
