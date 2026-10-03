#!/bin/bash
# Contract test for scripts/install-commit-identity-hook.sh (COMMITID927).
# Run: bash scripts/__tests__/commit-identity-gate.test.sh
#
# WHAT THIS PINS, and why each case is here rather than "the gate works":
# the gate reads `git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT` instead of the
# config, because the config alone MISSES two of the four override forms. Measured
# 2026-09-27: `git commit --author=x` and `GIT_AUTHOR_EMAIL=x` both change the
# author while leaving the config untouched, and those are exactly the forms the
# old written procedure used. A gate that only read the config would pass them.
# So every override form gets its own case, and the `--author=` one is the point.
#
# CASE 8 IS THE ONE A REVIEWER SHOULD READ FIRST. The first version of this gate
# resolved its expected value as `${MARVEEN_BOT_EMAIL:-<baked>}` at RUNTIME, which
# meant one environment variable let a commit through while printing NOTHING -- a
# silent way around a gate whose other two exits are loud. Sam found it by reading
# the generated hook, measured 2026-09-27. The expected value now has no runtime
# override at all, and case 8 is what keeps it that way.
#
# WHAT THESE CASES DO NOT COVER, measured the same day so it is not mistaken for
# coverage: the rebase machinery runs no pre-commit hook on two of its paths, and it
# REWRITES the COMMITTER to the current config. Neither a plain replay nor
# `git rebase --continue` (after the resolution is staged) runs the hook: in both the
# author is preserved, the committer becomes whatever the config now says, and no hook
# line is printed. The paths that DO run it, and are blocked, are the ones containing an
# explicit commit: a manual `git commit` in the middle of a rebase, and
# `rebase --exec "git commit --amend --reset-author"`.
# That split is the part worth knowing: git's own conflict hint ("mark them as resolved
# with git add/rm, then run git rebase --continue") leads to the ungated path. Zola asked
# the question; the first answer given was an inference and was half wrong.
#
# `git cherry-pick` is a third such path (Sam measured it, re-measured here): no pre-commit
# hook runs, and the author of the picked commit is CARRIED OVER unchanged.
#
# THE SCOPE, STATED AS THE MECHANISM RATHER THAN AS A RULE ABOUT AUTHORS: this gate runs
# exactly where git invokes the `pre-commit` hook, and nowhere else. Measured on this
# machine, one git version:
#   RUNS        git commit; git commit --amend; a manual commit mid-rebase;
#               rebase --exec 'git commit --amend'
#   DOES NOT    rebase replay; rebase --continue; cherry-pick; git am;
#               git merge -- which calls `pre-merge-commit` instead, so a merge made with a
#               wrong config produces a merge commit with that address in BOTH fields and
#               this gate never sees it (measured: the merge succeeded while an ordinary
#               commit with the same config was blocked)
# An earlier revision of this header said the gate "guards the paths where the author comes
# from the config anyway". That was one step wider than the measurement and `git merge`
# falsifies it: the author there does come from the config, and the gate still does not run.
# `git am` likewise inherits the patch's author with no hook at all.
# WHAT IS NOT CLAIMED: that this list is complete. git has more commit-creating paths
# (revert, stash, plumbing, filter-*) and they were not enumerated -- so the honest form is
# "these paths were measured", not "these are the exceptions".
# Detecting them after the fact is possible but is a different thing than a gate:
# post-rewrite sees both rebase paths (mode=rebase) but NOT cherry-pick, while post-commit
# sees cherry-pick and the replay. Both run after the commit exists, so they can report,
# never refuse. Tracked separately rather than promised here.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALLER="$INSTALL_DIR/scripts/install-commit-identity-hook.sh"
BOT="308037950+GitSolar-bit@users.noreply.github.com"

echo "commit-identity gate tests"
echo "=========================="

[ -x "$INSTALLER" ] && pass "the installer exists and is executable" \
  || { fail "the installer is missing or not executable: $INSTALLER"; echo "1 FAILED"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo/scripts"
cp "$INSTALLER" "$WORK/repo/scripts/"
cd "$WORK/repo" || exit 1
git init -q .
git config user.name "GitSolar-bit"
git config user.email "$BOT"

# The installer must be idempotent: the second run is what a host update does.
# NO BOT IDENTITY: the installer must stop loudly and install NOTHING. This is
# the case that matters for an upstream file -- a baked-in default would be the
# identity of the fleet the file came from, and the failure would look like a
# broken gate instead of a missing setting.
if bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1; then
  fail "the installer succeeded with no MARVEEN_BOT_EMAIL configured"
elif [ -e .git/hooks/pre-commit.d/15-commit-identity ]; then
  fail "the installer failed but left a gate behind"
else
  pass "with no identity configured the installer stops and installs nothing"
fi

# The install's .env is the supported place, and the key is read the way the
# product's readEnvFile reads it: a leading 'export ' does NOT match.
printf 'export MARVEEN_BOT_EMAIL=%s\n' "$BOT" > .env
if bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1; then
  fail 'an export-prefixed key in .env was accepted (the product would not)'
else
  pass 'an export-prefixed key in .env is not a key (parity with readEnvFile)'
fi
printf 'MARVEEN_BOT_EMAIL=%s\n' "$BOT" > .env

# A CRLF .env must read the same as an LF one. Measured 2026-09-27 against the compiled
# dist/env.js on 13 .env shapes: the CRLF line ending was the ONE that diverged before this
# was fixed -- the product trims the whole line, this reader kept the \r and baked
# "<addr>\r" into the gate, which then blocks EVERY commit while the message looks like a
# wrong identity. This machine is WSL, so CRLF is not hypothetical.
printf 'MARVEEN_BOT_EMAIL=%s\r\n' "$BOT" > .env
bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
if grep -q "^BOT_EMAIL=\"$BOT\"$" .git/hooks/pre-commit.d/15-commit-identity; then
  pass "a CRLF .env bakes the same identity as an LF one"
else
  fail "a CRLF .env leaked a stray byte into the baked identity"
fi
printf 'MARVEEN_BOT_EMAIL=%s\n' "$BOT" > .env

bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
FIRST="$(sha256sum .git/hooks/pre-commit.d/15-commit-identity | cut -d' ' -f1)"
bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
SECOND="$(sha256sum .git/hooks/pre-commit.d/15-commit-identity | cut -d' ' -f1)"
[ "$FIRST" = "$SECOND" ] && pass "installing twice leaves the same gate (idempotent)" \
  || fail "the gate changed between two installs"
[ -x .git/hooks/pre-commit ] && pass "the dispatcher is executable" || fail "no executable dispatcher"

# 1. The bot identity passes. If this fails, the gate blocks everything.
echo a > f.txt; git add .
if git commit -q -m "bot identity" >/dev/null 2>&1; then
  pass "a commit with the bot identity is allowed"
else
  fail "the bot identity was BLOCKED -- the gate would stop all work"
fi
BASE_SUBJECT="$(git log -1 --format=%s 2>/dev/null)"

# 2-4. Every override form must be refused, and the commit must NOT be created.
try_blocked() {
  local label="$1"; shift
  echo "$RANDOM" >> f.txt; git add .
  if "$@" >/dev/null 2>&1; then
    fail "$label was ALLOWED"
  elif [ "$(git log -1 --format=%s)" = "$BASE_SUBJECT" ]; then
    pass "$label is refused and no commit is created"
  else
    fail "$label was refused but a commit appeared anyway"
  fi
  git reset -q HEAD -- f.txt 2>/dev/null || true
  git checkout -q -- f.txt 2>/dev/null || true
}
try_blocked "git -c user.email" git -c user.email=wrong@example.invalid -c user.name=W commit -q -m x
try_blocked "GIT_AUTHOR_EMAIL" env GIT_AUTHOR_NAME=W GIT_AUTHOR_EMAIL=wrong2@example.invalid git commit -q -m x
try_blocked "git commit --author=" git commit -q -m x --author="W <wrong3@example.invalid>"

# 5. The documented override works, and says that nothing checks it afterwards.
echo z >> f.txt; git add .
OUT="$(SKIP_COMMIT_IDENTITY_GATE=1 git -c user.email=wrong@example.invalid -c user.name=W commit -m "override" 2>&1)"
if [ $? -eq 0 ]; then
  pass "SKIP_COMMIT_IDENTITY_GATE=1 lets the commit through"
else
  fail "the documented override did not work"
fi
case "$OUT" in
  *"NOTHING checks it later"*) pass "the override says out loud that nothing checks it afterwards" ;;
  *) fail "the override is silent about having no net below it" ;;
esac

# 6. A worktree shares .git/hooks, so the gate must hold there too. Today's
#    incident happened in worktrees, not in the main checkout.
git worktree add -q "$WORK/wt" -b probe >/dev/null 2>&1
if [ -d "$WORK/wt" ]; then
  cd "$WORK/wt" || exit 1
  echo w > w.txt; git add .
  if git -c user.email=wrong@example.invalid -c user.name=W commit -q -m x >/dev/null 2>&1; then
    fail "the gate does NOT hold in a worktree"
  else
    pass "the gate holds in a worktree too"
  fi
  cd "$WORK/repo" || exit 1
else
  fail "could not create a worktree for the check"
fi

# 7. Another install with another bot: the expected identity is configurable, so
#    this file does not have to be edited per fleet.
MARVEEN_BOT_EMAIL="other@example.invalid" bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
# (this also pins the precedence: the environment wins over the .env above)
echo q >> f.txt; git add .
if git commit -q -m x >/dev/null 2>&1; then
  fail "after MARVEEN_BOT_EMAIL the gate still accepted the old identity"
else
  pass "MARVEEN_BOT_EMAIL changes which identity is expected"
fi

# 8. THE RUNTIME ENVIRONMENT MUST NOT RE-AIM THE INSTALLED GATE. This is the silent
#    bypass: with a runtime default, `MARVEEN_BOT_EMAIL=x git -c user.email=x commit`
#    passed and printed nothing. The install-time environment still configures the
#    gate (case 7) -- what must not work is changing it per invocation.
bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1 \
  || MARVEEN_BOT_EMAIL="$BOT" bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
MARVEEN_BOT_EMAIL="$BOT" bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
SNEAK="sneak@example.invalid"
BEFORE="$(git rev-parse HEAD)"
echo r >> f.txt; git add .
if MARVEEN_BOT_EMAIL="$SNEAK" git -c user.email="$SNEAK" -c user.name=S commit -q -m x >/dev/null 2>&1; then
  fail "MARVEEN_BOT_EMAIL at RUNTIME re-aimed the gate (the silent bypass is back)"
else
  pass "MARVEEN_BOT_EMAIL at runtime does NOT re-aim the installed gate"
fi
[ "$(git rev-parse HEAD)" = "$BEFORE" ] \
  && pass "and no commit was created on that attempt" \
  || fail "a commit was created despite the block"

# 9. An EMPTY expected identity must never count as a match. The installer cannot
#    produce one (it stops without an identity), so this tampers with the installed
#    gate: an empty value is the shape where a string compare would accidentally
#    succeed if it ever reached one.
GUARDFILE=".git/hooks/pre-commit.d/15-commit-identity"
sed -i 's|^BOT_EMAIL=.*|BOT_EMAIL=""|' "$GUARDFILE"
echo s >> f.txt; git add .
if git commit -q -m x >/dev/null 2>&1; then
  fail "an EMPTY baked identity let a commit through"
else
  pass "an empty baked identity blocks instead of matching"
fi
MARVEEN_BOT_EMAIL="$BOT" bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1
grep -q "^BOT_EMAIL=\"$BOT\"$" "$GUARDFILE" \
  && pass "re-installing restores the expected identity" \
  || fail "re-install did not restore the baked identity"

# 10. THE IDENTITY BEING BAKED IN GETS CHECKED WHERE IT IS CHOSEN. The residual hole
#     of a baked value: install with a personal address and the gate faithfully DEMANDS
#     it -- the incident class, re-entered through the installer, reported as success.
#     A value that is not an address at all is refused; a non-noreply address warns and
#     installs, because a real bot mailbox or a non-GitHub host is legitimate and this
#     script cannot tell those from a mistake. Sam proposed the shape check.
OUT="$(MARVEEN_BOT_EMAIL="notAnAddress" bash scripts/install-commit-identity-hook.sh 2>&1)"
if [ $? -eq 0 ]; then
  fail "a value that is not an e-mail address was accepted"
else
  pass "a value that is not an e-mail address is refused"
fi
OUT="$(MARVEEN_BOT_EMAIL="person@example.com" bash scripts/install-commit-identity-hook.sh 2>&1)"
RC=$?
case "$OUT" in
  *"not a no-reply form"*) pass "a non-noreply identity warns out loud at install time" ;;
  *) fail "a non-noreply identity was baked in silently" ;;
esac
[ "$RC" -eq 0 ] \
  && pass "and it still installs (a real bot mailbox is legitimate)" \
  || fail "the warning turned into a refusal"
MARVEEN_BOT_EMAIL="$BOT" bash scripts/install-commit-identity-hook.sh >/dev/null 2>&1

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
