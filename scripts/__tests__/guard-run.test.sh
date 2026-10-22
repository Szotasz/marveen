#!/bin/bash
# guard-run.sh: micro-fixtures for every quiet-failure class (bash 3.2 EXIT trap bug).
# Run:  /bin/bash scripts/__tests__/guard-run.test.sh   (BASH_UNDER_TEST=/path/bash5 to override)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/../guard-run.sh"
B="${BASH_UNDER_TEST:-/bin/bash}"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

T="$(mktemp -d "${TMPDIR:-/tmp}/guardrun.XXXXXX")"
trap 'rm -rf "$T"' EXIT
export GUARD_RUN_BASH="$B"

mk() { printf '%s\n' "$2" > "$T/$1.sh"; }
mk unbound  'trap "echo cleanup" EXIT
set -u
echo before
echo "$nope_undefined"
echo after'
mk nullparam 'trap "echo cleanup" EXIT
unset x
echo before
: "${x:?must be set}"
echo after'
mk badsubst 'trap "echo cleanup" EXIT
echo before
v=abc
echo "${v!x}"
echo after'
mk arith 'trap "echo cleanup" EXIT
echo before
n=$((1 + ))
echo after'
mk arith2 'trap "echo cleanup" EXIT
echo before
n=$((3 / 0))
echo after'
mk readonly 'trap "echo cleanup" EXIT
readonly R=1
echo before
R=2
echo after'
mk rc3 'echo hello; exit 3'
mk green 'echo line-one; echo "line-two $1" >&2; exit 0'
mk marker 'echo working; echo "ALL-DONE ok"'
mk sleeper 'trap "exit 143" TERM
echo started
sleep 30 &
wait $!'
mk noargs 'set -u
echo "n=$#"'

# Raw run exits 0 (the bash 3.2 bug) -> guard must say 1. Under bash 5 raw may be non-zero; the guard still says 1.
for c in unbound nullparam badsubst arith arith2 readonly; do
  raw=0; "$B" "$T/$c.sh" >/dev/null 2>&1 || raw=$?
  out="$("$GUARD" "$T/$c.sh" 2>&1)"; rc=$?
  [ "$rc" = 1 ]; ok "$c: guard exits 1 (raw rc was $raw)" $? "got $rc"
done

out="$("$GUARD" "$T/rc3.sh" 2>&1)"; rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | /usr/bin/grep -q 'exited with 3'; ok "rc 3 -> 1 and prints 3" $? "$rc: $out"

out="$("$GUARD" "$T/green.sh" ARG 2>"$T/err")"; rc=$?
[ "$rc" = 0 ] && [ "$out" = "line-one" ] && /usr/bin/grep -q 'line-two ARG' "$T/err"; ok "green: 0, stdout and stderr pass through, args reach the script" $?

out="$("$GUARD" "$T/noargs.sh")"; rc=$?
[ "$rc" = 0 ] && [ "$out" = "n=0" ]; ok "no script args under set -u" $? "$rc $out"

"$GUARD" --expect-line '^ALL-DONE' "$T/marker.sh" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ]; ok "--expect-line present -> 0" $? "$rc"
"$GUARD" --expect-line '^NEVER' "$T/marker.sh" >/dev/null 2>&1; rc=$?
[ "$rc" = 70 ]; ok "--expect-line missing -> 70" $? "$rc"
"$GUARD" --expect-line '^ALL-DONE' "$T/rc3.sh" >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ]; ok "failing child beats --expect-line -> 1" $? "$rc"

"$GUARD" "$T/sleeper.sh" >"$T/sl.out" 2>&1 &
gp=$!
i=0; while ! /usr/bin/grep -q started "$T/sl.out" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
kill -TERM "$gp"; rc=0; wait "$gp" || rc=$?
[ "$rc" = 143 ]; ok "TERM -> 143" $? "$rc"

set -m; "$GUARD" "$T/sleeper.sh" >"$T/sl2.out" 2>&1 &
set +m
gp=$!
i=0; while ! /usr/bin/grep -q started "$T/sl2.out" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
kill -INT "$gp"; rc=0; wait "$gp" || rc=$?
[ "$rc" = 130 ] || [ "$rc" = 143 ]; ok "INT -> 130 (got $rc)" $? "$rc"

"$GUARD" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ]; ok "no script -> usage, 2" $? "$rc"

echo "$N tests, $FAILS failed (bash: $("$B" --version | head -1))"
[ "$FAILS" = 0 ]
