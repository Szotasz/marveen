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
  REPO="$(printf '%s' "$REPO" | sed -E 's#^.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')"
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
  [ -n "${BOT_TOKEN:-}" ] && [ -n "${CHAT_ID:-}" ] || return 0
  curl -s -m 20 -o /dev/null \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" || true
}

# --- fetch current signatures -------------------------------------------
# Signature per PR: state|reviewDecision|#reviews|#comments|lastActor
CUR=""
# Watch whatever of ours is actually open right now. A hardcoded list stops
# covering new PRs the day it is written, and keeps polling merged ones forever.
PRS="${GITHUB_PR_MONITOR_PRS:-}"
if [ -z "$PRS" ]; then
  PRS="$(gh pr list --repo "$REPO" --author "@me" --state open --limit 30 \
         --json number --jq '.[].number' 2>/dev/null | tr '\n' ' ')"
fi
if [ -z "${PRS// /}" ]; then
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
  old="$(grep -P "^${pr}\t" "$STATE_FILE" 2>/dev/null | head -1 | cut -f2-)"
  if [ -n "$old" ] && [ "$old" != "$sig" ]; then
    IFS='|' read -r st rd nrev ncom last <<< "$sig"
    CHANGES="${CHANGES}- PR #${pr}: state=${st}, review=${rd}, reviews=${nrev}, comments=${ncom}${last:+, utolso: ${last}}
"
  fi
done <<< "$CUR"

if [ -n "$CHANGES" ]; then
  send_telegram "GitHub PR valtozas (reagalt valaki?):
${CHANGES}
https://github.com/${REPO}/pulls"
  echo "change detected, alerted"
fi

# always persist the freshest non-error snapshot
printf '%s' "$CUR" > "$STATE_FILE"
