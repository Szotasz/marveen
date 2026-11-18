#!/bin/bash
# Contract tests for scripts/watchdog.sh half-scaffolded-agent guard.
#
# Regression origin: the dashboard wizard creates the agent directory first
# and only then generates CLAUDE.md / SOUL.md through an LLM call. On a live
# install that call took over five minutes. The watchdog ticks every few
# minutes, saw the fresh directory as "an agent that should be running", and
# started the session roughly three minutes before CLAUDE.md was written. The
# agent came up with no identity, no rules and no persona, and stayed that
# way: Claude Code reads CLAUDE.md at startup, so nothing short of a restart
# could fix it. From the outside it looks like the creation failed.
#
# Driven through `watchdog.sh --check-scaffolded <dir>`, which evaluates the
# predicate and exits before touching tmux, the dashboard API or the log -- so
# these run from fixtures with no live agent.
# Run: bash scripts/__tests__/watchdog-scaffold-guard.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1 = fixture name, $2.. = files to create inside it
make_agent() {
  local dir="$TMP/$1"; shift
  mkdir -p "$dir"
  local f
  for f in "$@"; do printf 'x' > "$dir/$f"; done
  echo "$dir"
}

# $1 = label, $2 = agent dir, $3 = expected output line
expect_check() {
  local got
  got=$(bash "$WATCHDOG" --check-scaffolded "$2" 2>&1)
  if [ "$got" = "$3" ]; then pass "$1"; else fail "$1" "$got"; fi
}

echo "watchdog half-scaffolded-agent guard tests"

# The finished agent: both personality files present, safe to start.
expect_check "complete agent is startable" \
  "$(make_agent complete CLAUDE.md SOUL.md)" "scaffolded=yes"

# The incident itself: the wizard has made the directory, the LLM call is still
# running. Starting here is what produced the identity-less live session.
expect_check "bare directory mid-generation is NOT startable" \
  "$(make_agent bare)" "scaffolded=no"

# CLAUDE.md lands first in the handler (Promise.all resolves both, but a partial
# write or a failed SOUL.md fallback can leave exactly this state). Personality
# is incomplete, so it still must not start.
expect_check "CLAUDE.md alone is NOT startable" \
  "$(make_agent claude-only CLAUDE.md)" "scaffolded=no"

expect_check "SOUL.md alone is NOT startable" \
  "$(make_agent soul-only SOUL.md)" "scaffolded=no"

# A directory that does not exist at all must not report ready either -- the
# loop iterates a glob, but a deleted agent mid-tick must not resurrect.
expect_check "missing directory is NOT startable" \
  "$TMP/does-not-exist" "scaffolded=no"

# ---------------------------------------------------------------------------
# MIOAGENTINSTALL1114 (plan 7.4, 7.5, 10.3): the package start guard, driven by
# `watchdog.sh --check-package <agent-dir> [hidden-list]`. The prefix and blank
# cases come from the SAME fixture the TS predicates run
# (scripts/__tests__/fixtures/package-shell-cases.json).
# ---------------------------------------------------------------------------
echo
echo "watchdog package start guard tests"

FIXTURE="$INSTALL_DIR/scripts/__tests__/fixtures/package-shell-cases.json"
OK="package=ok"
INCOMPLETE="package=refused:Package install incomplete"
MISSING="package=refused:Package files missing: run a package repair"
BROKEN="package=refused:Package shell broken: CLAUDE.md must start with the PACKAGE.md and LOCAL.md import lines"
PREFIX_FILE="$INSTALL_DIR/scripts/lib/package-shell-prefix"
NOLIST="$TMP/no-hidden-list.json"

# $1 = label, $2 = agent dir, $3 = expected, $4 = hidden list (optional)
expect_pkg() {
  local got
  got=$(bash "$WATCHDOG" --check-package "$2" "${4:-$NOLIST}" 2>&1)
  if [ "$got" = "$3" ]; then pass "$1"; else fail "$1" "$got"; fi
}

# Materialise every fixture case: <kind>-<index>/ with the case bytes in the file
# under test; prints "kind index expected-bool name" lines.
CASES="$TMP/cases"
mkdir -p "$CASES"
python3 - "$FIXTURE" "$CASES" "$PREFIX_FILE" > "$TMP/case-list" <<'PYEOF'
import base64, json, os, sys
doc = json.load(open(sys.argv[1]))
root, prefix = sys.argv[2], open(sys.argv[3], 'rb').read()
def put(d, name, data):
    os.makedirs(os.path.dirname(os.path.join(d, name)), exist_ok=True)
    open(os.path.join(d, name), 'wb').write(data)
for i, c in enumerate(doc['prefix']):
    d = os.path.join(root, 'prefix-%d' % i)
    put(d, 'CLAUDE.md', base64.b64decode(c['b64'])); put(d, 'PACKAGE.md', b'p\n'); put(d, '.package/manifest.json', b'{}')
    print('prefix', i, 'true' if c['shell'] else 'false', c['name'])
for i, c in enumerate(doc['blank']):
    d = os.path.join(root, 'layer-%d' % i)
    put(d, 'CLAUDE.md', prefix); put(d, 'PACKAGE.md', base64.b64decode(c['b64']))
    d = os.path.join(root, 'manifest-%d' % i)
    put(d, 'CLAUDE.md', b'# not the shell\n'); put(d, '.package/manifest.json', base64.b64decode(c['b64']))
    print('blank', i, 'true' if c['blank'] else 'false', c['name'])
PYEOF

while read -r kind idx expected name; do
  if [ "$kind" = prefix ]; then
    # A manifest stands: the shell starts; anything else is the broken shell.
    if [ "$expected" = true ]; then want="$OK"; else want="$BROKEN"; fi
    expect_pkg "prefix case: $name" "$CASES/prefix-$idx" "$want"
  else
    if [ "$expected" = true ]; then want="$MISSING"; else want="$OK"; fi
    expect_pkg "package layer: $name" "$CASES/layer-$idx" "$want"
    if [ "$expected" = true ]; then want="$OK"; else want="$BROKEN"; fi
    expect_pkg "manifest: $name" "$CASES/manifest-$idx" "$want"
  fi
done < "$TMP/case-list"

# File types and error codes the shared fixture cannot express (Dani C3, C5, C6).
pkgdir() { local d="$TMP/pkg/$1"; mkdir -p "$d/.package"; echo "$d"; }
D=$(pkgdir link-layer); cp "$PREFIX_FILE" "$D/CLAUDE.md"; printf 'real text\n' > "$TMP/pkg/target.md"; ln -s "$TMP/pkg/target.md" "$D/PACKAGE.md"
expect_pkg "a link PACKAGE.md to a non-empty file is missing" "$D" "$MISSING"
D=$(pkgdir dir-layer); cp "$PREFIX_FILE" "$D/CLAUDE.md"; mkdir "$D/PACKAGE.md"
expect_pkg "a folder PACKAGE.md is missing" "$D" "$MISSING"
D=$(pkgdir no-layer); cp "$PREFIX_FILE" "$D/CLAUDE.md"
expect_pkg "no PACKAGE.md is missing, manifest or not" "$D" "$MISSING"
D=$(pkgdir link-claude); cp "$PREFIX_FILE" "$TMP/pkg/shell.md"; ln -s "$TMP/pkg/shell.md" "$D/CLAUDE.md"; printf 'p\n' > "$D/PACKAGE.md"; printf '{}' > "$D/.package/manifest.json"
expect_pkg "a link CLAUDE.md in a package folder is the broken shell" "$D" "$BROKEN"
D=$(pkgdir corrupt-manifest); printf '# body\n' > "$D/CLAUDE.md"; printf '{not json' > "$D/.package/manifest.json"
expect_pkg "a corrupt but non-empty manifest and a broken shell" "$D" "$BROKEN"
D=$(pkgdir link-manifest); printf '# body\n' > "$D/CLAUDE.md"; ln -s "$TMP/nowhere" "$D/.package/manifest.json"
expect_pkg "a dangling link in the manifest's place counts as a manifest" "$D" "$BROKEN"
D=$(pkgdir hand-made); printf '# hand-made agent\n' > "$D/CLAUDE.md"; rmdir "$D/.package"
expect_pkg "a hand-made agent (no shell, no manifest) starts" "$D" "$OK"
if [ "$(id -u)" != 0 ]; then
  D=$(pkgdir unreadable-claude); cp "$PREFIX_FILE" "$D/CLAUDE.md"; chmod 000 "$D/CLAUDE.md"; printf '{}' > "$D/.package/manifest.json"
  expect_pkg "an unreadable CLAUDE.md in a package folder is refused" "$D" "$BROKEN"
  chmod 600 "$D/CLAUDE.md"
fi

# Condition 1: the hidden list.
D=$(pkgdir hidden-one); cp "$PREFIX_FILE" "$D/CLAUDE.md"; printf 'p\n' > "$D/PACKAGE.md"
printf '["hidden-one"]\n' > "$TMP/hidden.json"
expect_pkg "a name on the hidden list is not started" "$D" "$INCOMPLETE" "$TMP/hidden.json"
printf '["someone-else"]\n' > "$TMP/hidden-other.json"
expect_pkg "a name not on the list starts" "$D" "$OK" "$TMP/hidden-other.json"
printf '{broken' > "$TMP/hidden-bad.json"
expect_pkg "an unreadable list is an empty list" "$D" "$OK" "$TMP/hidden-bad.json"
expect_pkg "a missing list is an empty list" "$D" "$OK" "$TMP/does-not-exist.json"

# The prefix file is the shell's half of the one source; the TS half is pinned to it
# by agent-package-shell-guard.test.ts. Here: three lines, LF only.
if [ "$(LC_ALL=C wc -l < "$PREFIX_FILE" | tr -d ' ')" = 3 ] && ! LC_ALL=C grep -q "$(printf '\r')" "$PREFIX_FILE"; then
  pass "the prefix file is three LF-ended lines"
else
  fail "the prefix file is three LF-ended lines" "$(od -c "$PREFIX_FILE" | head -2)"
fi

# No at-sign in the watchdog's own refusal log lines (v1.2.1/1).
if grep -n 'not started: \$PKG_REFUSAL' "$WATCHDOG" >/dev/null && ! grep -nE 'echo "Package [^"]*@' "$WATCHDOG" >/dev/null; then
  pass "the refusal texts carry no at-sign"
else
  fail "the refusal texts carry no at-sign" "see watchdog.sh"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
