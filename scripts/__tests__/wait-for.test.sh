#!/usr/bin/env bash
# Tests for wait-for.sh. The one that matters is SELF-MATCH: the watcher must
# not find its own command line. Without the guard that case never terminates,
# which is exactly what burned 242 minutes on 2026-09-23.
#
# Run:  bash scripts/__tests__/wait-for.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
W="${WAITFOR_SCRIPT:-$ROOT/scripts/wait-for.sh}"
# MUSZER-ONIGAZOLAS (HEX merte 2026-09-24): 2 of the 13 of these assertions PASS against a
# script that does not exist, because a no-op assertion is satisfied by nothing
# just as well as by correct silence. The suite cannot tell "correctly did
# nothing" from "was not there at all" -- so it must first prove its own target.
# Same principle as the positive control below, pointed the other way.
[ -x "$W" ] || { echo "FATAL: the script under test is missing or not executable: $W" >&2; exit 2; }
# The whole suite is built on `timeout`; without it every rc below means
# something else. macOS does not ship it (it is `gtimeout` from coreutils), and
# a missing tool must stop the suite, not quietly change what it proves.
command -v timeout >/dev/null 2>&1 || {
    echo "FATAL: 'timeout' is not on PATH -- on macOS install coreutils (gtimeout) or alias it." >&2; exit 2; }

FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/waitfor.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
MARK="waitfor-marker-$$-$RANDOM"

# --- 1. POSITIVE CONTROL: the naive pattern really does match itself. --------
# If this fails, every check below is vacuous: there would be no trap to avoid.
naive_rc=0
timeout 3 bash -c "until ! pgrep -f 'pgrep-self-probe-$MARK' >/dev/null 2>&1; do sleep 1; done" || naive_rc=$?
# CONTROL-UNMET is an INSTRUMENT verdict, not a test failure, and it must never
# be reported as a green suite: if the trap does not reproduce on this platform,
# then every assertion below about avoiding it proves nothing here.
#
# IT IS A SKIP, NOT A FAILURE (asked for in the 2026-09-25 re-review, and the
# reviewer measured why). On macOS `pgrep` does not see the calling shell, so
# the naive loop exits 0 instead of hanging: the trap simply does not exist
# there. The suite was exiting 2, script-tests-runner requires 0, and the whole
# vitest run went red on every macOS machine -- for a platform where the script
# under test is CORRECT. A red that means "could not measure here" is a false
# alarm, and a false alarm costs the same attention as a real one.
#
# Exit 77 is the SKIP code (the autotools convention), and it is deliberately
# NOT 0: a skipped suite must not be indistinguishable from a passing one. That
# silent-skip shape is the failure this fleet keeps paying for. The runner
# reports it as SKIPPED and requires the reason below to be printed.
# The control is checked BEFORE it is recorded as an assertion. Reporting a
# FAIL line and then exiting SKIP contradicts itself on the same screen, and the
# reader has to decide which half to believe. An unmet control is not a failed
# assertion -- it is the instrument saying it cannot measure here.
if [ "$naive_rc" != "124" ]; then
    echo "SKIP (control unmet): the self-match trap did not reproduce on this platform (rc=$naive_rc)." >&2
    echo "  Everything below would be vacuous here, so this suite makes NO CLAIM on this machine." >&2
    echo "  This is not a pass and not a failure: nothing was measured. Report the rc." >&2
    exit 77
fi
ok "positive control: naive 'until ! pgrep -f PAT' hangs on its own command line" \
   "$([ "$naive_rc" = "124" ] && echo 0 || echo 1)" "rc=$naive_rc (expected 124 = timeout)"

# --- 2. The same pattern through wait-for.sh must return at once. ------------
t0=$(date +%s); rc=0
timeout 20 bash "$W" pattern "pgrep-self-probe-$MARK" --interval 1 --quiet || rc=$?
ok "pattern mode does NOT match itself (returns instead of spinning)" \
   "$([ "$rc" = "0" ] && echo 0 || echo 1)" "rc=$rc"
ok "  ...and it returns fast (<5s)" \
   "$([ $(( $(date +%s) - t0 )) -lt 5 ] && echo 0 || echo 1)" "took $(( $(date +%s) - t0 ))s"

# --- 3. pattern mode on a REAL process: waits, then returns when it ends. ----
cat > "$SANDBOX/$MARK.sh" <<'JOB'
#!/usr/bin/env bash
sleep "${1:-3}"
JOB
chmod +x "$SANDBOX/$MARK.sh"
bash "$SANDBOX/$MARK.sh" 2 &
job_pid=$!
t0=$(date +%s); rc=0
timeout 20 bash "$W" pattern "$MARK.sh" --interval 1 --quiet || rc=$?
el=$(( $(date +%s) - t0 ))
ok "pattern mode waits for a real matching process" \
   "$([ "$rc" = "0" ] && [ "$el" -ge 1 ] && echo 0 || echo 1)" "rc=$rc elapsed=${el}s (expected >=1s)"
wait "$job_pid" 2>/dev/null

# --- 4. pid mode ------------------------------------------------------------
sleep 2 & sp=$!
t0=$(date +%s); rc=0
timeout 20 bash "$W" pid "$sp" --interval 1 --quiet || rc=$?
el=$(( $(date +%s) - t0 ))
ok "pid mode waits for the pid to exit" \
   "$([ "$rc" = "0" ] && [ "$el" -ge 1 ] && echo 0 || echo 1)" "rc=$rc elapsed=${el}s"
rc=0; timeout 10 bash "$W" pid 999999999 --interval 1 --quiet || rc=$?
ok "pid mode returns at once for a pid that is already gone" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "rc=$rc"

# --- 5. file / gone modes ---------------------------------------------------
( sleep 1; : > "$SANDBOX/out.txt" ) &
rc=0; timeout 20 bash "$W" file "$SANDBOX/out.txt" --interval 1 --quiet || rc=$?
ok "file mode waits for the file to appear" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "rc=$rc"
( sleep 1; rm -f "$SANDBOX/out.txt" ) &
rc=0; timeout 20 bash "$W" gone "$SANDBOX/out.txt" --interval 1 --quiet || rc=$?
ok "gone mode waits for the file to disappear" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "rc=$rc"

# --- 6. timeout is a reported, non-zero RESULT ------------------------------
rc=0
err="$(timeout 20 bash "$W" file "$SANDBOX/never-appears" --timeout 2 --interval 1 2>&1 >/dev/null)" || rc=$?
ok "timeout exits 1 (so a && chain stops)" "$([ "$rc" = "1" ] && echo 0 || echo 1)" "rc=$rc"
ok "timeout says so on stderr" \
   "$(printf '%s' "$err" | grep -q 'TIMEOUT' && echo 0 || echo 1)" "stderr: $err"

# --- 7. the watcher must be SILENT on stderr -------------------------------
# Not cosmetics: the two noises this caught were a broken ancestor walk
# (`[: S: integer expected` -- /proc/<pid>/stat field 4 is not PPid when `comm`
# contains a space) and an unreadable /proc/<pid>/cmdline for a pid that exited
# between pgrep and the read. The first one silently disabled half the
# self-exclusion while every check above still passed.
( sleep 2; : ) &
noise_job=$!
noise="$(timeout 20 bash "$W" pattern "waitfor-silence-probe-$MARK" --interval 1 2>&1 >/dev/null)"
ok "pattern mode writes nothing to stderr" \
   "$([ -z "$noise" ] && echo 0 || echo 1)" "stderr: $noise"
wait "$noise_job" 2>/dev/null

# --- 9. PORTABILITY: the macOS failure mode, measured on Linux ---------------
# The 2026-09-24 review measured this script reporting "done after 0s" on macOS
# WHILE the job ran: `mapfile` is bash 4+, and /proc does not exist there, so
# the match list was always empty. Both are now gone from the script. These
# checks keep them gone, and the first two run the real thing without mapfile.

CODE="$(sed 's/#.*//' "$W")"      # comments may DISCUSS mapfile; code may not use it
ok "no bash-4-only builtins in the code (mapfile/readarray/declare -A)" \
   "$(printf '%s' "$CODE" | grep -qE 'mapfile|readarray|declare[[:space:]]+-A' && echo 1 || echo 0)"
ok "no /proc dependency in the code (macOS has none)" \
   "$(printf '%s' "$CODE" | grep -q '/proc/' && echo 1 || echo 0)"

# Disabling the builtin is the closest thing to bash 3.2 available on this host.
# IT MUST BE DISABLED INSIDE THE SCRIPT'S OWN SHELL: the first version did
# `enable -n mapfile; exec bash "$W"`, and `exec` starts a FRESH shell where the
# builtin is back -- the check passed against a mutant that used mapfile, i.e.
# it was a blind control, the same shape the reviewer found in #1540. BASH_ENV
# is sourced by the non-interactive shell that actually runs the script, so the
# builtin is gone where it matters. Proven by mutation: with mapfile put back,
# this check fails.
BE="$SANDBOX/no-mapfile.bash"
printf 'enable -n mapfile 2>/dev/null\nenable -n readarray 2>/dev/null\n' > "$BE"
ok "the mapfile stand-in really disables the builtin (control for the check below)" \
   "$(BASH_ENV="$BE" bash -c 'type -t mapfile >/dev/null 2>&1' && echo 1 || echo 0)"
# IN PATTERN MODE, not pid mode: pid mode never reaches the ancestor walk.
#
# WHAT THIS CHECK CAN AND CANNOT PROVE -- measured, so nobody reads more into a
# green line than it carries. It proves the script still WORKS when mapfile is
# unavailable. It does NOT reproduce the macOS failure, and mutation says so:
# with `mapfile` put back into the code this check still passes on Linux,
# because the ancestor list is only the FIRST of two self-defences and the
# second one (dropping any process whose command line contains this script's
# name) carries the case alone. The macOS failure needed the OTHER half too --
# no /proc, so every candidate was dropped and the match list was empty. That
# half cannot be simulated here. THE REAL GUARD AGAINST BOTH IS THE STATIC
# CHECK ABOVE (no mapfile, no /proc in the code); this one is a live smoke test
# next to it, not a substitute.
MFMARK="waitfor-mapfile-probe-$$-$RANDOM"
cp "$SANDBOX/$MARK.sh" "$SANDBOX/$MFMARK.sh" 2>/dev/null || printf '#!/usr/bin/env bash\nsleep "${1:-3}"\n' > "$SANDBOX/$MFMARK.sh"
chmod +x "$SANDBOX/$MFMARK.sh"
bash "$SANDBOX/$MFMARK.sh" 3 &
mf_job=$!
t0=$(date +%s); rc=0
BASH_ENV="$BE" timeout 20 bash "$W" pattern "$MFMARK.sh" --interval 1 --quiet || rc=$?
el=$(( $(date +%s) - t0 ))
# Both halves matter: rc=0 alone would also be true of the macOS failure, which
# returned 0 INSTANTLY while the job ran. The elapsed floor is what separates
# "waited correctly" from "reported success early".
ok "pattern mode still waits for the job when mapfile is unavailable (smoke, not proof)" \
   "$([ "$rc" = "0" ] && [ "$el" -ge 2 ] && echo 0 || echo 1)" "rc=$rc elapsed=${el}s (expected 0 and >=2s)"
wait "$mf_job" 2>/dev/null

# --- 10. port mode: the lsof fallback and the loud refusal -------------------
# `ss` is Linux-only, so on macOS port mode could never succeed -- it timed out
# and looked like a slow service. A mode that cannot observe its condition must
# say so, not wait.
# A PATH-shim must carry the tools the TEST needs too (timeout, bash), not just
# the ones the script needs -- the first version left out `timeout` itself and
# three checks came back rc=127, which looks exactly like a real failure.
link_tools() {
    local dir="$1"; shift
    local t base
    for base in timeout bash sh awk ps pgrep sleep date tr basename sed grep "$@"; do
        t="$(command -v "$base" 2>/dev/null)" || continue
        ln -sf "$t" "$dir/$base"
    done
}

PY_LISTENER="$SANDBOX/listener.py"
cat > "$PY_LISTENER" <<'PYL'
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0)); s.listen(1)
print(s.getsockname()[1], flush=True)
time.sleep(float(sys.argv[1]))
PYL
exec 3< <(python3 "$PY_LISTENER" 8)
read -r PORT <&3
lst_pid=$!

rc=0; timeout 10 bash "$W" port "$PORT" --interval 1 --quiet || rc=$?
ok "port mode finds a real listener (ss path)" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "rc=$rc port=$PORT"

if command -v lsof >/dev/null 2>&1; then
    SHIM="$SANDBOX/nossbin"; mkdir -p "$SHIM"
    link_tools "$SHIM" lsof
    rc=0
    PATH="$SHIM" timeout 10 bash "$W" port "$PORT" --interval 1 --quiet || rc=$?
    ok "port mode falls back to lsof when ss is absent (the macOS path)" \
       "$([ "$rc" = "0" ] && echo 0 || echo 1)" "rc=$rc"
else
    echo "SKIP  lsof fallback: lsof not installed here" >&2
fi

EMPTY="$SANDBOX/notools"; mkdir -p "$EMPTY"
link_tools "$EMPTY"
rc=0
err="$(PATH="$EMPTY" timeout 10 bash "$W" port "$PORT" --interval 1 2>&1 >/dev/null)" || rc=$?
ok "port mode with neither ss nor lsof REFUSES (exit 2), not a silent wait" \
   "$([ "$rc" = "2" ] && echo 0 || echo 1)" "rc=$rc"
ok "  ...and says which tools it needs" \
   "$(printf '%s' "$err" | grep -q "lsof" && echo 0 || echo 1)" "stderr: $err"
exec 3<&-

# --- 11. usage errors --------------------------------------------------------
rc=0; bash "$W" >/dev/null 2>&1 || rc=$?
ok "no arguments -> usage, exit 2" "$([ "$rc" = "2" ] && echo 0 || echo 1)" "rc=$rc"
rc=0; bash "$W" pid notanumber >/dev/null 2>&1 || rc=$?
ok "non-numeric pid -> exit 2" "$([ "$rc" = "2" ] && echo 0 || echo 1)" "rc=$rc"

echo
echo "$((N-FAILS))/$N passed"
[ "$FAILS" = "0" ] || exit 1
