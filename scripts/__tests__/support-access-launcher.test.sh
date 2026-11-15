#!/bin/sh
# SUPPORTMENTOUT1114: the kit's sh launcher, end to end, against a real kit.
#
# It WRITES a kit under the running user's home (~/.marveen/support), because
# the launcher finds the home in the user database and no variable moves it.
# So it refuses to run anywhere but a throwaway machine: a CI runner (CI=true)
# or a container (/.dockerenv). Locally:
#   docker run --rm --network none -v "$PWD":/src:ro node:22-bookworm-slim \
#     sh -c 'cp -R /src /tmp/tree && cd /tmp/tree && sh scripts/__tests__/support-access-launcher.test.sh'
# The tree it runs from must hold the built files (scripts/support-access,
# scripts/support-standby.mjs, scripts/support-kit.sha256).
set -u
if [ "${CI:-}" != "true" ] && [ ! -f /.dockerenv ]; then
  # The runner's skip contract (src/__tests__/setup/suite-outcome.ts): exit 77 with a reason line.
  echo "SKIP (control unmet): this test writes ~/.marveen/support; it runs in CI or in a container (see the header)"
  exit 77
fi
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
NODE=$(command -v node)
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (want [$3], got [$2])"; fi; }
contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (no [$3] in output)" ;; esac; }

ME=$(id -un)
HOMEDIR=$(getent passwd "$ME" | cut -d: -f6)
SUPPORT="$HOMEDIR/.marveen/support"
KIT="$SUPPORT/kit"
L="$KIT/support-access"
rm -rf "$SUPPORT"

echo "(a) install-kit writes the kit with the launcher in it"
OUT=$("$NODE" "$ROOT/scripts/support-standby.mjs" install-kit --install-root "$ROOT" --node "$NODE" --release 0123456789abcdef0123456789abcdef01234567 2>&1); rc=$?
check "install-kit exit" "$rc" 0
[ -x "$L" ] && pass "the launcher is in the kit and executable" || fail "the launcher is not in the kit"
cmp -s "$L" "$ROOT/scripts/support-access" && pass "the kit's launcher is the tree's" || fail "the kit's launcher differs from the tree's"

echo "(b) with no argument it looks, prints the routine's status, and stops on a machine that is not ready"
OUT=$("$L" 2>&1); rc=$?
contains "status lines printed" "$OUT" "node=ok"
contains "the pins line printed" "$OUT" "pins="
check "not ready: exit 1 (this container has no pinned keys and no sshd)" "$rc" 1
contains "it says not ready" "$OUT" "nem áll készen"
case "$OUT" in *"Írd be"*) fail "it asked for a code while only looking" ;; *) pass "no code asked while looking" ;; esac

echo "(c) enable on a machine that is not ready stops before it asks for a code"
OUT=$(printf 'msc_%s\n' 'abcdefghijklmnopqrstuvwxyz012345' | "$L" enable 2>&1); rc=$?
check "enable not ready: exit 1" "$rc" 1
case "$OUT" in *"Írd be"*) fail "it asked for a code on a machine that is not ready" ;; *) pass "no code asked" ;; esac

echo "(d) disable runs the TREE's routine; with nothing on, it is done, and it names the Profile page removal"
OUT=$("$L" disable 2>&1); rc=$?
check "disable with nothing on: exit 0" "$rc" 0
contains "the routine's own line" "$OUT" "standby=off"
contains "it says it is done here" "$OUT" "A levétel kész ezen a gépen."
contains "it points to the Profile page removal" "$OUT" "Gép eltávolítása a supportból"

echo "(e) a NODE_OPTIONS preload in the caller's environment does not run (env -i)"
MARK="$HOMEDIR/preload-ran"
rm -f "$MARK"
printf 'require("fs").writeFileSync(%s, "x")\n' "\"$MARK\"" > "$HOMEDIR/preload.cjs"
NODE_OPTIONS="--require $HOMEDIR/preload.cjs" "$L" >/dev/null 2>&1
[ ! -e "$MARK" ] && pass "the preload did not run" || fail "the preload ran inside the launcher's node"
rm -f "$HOMEDIR/preload.cjs" "$MARK"

echo "(f) a routine copy that is not the manifest's: the loader refuses, nothing runs"
cp "$KIT/support-standby.mjs" "$HOMEDIR/routine.bak"
chmod u+w "$KIT/support-standby.mjs" 2>/dev/null
printf '\n// changed\n' >> "$KIT/support-standby.mjs"
OUT=$("$L" 2>&1); rc=$?
check "changed routine: exit 1" "$rc" 1
contains "it says kit_mismatch" "$OUT" "kit_mismatch"
case "$OUT" in *"node="*) fail "a status line came out of a changed routine" ;; *) pass "no status from a changed routine" ;; esac
cp "$HOMEDIR/routine.bak" "$KIT/support-standby.mjs"; rm -f "$HOMEDIR/routine.bak"

echo "(g) a dispatcher that is not the manifest's: verify-kit says so before status"
cp "$KIT/support-dispatch.sh" "$HOMEDIR/dispatch.bak"
printf '\n# changed\n' >> "$KIT/support-dispatch.sh"
OUT=$("$L" 2>&1); rc=$?
check "changed dispatcher: exit 1" "$rc" 1
contains "it says kit=kit_mismatch" "$OUT" "kit=kit_mismatch"
cp "$HOMEDIR/dispatch.bak" "$KIT/support-dispatch.sh"; rm -f "$HOMEDIR/dispatch.bak"

echo "(h) a manifest that is not the canonical text: refused before node runs"
cp "$KIT/manifest" "$HOMEDIR/manifest.bak"
printf 'extra line\n' >> "$KIT/manifest"
OUT=$("$L" 2>&1); rc=$?
check "changed manifest: exit 1" "$rc" 1
contains "the launcher's own reader refuses it" "$OUT" "A készlet jegyzéke nem a várt alakú, vagy hiányzik"
cp "$HOMEDIR/manifest.bak" "$KIT/manifest"; rm -f "$HOMEDIR/manifest.bak"

echo "(h2) a manifest with a carriage return, or without its final line end: refused before node runs"
cp "$KIT/manifest" "$HOMEDIR/manifest.bak"
sed 's/$/\r/' "$HOMEDIR/manifest.bak" > "$KIT/manifest"
OUT=$("$L" 2>&1); rc=$?
check "CR in the manifest: exit 1" "$rc" 1
contains "CR: the launcher's own refusal, before node runs" "$OUT" "A készlet jegyzéke nem a várt alakú (kit_manifest_unreadable)."
printf '%s' "$(cat "$HOMEDIR/manifest.bak")" > "$KIT/manifest"
OUT=$("$L" 2>&1); rc=$?
check "no final LF: exit 1" "$rc" 1
contains "no final LF: the launcher's own refusal, before node runs" "$OUT" "A készlet jegyzéke nem a várt alakú (kit_manifest_unreadable)."
cp "$HOMEDIR/manifest.bak" "$KIT/manifest"; rm -f "$HOMEDIR/manifest.bak"

echo "(d2) disable runs the TREE's routine even when the kit's routine is not the manifest's (N14/a)"
cp "$KIT/support-standby.mjs" "$HOMEDIR/routine.bak"
printf '\n// changed\n' >> "$KIT/support-standby.mjs"
OUT=$("$L" disable 2>&1); rc=$?
check "disable with a changed kit routine: exit 0 (the tree's routine ran)" "$rc" 0
case "$OUT" in *kit_mismatch*) fail "disable looked at the kit's hash" ;; *) pass "disable did not depend on the kit's hash" ;; esac
contains "the tree's routine answered" "$OUT" "standby=off"
cp "$HOMEDIR/routine.bak" "$KIT/support-standby.mjs"; rm -f "$HOMEDIR/routine.bak"

echo "(l) the manifest's node is gone: a fixed place is used, resolved and named"
cp "$KIT/manifest" "$HOMEDIR/manifest.bak"
sed 's#^node .*#node /nonexistent/bin/node#' "$HOMEDIR/manifest.bak" > "$KIT/manifest"
OUT=$("$L" 2>&1)
# The launcher's order (N19): the fixed places first, the caller's PATH last; the one it takes is resolved.
WANT=
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -f "$c" ] && [ -x "$c" ]; then WANT=$c; break; fi
done
[ -n "$WANT" ] || WANT=$NODE
contains "it names the node it uses instead" "$OUT" "ezt használom: $(readlink -f "$WANT")"
contains "and still reaches status" "$OUT" "node=ok"
cp "$HOMEDIR/manifest.bak" "$KIT/manifest"; rm -f "$HOMEDIR/manifest.bak"

echo "(i) the kit folder as a link: refused"
mv "$KIT" "$SUPPORT/kit-real"; ln -s "$SUPPORT/kit-real" "$KIT"
OUT=$("$SUPPORT/kit-real/support-access" 2>&1); rc=$?
check "kit folder link: exit 1" "$rc" 1
contains "the launcher's own refusal of the link" "$OUT" "A support-készlet mappája link"
rm "$KIT"; mv "$SUPPORT/kit-real" "$KIT"

echo "(j) an unknown argument is a usage error"
"$L" open >/dev/null 2>&1; check "unknown argument: exit 2" "$?" 2
"$L" enable extra >/dev/null 2>&1; check "two arguments: exit 2" "$?" 2

echo "(k) after the checks the kit is as install-kit wrote it"
OUT=$("$L" 2>&1)
contains "status again" "$OUT" "node=ok"

rm -rf "$SUPPORT"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
