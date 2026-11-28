#!/bin/bash
# The local-commits bundle must carry the tags whose commit origin lacks, and
# only those.
#
# A rollback point is often a tag cut before a rebase or a reset. The bundle was
# built with `--branches --not --remotes=origin`, which says nothing about a commit
# that only a tag points at: such a tag lived on one disk and in no backup. A
# plain `--tags` is no fix either: `--not --remotes=origin` excludes commits, not
# tag objects, so every annotated release tag a clone comes with would ride along
# and the bundle would never be absent on a fully pushed install.
#
# The checks run scripts/backup.sh itself on a throwaway install, so the claim is
# about what the backup does, not about a line of its source.
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

g() { git -c user.email=t@example.invalid -c user.name=t -c tag.gpgSign=false -c commit.gpgSign=false "$@"; }

echo "local-commits bundle ref selection (backup.sh end to end)"

# A throwaway install: the copied script, the markers it insists on, a git repo
# whose `origin` is a local bare repo.
FAKE="$TMP/install"; FHOME="$TMP/home"; ORIGIN="$TMP/origin.git"
mkdir -p "$FAKE/scripts/lib" "$FAKE/store" "$FHOME/.claude/skills/demo" "$FHOME/.claude/scheduled-tasks/demo"
cp "$BACKUP" "$FAKE/scripts/backup.sh"
cp "$ROOT/scripts/lib/archive-list-has.sh" "$FAKE/scripts/lib/"
if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$FAKE/store/claudeclaw.db" 'CREATE TABLE t(x);'; else printf 'db' > "$FAKE/store/claudeclaw.db"; fi
printf 'x' > "$FHOME/.claude/skills/demo/SKILL.md"
printf 'x' > "$FHOME/.claude/scheduled-tasks/demo/SKILL.md"

git init -q --bare "$ORIGIN"
git --git-dir="$ORIGIN" symbolic-ref HEAD refs/heads/main
g -C "$FAKE" init -q
g -C "$FAKE" commit -q --allow-empty -m shared
g -C "$FAKE" tag -a v1.0.0 -m "release"          # like the release tags every clone carries
g -C "$FAKE" remote add origin "$ORIGIN"
g -C "$FAKE" push -q origin HEAD:refs/heads/main
g -C "$FAKE" fetch -q origin

RUN=0
run_backup() {   # -> sets OUT (the archive dir of this run)
    RUN=$((RUN + 1)); OUT="$TMP/out$RUN"; mkdir -p "$OUT"
    ( cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" bash scripts/backup.sh >"$OUT.log" 2>&1 )
    local rc=$?
    ARCHIVE="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
    [ "$rc" -eq 0 ] && [ -n "$ARCHIVE" ] || { echo "    backup.sh rc=$rc"; tail -5 "$OUT.log"; return 1; }
}
bundle_heads() {  # the refs inside this run's bundle, one per line (empty: no bundle)
    rm -rf "$OUT/x"; mkdir -p "$OUT/x"
    tar -xzf "$ARCHIVE" -C "$OUT/x" repo/local-commits.bundle 2>/dev/null || return 0
    git bundle list-heads "$OUT/x/repo/local-commits.bundle" | awk '{print $2}'
}
manifest_has_bundle() {
    tar -xzf "$ARCHIVE" -C "$OUT/x" MANIFEST.txt 2>/dev/null
    grep -q 'local-commits.bundle' "$OUT/x/MANIFEST.txt" 2>/dev/null
}

# (1) Fully pushed, with an annotated release tag on a pushed commit: no bundle.
if run_backup; then
    heads="$(bundle_heads)"
    if [ -z "$heads" ]; then
        pass "fully pushed install with an annotated release tag: no bundle in the archive"
    else
        fail "the bundle is present on a fully pushed install (refs: $(echo $heads))"
    fi
    if manifest_has_bundle; then fail "the manifest lists a bundle that is not there"; else pass "the manifest lists no bundle"; fi
else
    fail "backup.sh did not produce an archive (fully pushed case)"
fi

# (2) A commit that ONLY a tag points at: the tag rides along, the release tag does not.
g -C "$FAKE" commit -q --allow-empty -m "rollback point"
tagged="$(git -C "$FAKE" rev-parse HEAD)"
g -C "$FAKE" tag -a pre-something -m "before the rebase"
g -C "$FAKE" reset -q --hard HEAD~1   # the commit now hangs off the tag alone
if run_backup; then
    heads="$(bundle_heads)"
    if grep -qx 'refs/tags/pre-something' <<<"$heads"; then
        pass "a tag whose commit origin lacks is in the bundle"
    else
        fail "the tag-only commit's tag is missing from the bundle (refs: $(echo $heads))"
    fi
    if grep -qx 'refs/tags/v1.0.0' <<<"$heads"; then
        fail "the release tag on a pushed commit is in the bundle too"
    else
        pass "the release tag on a pushed commit stays out"
    fi
    if manifest_has_bundle; then pass "the manifest lists the bundle"; else fail "the manifest does not list the bundle"; fi
    cp "$OUT/x/repo/local-commits.bundle" "$TMP/tagged.bundle"
else
    fail "backup.sh did not produce an archive (tag-only case)"
fi

# (3) An unpushed branch is still bundled (the original purpose), next to the tag.
g -C "$FAKE" switch -q -c local-work
g -C "$FAKE" commit -q --allow-empty -m "unpushed branch work"
work_tip="$(git -C "$FAKE" rev-parse HEAD)"
if run_backup; then
    heads="$(bundle_heads)"
    if grep -qx 'refs/heads/local-work' <<<"$heads" && grep -qx 'refs/tags/pre-something' <<<"$heads"; then
        pass "an unpushed branch and an off-origin tag are bundled together"
    else
        fail "unexpected bundle content for a branch plus a tag (refs: $(echo $heads))"
    fi
    cp "$OUT/x/repo/local-commits.bundle" "$TMP/both.bundle"
else
    fail "backup.sh did not produce an archive (branch-plus-tag case)"
fi
g -C "$FAKE" tag -d pre-something >/dev/null
if run_backup; then
    heads="$(bundle_heads)"
    if grep -qx 'refs/heads/local-work' <<<"$heads" && ! grep -q '^refs/tags/' <<<"$heads"; then
        pass "an unpushed branch is bundled, with no tag"
    else
        fail "unexpected bundle content for an unpushed branch (refs: $(echo $heads))"
    fi
    cp "$OUT/x/repo/local-commits.bundle" "$TMP/no-tags.bundle"
else
    fail "backup.sh did not produce an archive (unpushed-branch case)"
fi

# (4) The documented restore command brings both back after cloning origin.
RESTORE_REFSPECS=('refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*')
fresh() { rm -rf "$1"; git clone -q "$ORIGIN" "$1"; }
fresh "$TMP/r1"
if [ -s "$TMP/tagged.bundle" ] && git -C "$TMP/r1" fetch -q "$TMP/tagged.bundle" "${RESTORE_REFSPECS[@]}" 2>/dev/null \
   && [ "$(git -C "$TMP/r1" rev-parse -q --verify 'refs/tags/pre-something^{commit}')" = "$tagged" ]; then
    pass "the documented restore brings back the tag and its commit"
else
    fail "the documented restore did not bring back the tag-only commit"
fi
fresh "$TMP/r2"
if [ -s "$TMP/no-tags.bundle" ] && git -C "$TMP/r2" fetch -q "$TMP/no-tags.bundle" "${RESTORE_REFSPECS[@]}" 2>/dev/null \
   && [ "$(git -C "$TMP/r2" rev-parse -q --verify refs/heads/local-work)" = "$work_tip" ]; then
    pass "the restore command also works on a bundle without tags"
else
    fail "the restore command fails when the bundle has no tag"
fi

# (5) The documented clobber case: the clone has a same-named tag elsewhere.
fresh "$TMP/r3"
g -C "$TMP/r3" tag pre-something origin/main
g -C "$TMP/r3" branch -q other origin/main
out="$(git -C "$TMP/r3" fetch "$TMP/both.bundle" "${RESTORE_REFSPECS[@]}" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'would clobber existing tag' <<<"$out"; then
    pass "a same-named tag elsewhere: the fetch rejects it and exits non-zero (as documented)"
else
    fail "the clobber case did not behave as documented (rc=$rc)"
fi
if [ "$(git -C "$TMP/r3" rev-parse -q --verify refs/heads/local-work)" = "$work_tip" ]; then
    pass "the other refs are restored in the same fetch (as documented)"
else
    fail "the rejected tag also kept the branch from being restored"
fi
git -C "$TMP/r3" fetch -q "$TMP/both.bundle" '+refs/tags/*:refs/tags/*' 2>/dev/null
if [ "$(git -C "$TMP/r3" rev-parse -q --verify 'refs/tags/pre-something^{commit}')" = "$tagged" ]; then
    pass "the documented + refspec takes the backed-up tag"
else
    fail "the + refspec did not take the backed-up tag"
fi

# (6) The docs and the script comment show the same restore command.
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
