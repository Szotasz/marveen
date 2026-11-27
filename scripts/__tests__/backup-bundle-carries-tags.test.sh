#!/bin/bash
# The local-commits bundle must carry tag tips, not only branch tips.
#
# A rollback point is often a tag cut before a rebase or a reset. The bundle was
# built with `--branches --not --remotes=origin`, which says nothing about a commit
# that only a tag points at: such a tag lived on one disk and in no backup.
#
# Run: bash scripts/__tests__/backup-bundle-carries-tags.test.sh

set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP="$ROOT/scripts/backup.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "local-commits bundle ref selection"

# (1) The source line that decides.
if grep -q -- '--branches --tags --not --remotes=origin' "$BACKUP"; then
    pass "the bundle is built with --branches --tags"
else
    fail "the bundle takes --branches only: a commit reachable only from a tag is in no backup"
fi

# (2) The mechanism, on a repo shaped like the missed case: a commit that ONLY a
# tag points at, with a pushed branch standing in for origin.
git init -q --bare "${TMP}/origin.git"
git init -q "${TMP}/work"
cd "${TMP}/work"
git config user.email t@example.invalid; git config user.name t
git commit -q --allow-empty -m shared
git remote add origin "${TMP}/origin.git"
git push -q origin HEAD:refs/heads/main
git fetch -q origin
git commit -q --allow-empty -m "rollback point"
tagged="$(git rev-parse HEAD)"
git tag pre-something
git reset -q --hard HEAD~1   # the commit now hangs off the tag alone

branch_only="$(git rev-list --branches --not --remotes=origin | grep -cx "${tagged}" || true)"
with_tags="$(git rev-list --branches --tags --not --remotes=origin | grep -cx "${tagged}" || true)"

if [ "${branch_only}" = "0" ]; then
    pass "control: a tag-only commit is absent from a --branches bundle (the gap is real)"
else
    fail "control: the tag-only commit was already in the branch-only set -- this fixture proves nothing"
fi
if [ "${with_tags}" = "1" ]; then
    pass "--tags brings the tag-only commit into the bundle"
else
    fail "--tags did not pick up the tag-only commit"
fi

# (3) The documented restore command really recovers it, so the claim is about
# recovery, not about rev-list arguments.
RESTORE_REFSPECS=('refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*')
git bundle create "${TMP}/b.bundle" --branches --tags --not --remotes=origin >/dev/null 2>&1
git init -q "${TMP}/restore"
cd "${TMP}/restore"
git remote add origin "${TMP}/origin.git"
git fetch -q origin
if git fetch -q "${TMP}/b.bundle" "${RESTORE_REFSPECS[@]}" 2>/dev/null \
   && git cat-file -e "${tagged}^{commit}" 2>/dev/null \
   && [ "$(git rev-parse -q --verify refs/tags/pre-something)" = "${tagged}" ]; then
    pass "the documented restore brings back the tag and its commit after cloning origin"
else
    fail "the documented restore did not bring back the tag-only commit"
fi

# (4) The same restore command must not fail on a bundle that holds no tag at all
# (the common case: only unpushed branches).
cd "${TMP}/work"
git tag -d pre-something >/dev/null
git switch -q -c local-work
git commit -q --allow-empty -m "unpushed branch work"
work_tip="$(git rev-parse HEAD)"
git bundle create "${TMP}/no-tags.bundle" --branches --tags --not --remotes=origin >/dev/null 2>&1
git init -q "${TMP}/restore2"
cd "${TMP}/restore2"
git remote add origin "${TMP}/origin.git"
git fetch -q origin
if git fetch -q "${TMP}/no-tags.bundle" "${RESTORE_REFSPECS[@]}" 2>/dev/null \
   && [ "$(git rev-parse -q --verify refs/heads/local-work)" = "${work_tip}" ]; then
    pass "the restore command also works on a bundle without tags"
else
    fail "the restore command fails when the bundle has no tag"
fi

# (5) The documented restore command is the one the docs and the script comment show.
for doc in "$ROOT/docs/MIGRATION.md" "$ROOT/docs/en/MIGRATION.md" "$BACKUP"; do
    if grep -qF "'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'" "$doc"; then
        pass "restore command with tags documented in ${doc#"$ROOT"/}"
    else
        fail "restore command in ${doc#"$ROOT"/} does not fetch the tags"
    fi
done

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
