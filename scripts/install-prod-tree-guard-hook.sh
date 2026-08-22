#!/usr/bin/env bash
# Idempotent installer: protect the MAIN checkout (the tree the dashboard
# serves static files from and host updates pull into) against branch-ops.
# Auto-run by scripts/sync-hooks.sh on every update, so a re-clone or a new
# host regains the guard on its first update instead of silently losing it
# (PRODFAAG822 / RESPAWNZAJ822, 2026-08-22: a context-less resumed session
# branch-switched and committed on the live prod tree).
#
# Two git hooks, both scoped to the MAIN worktree only (linked worktrees have
# a different toplevel and pass untouched):
#   pre-commit    -- BLOCKS a commit on the main checkout.
#                    Override: MARVEEN_PROD_COMMIT_OK=1 git commit ...
#   post-checkout -- git has no pre-checkout, so a branch switch cannot be
#                    blocked; this ALERTS the main agent and, when the tracked
#                    tree is clean, auto-reverts to the default branch.
#                    Override: MARVEEN_PROD_CHECKOUT_OK=1 git checkout ...
#
# No operator-specific paths are baked in: the guarded root is derived from
# the repository itself (the main worktree of the .git the hook lives in), so
# the same guard ships to every deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
MARK="marveen-prod-tree-guard"
mkdir -p "$HOOK_DIR"

preserve_foreign() {
  # Keep a pre-existing, non-guard hook out of the way instead of clobbering it.
  local hook="$1"
  if [ -f "$hook" ] && ! grep -q "$MARK" "$hook" 2>/dev/null; then
    mv "$hook" "$hook.pre-prod-guard.bak"
    echo "  (preserved existing $(basename "$hook") as $(basename "$hook").pre-prod-guard.bak)"
  fi
}

preserve_foreign "$HOOK_DIR/pre-commit"
cat > "$HOOK_DIR/pre-commit" <<'EOF'
#!/usr/bin/env bash
# marveen-prod-tree-guard : block commits on the main (prod) checkout.
# The dashboard serves static files from this tree and host updates pull into
# it; repo work belongs in a worktree. Managed by
# scripts/install-prod-tree-guard-hook.sh -- edit there, not here.
# Deliberate override: MARVEEN_PROD_COMMIT_OK=1 git commit ...
set -euo pipefail
PROD_ROOT="${MARVEEN_PROD_ROOT:-$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")}"
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo)"
if [ "$TOPLEVEL" = "$PROD_ROOT" ] && [ "${MARVEEN_PROD_COMMIT_OK:-0}" != "1" ]; then
  echo "" >&2
  echo "BLOCKED: commit on the running main checkout ($PROD_ROOT)." >&2
  echo "The dashboard serves static files from this tree and host updates pull into it." >&2
  echo "Work in a worktree instead:" >&2
  echo "  git worktree add ../$(basename "$PROD_ROOT")-wt-<topic> -b <branch> origin/develop" >&2
  echo "Deliberate override: MARVEEN_PROD_COMMIT_OK=1 git commit ..." >&2
  exit 1
fi
exit 0
EOF
chmod +x "$HOOK_DIR/pre-commit"

preserve_foreign "$HOOK_DIR/post-checkout"
cat > "$HOOK_DIR/post-checkout" <<'EOF'
#!/usr/bin/env bash
# marveen-prod-tree-guard : loud (non-blocking) alert + clean-tree auto-revert
# when the main (prod) checkout switches branches. Git has no pre-checkout
# hook, so the switch itself cannot be blocked -- but it must not sit silent
# either (PRODFAAG822: the 10:10 switch was found only on the next manual
# look). Managed by scripts/install-prod-tree-guard-hook.sh -- edit there.
# Deliberate switch: MARVEEN_PROD_CHECKOUT_OK=1 git checkout ...
# Never fails the checkout itself (no set -e; every step is best-effort).
[ "${3:-0}" = "1" ] || exit 0   # flag=1 -> branch switch; file checkouts exit here
PROD_ROOT="${MARVEEN_PROD_ROOT:-$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")}"
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo)"
[ "$TOPLEVEL" = "$PROD_ROOT" ] || exit 0
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ismeretlen)"
case "$BRANCH" in develop|main|master) exit 0 ;; esac
[ "${MARVEEN_PROD_CHECKOUT_OK:-0}" = "1" ] && exit 0
# Revert target: the deployment's default branch, derived, not assumed.
HOME_BRANCH=""
for b in develop main master; do
  if git show-ref --verify --quiet "refs/heads/$b"; then HOME_BRANCH="$b"; break; fi
done
# Auto-revert only when the TRACKED tree is clean: a guard must never lose
# work. Untracked files deliberately do not count (--untracked-files=no): a
# branch switch never touches them, and on a live tree untracked host-local
# files are the steady state -- counting them would make this revert never
# fire (measured 2026-08-22). Recursion is self-limiting: the revert lands on
# the home branch, where this hook exits at the case-guard above.
REVERTED="nem"
if [ -z "$HOME_BRANCH" ]; then
  REVERTED="nem (nincs develop/main/master ag)"
elif [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  if git checkout "$HOME_BRANCH" -q 2>/dev/null; then
    REVERTED="igen ($HOME_BRANCH)"
  else
    REVERTED="nem sikerult (checkout $HOME_BRANCH hibazott)"
  fi
else
  REVERTED="nem (a fa DIRTY, kezi beavatkozas kell)"
fi
TOKEN_FILE="$PROD_ROOT/store/.dashboard-token"
[ -r "$TOKEN_FILE" ] || exit 0
# 'from' must be a registered fleet agent id (the API rejects made-up names,
# measured 2026-08-22) -- the source is named in the content prefix instead.
# The alert MUST name the tree it fired in: without it a test alert raised
# from a scratch root is word-for-word identical to a real one, and the
# reader starts an investigation (cost one wasted round on 2026-08-22).
ORIGIN="${MARVEEN_DASHBOARD_ORIGIN:-http://localhost:3420}"
ALERT_TO="${MARVEEN_GUARD_ALERT_TO:-marveen}"
curl -s -m 5 -X POST "$ORIGIN/api/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -d "{\"from\":\"marveen\",\"to\":\"$ALERT_TO\",\"content\":\"[PROD-FA ORSEG, post-checkout hook] Fa: $TOPLEVEL -- agat valtott a(z) $BRANCH agra. (Ha ez az utvonal nem a telepites fo faja, ez PROBA, nem eles riasztas.) AUTO-VISSZAALLITAS: $REVERTED. Commitot a pre-commit hook blokkol; szandekos valtashoz MARVEEN_PROD_CHECKOUT_OK=1.\"}" >/dev/null 2>&1 || true
exit 0
EOF
chmod +x "$HOOK_DIR/post-checkout"

echo "✓ prod-tree-guard: commit block + branch-switch alert/revert installed for the main checkout."
