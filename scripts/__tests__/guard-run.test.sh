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

# Raw rc 0 but the error text is in the output (error inside a subshell / behind || true).
mk subunbound 'echo before
( set -u; echo "$nope_undefined" ) || true
exit 0'
mk subnull 'echo before
( unset x; : "${x:?}" ) || true
exit 0'
mk bgleft 'echo hi
sleep 30 &
echo $! > "$1"
exit 0'
mk bgterm 'trap "exit 143" TERM
echo started
sleep 8 &
echo $! > "$1"
wait'
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
PIDS=""

# Raw run exits 0 (the bash 3.2 bug) -> guard must say 1. Under bash 5 raw may be non-zero; the guard still says 1.
for c in unbound nullparam badsubst arith arith2 readonly; do
  raw=0; "$B" "$T/$c.sh" >/dev/null 2>&1 || raw=$?
  out="$("$GUARD" "$T/$c.sh" 2>&1)"; rc=$?
  [ "$rc" = 1 ]; ok "$c: guard exits 1 (raw rc was $raw)" $? "got $rc"
done

for c in subunbound subnull; do
  raw=0; "$B" "$T/$c.sh" >/dev/null 2>&1 || raw=$?
  "$GUARD" "$T/$c.sh" >/dev/null 2>&1; rc=$?
  [ "$raw" = 0 ] && [ "$rc" = 1 ]; ok "$c: raw rc 0, pattern branch gives 1" $? "raw $raw guard $rc"
done

"$GUARD" "$T/does-not-exist.sh" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ]; ok "missing script -> 2" $? "$rc"

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

# Left-behind background process: guard must return within the drain limit.
t0=$(now); GUARD_DRAIN_TIMEOUT=2 "$GUARD" "$T/bgleft.sh" "$T/bg.pid" >"$T/bg.out" 2>&1; rc=$?; t1=$(now)
el=$((t1 - t0)); bp="$(cat "$T/bg.pid" 2>/dev/null)"; PIDS="$PIDS $bp"
[ -n "$bp" ] && kill "$bp" 2>/dev/null
[ "$rc" = 0 ] && [ "$el" -lt 4000 ] && /usr/bin/grep -q 'drain timed out' "$T/bg.out"; ok "background leftover: exit 0 within limit+2s (${el} ms, limit 2000)" $? "rc $rc ${el}ms"

# TERM while an orphan sleep holds the output: fast 143.
"$GUARD" "$T/bgterm.sh" "$T/bt.pid" >"$T/bt.out" 2>&1 &
gp=$!
i=0; while ! /usr/bin/grep -q started "$T/bt.out" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
sleep 0.3
t0=$(now); kill -TERM "$gp"; rc=0; wait "$gp" || rc=$?; t1=$(now)
el=$((t1 - t0)); bp="$(cat "$T/bt.pid" 2>/dev/null)"; PIDS="$PIDS $bp"
[ -n "$bp" ] && kill "$bp" 2>/dev/null
[ "$rc" = 143 ] && [ "$el" -lt 2000 ]; ok "TERM with orphan sleep: 143 in ${el} ms (< 2000)" $? "rc $rc ${el}ms"

# No process of ours may survive the test.
sleep 0.2; left=""
for p in $PIDS; do kill -0 "$p" 2>/dev/null && left="$left $p"; done
[ -z "$left" ]; ok "no leftover test processes" $? "alive:$left"

"$GUARD" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ]; ok "no script -> usage, 2" $? "$rc"

echo "$N tests, $FAILS failed (bash: $("$B" --version | head -1))"
[ "$FAILS" = 0 ]
