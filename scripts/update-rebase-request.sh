#!/usr/bin/env bash
# update-rebase-request.sh -- what to ask the owner for before update.sh may replay this install's local
# commits onto the new upstream (AUTOUPDATEDIVERG1110; the why is in scripts/lib/update-rebase-go.sh).
#
# Read-only apart from `git fetch origin <branch>` (the same fetch update.sh runs first). Prints the
# branch, HEAD, the upstream target, the local commits, the hash the approval must carry, and the
# request and update commands. It files nothing and changes nothing.
set -uo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$INSTALL_DIR/scripts/lib/update-rebase-go.sh"
cd "$INSTALL_DIR" || exit 2

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "No branch is checked out (detached HEAD); there is nothing to rebase." >&2; exit 2
fi
if ! git fetch --quiet origin "$BRANCH"; then
  echo "git fetch origin $BRANCH failed; the target would be stale, so no hash is printed." >&2; exit 3
fi
HEAD_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$(git rev-parse --verify -q 'FETCH_HEAD^{commit}')" || { echo "FETCH_HEAD did not resolve." >&2; exit 3; }
AHEAD="$(git rev-list --count "${TARGET_SHA}..HEAD")"
BEHIND="$(git rev-list --count "HEAD..${TARGET_SHA}")"
if [ "$AHEAD" -eq 0 ] || [ "$BEHIND" -eq 0 ]; then
  echo "Not diverged (ahead $AHEAD, behind $BEHIND): a plain update needs no approval."; exit 0
fi
HASH="$(update_rebase_hash "$BRANCH" "$HEAD_SHA" "$TARGET_SHA")" || { echo "No sha256 tool found." >&2; exit 2; }

echo "branch:  $BRANCH"
echo "head:    $HEAD_SHA"
echo "target:  $TARGET_SHA (origin/$BRANCH now)"
echo "ahead:   $AHEAD local commit(s), behind: $BEHIND"
echo "local commits that would be replayed:"
git log --format='  %h %s' "${TARGET_SHA}..HEAD"
echo "content_hash: $HASH"
echo
echo "1. Ask the owner (category $UPDATE_REBASE_CATEGORY; the description file says what and why):"
echo "   bash scripts/marveen-api.sh approval-request <agent> $UPDATE_REBASE_CATEGORY 3600 <description-file> --content-hash $HASH"
echo "2. After the owner approved it (within 30 minutes of the approval):"
echo "   UPDATE_REBASE_APPROVAL=<approval-id> bash update.sh"
echo "A new local or upstream commit before step 2 changes the hash: the approval is then refused, ask again."
