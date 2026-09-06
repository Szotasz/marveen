#!/bin/bash
# Token-free GitHub PR reaction monitor.
# Polls our own open PRs on the configured repo and sends a Telegram
# alert (Bot API, NO Claude tokens) whenever a PR's state changes: new review,
# new comment, review decision, or merge/close. Baselines silently on first run.
#
# Runs under a systemd --user timer. gh auth via GH_TOKEN from the fleet PAT so
# it does not depend on the interactive keyring.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

# Upstream repo and the PRs to watch are both derived, not hardcoded: a fork
# has a different slug, and a fixed PR list goes stale the moment one merges.
# GITHUB_PR_MONITOR_REPO / _PRS override either, for a fork watching upstream.
REPO="${GITHUB_PR_MONITOR_REPO:-}"
if [ -z "$REPO" ]; then
  REPO="$(git -C "$INSTALL_DIR" config --get remote.upstream.url 2>/dev/null \
       || git -C "$INSTALL_DIR" config --get remote.origin.url 2>/dev/null || true)"
  # git@host:owner/repo.git and https://host/owner/repo.git both reduce to owner/repo
  # Two passes on purpose: ERE has no lazy quantifier, so `[^/]+?` is NOT
  # non-greedy here -- it swallows the trailing ".git" and the optional
  # `(\.git)?` group then matches empty. Measured 2026-08-24: an https
  # upstream URL yielded "owner/repo.git", and `gh pr list --repo owner/repo.git`
  # returns an EMPTY list with exit 0, so the monitor reported "nothing to
  # watch" forever instead of failing loudly. Strip the suffix separately.
  REPO="$(printf '%s' "$REPO" | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##')"
fi
STATE_FILE="store/.github-pr-monitor-state"

# --- creds ---------------------------------------------------------------
# GH_TOKEN from the encrypted vault (software rule: secrets live in the vault,
# not in plaintext token files). Resolved in-memory via vault-resolve.mjs; the
# value is never written to disk or logged.
# PATH first (a systemd --user timer inherits a thin PATH, hence the fallbacks;
# ~/.local/bin covers the nvm-less per-user install this runs under).
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -n "$NODE_BIN" ]; then
  GH_TOKEN="$(printf 'GH_TOKEN=github-fleet-token\n' | "$NODE_BIN" "$INSTALL_DIR/scripts/vault-resolve.mjs" 2>/dev/null | cut -d= -f2- || true)"
fi
# Legacy fallback: the plaintext file, if the vault could not resolve (e.g. dist
# not built or node missing). Safe to keep even after the loose file is removed.
if [ -z "${GH_TOKEN:-}" ] && [ -f store/.github-fleet-token ]; then
  GH_TOKEN="$(cat store/.github-fleet-token)"
fi
[ -n "${GH_TOKEN:-}" ] && export GH_TOKEN || echo "WARN: no GH_TOKEN (vault+file both empty), gh calls may fail" >&2
BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '"'"'"' ')"
CHAT_ID="$(grep -E '^ALLOWED_CHAT_ID=' .env | cut -d= -f2- | tr -d '"'"'"' ')"

send_telegram() {
  local text="$1"
  if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
    echo "send_telegram: no BOT_TOKEN/CHAT_ID configured, alert skipped" >&2
    return 0
  fi
  # Honest send (NOTIFYVAKSWEEP826): the old fire-and-forget curl let a failed
  # alert vanish while the state snapshot below marked the change as reported.
  . "$(cd "$(dirname "$0")" && pwd)/lib/send-telegram.sh"
  send_telegram_message "$BOT_TOKEN" "$CHAT_ID" "$text" \
    --data-urlencode "disable_web_page_preview=true"
}

# --- fetch current signatures -------------------------------------------
# Signature per PR: state|reviewDecision|#reviews|#comments|lastActor
CUR=""
# Watch whatever of ours is actually open right now. A hardcoded list stops
# covering new PRs the day it is written, and keeps polling merged ones forever.
PRS="${GITHUB_PR_MONITOR_PRS:-}"
LIST_RC=0
LIST_ERR=""
if [ -z "$PRS" ]; then
  # A FAILED `gh pr list` and a genuinely empty list both used to reduce to an
  # empty PRS, and the script then said "nothing to watch" and exited 0 -- a
  # silent zero (expired auth, no network, wrong slug): the monitor looked
  # healthy while it watched nothing, which is exactly the outage it exists to
  # report. Keep the exit status, and treat a failure as an incident.
  _err_file="$(mktemp)"
  PRS_RAW="$(gh pr list --repo "$REPO" --author "@me" --state open --limit 30 \
         --json number --jq '.[].number' 2>"$_err_file")" || LIST_RC=$?
  LIST_ERR="$(head -c 200 "$_err_file" 2>/dev/null || true)"
  rm -f "$_err_file"
  if [ "$LIST_RC" -eq 0 ]; then
    PRS="$(printf '%s' "$PRS_RAW" | tr '\n' ' ')"
  fi
fi
if [ "$LIST_RC" -ne 0 ]; then
  MSG="github-pr-monitor: the PR list query FAILED on $REPO (rc=$LIST_RC). The monitor is watching NOTHING until this is fixed. ${LIST_ERR:-no stderr}"
  echo "$MSG" >&2
  # Alert the owner, at most once per AUTH_ALERT_COOLDOWN -- an alerting script
  # that cannot see anything has to say so on the channel, not only in a log.
  AUTH_STAMP="store/.github-pr-monitor-auth-alert"
  AUTH_ALERT_COOLDOWN=21600
  NOW="$(date +%s)"
  LAST="$(cat "$AUTH_STAMP" 2>/dev/null || echo 0)"
  case "$LAST" in (''|*[!0-9]*) LAST=0;; esac
  if [ $((NOW - LAST)) -ge "$AUTH_ALERT_COOLDOWN" ]; then
    if send_telegram "⚠️ $MSG"; then printf '%s' "$NOW" > "$AUTH_STAMP" || true; fi
  fi
  exit 1
fi
if [ -z "${PRS// /}" ]; then
  # An empty list is only trustworthy if the repo itself is reachable: `gh pr
  # list` answers rc=0 with NO rows for a slug that does not exist or that we
  # cannot see (measured 2026-09-04 against a deliberately nonexistent slug), so
  # "nothing to watch" would silently cover a broken configuration.
  if ! gh repo view "$REPO" --json name >/dev/null 2>&1; then
    MSG="github-pr-monitor: repo $REPO is NOT reachable (gh repo view failed), so the empty PR list means nothing. The monitor is watching NOTHING."
    echo "$MSG" >&2
    AUTH_STAMP="store/.github-pr-monitor-auth-alert"
    NOW="$(date +%s)"
    LAST="$(cat "$AUTH_STAMP" 2>/dev/null || echo 0)"
    case "$LAST" in (''|*[!0-9]*) LAST=0;; esac
    if [ $((NOW - LAST)) -ge 21600 ]; then
      if send_telegram "⚠️ $MSG"; then printf '%s' "$NOW" > "$AUTH_STAMP" || true; fi
    fi
    exit 1
  fi
  echo "no open PRs of ours on $REPO, nothing to watch"
  exit 0
fi

for pr in $PRS; do
  json="$(gh pr view "$pr" --repo "$REPO" \
      --json state,reviewDecision,reviews,comments,title 2>/dev/null || echo '{}')"
  line="$(printf '%s' "$json" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
if not d: print("ERR||||"); sys.exit()
reviews=d.get("reviews") or []
comments=d.get("comments") or []
last=""
acts=[(r.get("submittedAt",""),r["author"]["login"]+":"+r.get("state","")) for r in reviews] \
     +[(c.get("createdAt",""),c["author"]["login"]+":comment") for c in comments]
acts=[a for a in acts if a[0]]
if acts: last=sorted(acts)[-1][1]
print("|".join([d.get("state","?"),str(d.get("reviewDecision") or "none"),str(len(reviews)),str(len(comments)),last]))
' 2>/dev/null || echo "ERR||||")"
  CUR="${CUR}${pr}	${line}
"
done

# --- baseline on first run ----------------------------------------------
if [ ! -f "$STATE_FILE" ]; then
  printf '%s' "$CUR" > "$STATE_FILE"
  echo "baseline written"
  exit 0
fi

# --- diff & alert --------------------------------------------------------
CHANGES=""
while IFS=$'\t' read -r pr sig; do
  [ -n "$pr" ] || continue
  [ "${sig%%|*}" = "ERR" ] && continue   # skip transient fetch failure
  # NOT grep -P: BSD grep (macOS) has no -P, so this line exited 2 with EMPTY
  # output on every tick, `old` stayed empty, the -n guard below never fired and
  # the monitor reported NO change, ever -- while still refreshing its snapshot,
  # so it looked healthy. Measured 2026-09-04 on macOS 26.6. awk is portable and
  # needs no escape for the literal tab.
  old="$(awk -F'\t' -v p="$pr" '$1 == p { sub(/^[^\t]*\t/, ""); print; exit }' "$STATE_FILE" 2>/dev/null)"
  if [ -n "$old" ] && [ "$old" != "$sig" ]; then
    IFS='|' read -r st rd nrev ncom last <<< "$sig"
    CHANGES="${CHANGES}- PR #${pr}: state=${st}, review=${rd}, reviews=${nrev}, comments=${ncom}${last:+, utolso: ${last}}
"
  fi
done <<< "$CUR"

PERSIST=1
if [ -n "$CHANGES" ]; then
  if send_telegram "GitHub PR valtozas (reagalt valaki?):
${CHANGES}
https://github.com/${REPO}/pulls"; then
    echo "change detected, alerted"
  else
    # Snapshot NOT persisted on a failed alert (NOTIFYVAKSWEEP826): persisting
    # consumed the diff, so the change was marked reported while nobody saw
    # it. Keeping the old snapshot makes the next tick re-diff and retry.
    echo "change detected but the alert did NOT deliver -- snapshot kept, will retry" >&2
    PERSIST=0
  fi
fi

# persist the freshest non-error snapshot (unless a failed alert must retry)
if [ "$PERSIST" = 1 ]; then
  printf '%s' "$CUR" > "$STATE_FILE"
fi
