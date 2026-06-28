#!/bin/bash
# Nightly git hygiene -- DETERMINISTIC, cron-driven so it runs even when the
# LLM scheduler / dashboard is down (the failure mode that let branches and
# upstream-lag pile up). Two jobs:
#   1) Prune branches whose upstream PR is MERGED (local + fork remote).
#      CLOSED-but-unmerged branches are only LOGGED as candidates, never
#      auto-deleted (someone might reopen them). Protected branches are never
#      touched. Branches with no PR / an OPEN PR are left alone.
#   2) Report how far behind upstream/main we are; alert past a threshold.
#
# Cron (nightly): 30 3 * * * IS_SANDBOX=1 TZ=Europe/Budapest /root/marveen/scripts/git-hygiene.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR" || exit 1
LOG="$INSTALL_DIR/logs/git-hygiene.log"
mkdir -p "$INSTALL_DIR/logs"
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) [git-hygiene] $*" >> "$LOG"; }

UPSTREAM_REPO="Szotasz/marveen"
FORK_REPO="attila-fiREG/marveen"
# Never delete these (anchored prefixes): production main, upstream-integration
# snapshots, the live fiREG ops branch, the dev line, and the deploy branches
# (deploy/* carry the live dist source + cherry-picked fixes; pruning one would
# let a deploy rebuild from a fix-less upstream branch and re-drop the fix).
PROTECT_RE='^(main|develop|merge/upstream-|chore/fireg-ops|deploy/)'
LAG_THRESHOLD=50

command -v git >/dev/null 2>&1 || exit 0
if ! command -v gh >/dev/null 2>&1; then
  log "gh CLI not found -- skipping PR-based prune (lag report only)"
fi

git fetch origin --quiet 2>/dev/null || log "warn: git fetch origin failed"
CUR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

# ── 1) prune merged PR branches ────────────────────────────────────────────
pruned=0
closed_candidates=""
if command -v gh >/dev/null 2>&1; then
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
    [ "$b" = "$CUR" ] && continue
    echo "$b" | grep -qE "$PROTECT_RE" && continue
    state="$(gh pr list --repo "$UPSTREAM_REPO" --head "$b" --state all --json state --jq '.[0].state' 2>/dev/null)"
    case "$state" in
      MERGED)
        if git branch -D "$b" >/dev/null 2>&1; then
          log "pruned local branch '$b' (upstream PR MERGED)"
          pruned=$((pruned + 1))
        fi
        gh api -X DELETE "repos/${FORK_REPO}/git/refs/heads/${b}" >/dev/null 2>&1 \
          && log "pruned fork branch '$b'"
        ;;
      CLOSED)
        closed_candidates="${closed_candidates} ${b}"
        ;;
    esac
  done
fi
[ "$pruned" -gt 0 ] && log "pruned ${pruned} merged branch(es)" || log "no merged PR branches to prune"
[ -n "$closed_candidates" ] && log "CLOSED-PR candidates (manual review, NOT auto-deleted):${closed_candidates}"

# ── 2) upstream lag report ─────────────────────────────────────────────────
LAG="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
UPHEAD="$(git log --oneline -1 origin/main 2>/dev/null | cut -c1-55)"
log "upstream lag: ${LAG} commits behind origin/main (${UPHEAD})"
if [ "${LAG:-0}" != '?' ] && [ "${LAG:-0}" -ge "$LAG_THRESHOLD" ]; then
  log "ALERT: upstream lag ${LAG} >= ${LAG_THRESHOLD} -- consider an upstream merge"
fi

log "done (current branch: ${CUR})"
