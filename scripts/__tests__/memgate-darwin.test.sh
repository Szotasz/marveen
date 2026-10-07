#!/usr/bin/env bash
# fleet-memory-gate.sh on macOS: /proc/meminfo does not exist there, so the gate
# used to take its fail-open branch on every Mac and never gated anything. On
# macOS the band now comes from the kernel memory pressure level
# (kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical); the
# vm_stat + hw.memsize numbers are informational only.
#
# Hermetic: MEMGATE_UNAME forces the Darwin branch on any host,
# MEMGATE_DARWIN_PRESSURE replaces the sysctl level, MEMGATE_DARWIN_VMSTAT /
# MEMGATE_DARWIN_MEMSIZE replace vm_stat and hw.memsize, and
# MEMGATE_PROC_MEMINFO points at a path that does not exist; curl and tmux are
# stubbed on PATH. The last case is a live smoke against the real kernel
# pressure level and vm_stat, and only runs on a Mac. The gate runs
# under the same bash as this test ($BASH), so `/bin/bash this-file` on a Mac
# exercises bash 3.2.
#
# Run:  bash scripts/__tests__/memgate-darwin.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GATE="${MEMGATE_SCRIPT:-$ROOT/scripts/fleet-memory-gate.sh}"
[ -x "$GATE" ] || { echo "FATAL: the script under test is missing or not executable: $GATE" >&2; exit 2; }

FAILS=0; DONE=0
check() { DONE=$((DONE+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/memgatedarwin.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/store" "$SANDBOX/bin"

# curl stub: nothing leaves the machine even if an alert is attempted.
cat > "$SANDBOX/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo '{"ok":true,"result":{"message_id":1}}'
STUB
chmod +x "$SANDBOX/bin/curl"
# tmux stub: the agent count must not depend on the host's tmux server. It
# reports one agent session on purpose: with zero matches the gate's upstream
# count line (`grep -c ... || echo 0`) yields "0" twice and splits the status
# line, which is a separate, pre-existing issue outside this test's scope.
cat > "$SANDBOX/bin/tmux" <<'STUB'
#!/usr/bin/env bash
echo 'agent-stub: 1 windows'
STUB
chmod +x "$SANDBOX/bin/tmux"

# vm_stat fixture: 16 KiB pages, 1000000 pages total (memsize below).
# available = free + file-backed + purgeable; the other lines must NOT count.
# write_vmstat <free> <file-backed> <purgeable>
write_vmstat() {
  {
    echo 'Mach Virtual Memory Statistics: (page size of 16384 bytes)'
    printf 'Pages free:                               %s.\n' "$1"
    echo 'Pages active:                              300000.'
    echo 'Pages inactive:                            290000.'
    echo 'Pages speculative:                          50000.'
    echo 'Pages throttled:                                0.'
    echo 'Pages wired down:                          200000.'
    printf 'Pages purgeable:                          %s.\n' "$3"
    echo '"Translation faults":                  123456789.'
    echo 'Pages purged:                              999999.'
    printf 'File-backed pages:                        %s.\n' "$2"
    echo 'Anonymous pages:                           400000.'
    echo 'Pages occupied by compressor:              100000.'
  } > "$SANDBOX/vmstat"
}
MEMSIZE=$(( 1000000 * 16384 ))
NO_PROC="$SANDBOX/no-such-meminfo"
SAFE_FLAG_PATH="$SANDBOX/store/.fleet-safe-mode"
# Fake bot token in the sandbox: the alert path never reads the host's real
# channel .env, and the curl stub above answers ok, so a sent alert stamps.
echo 'TELEGRAM_BOT_TOKEN=000000:fake-test-value' > "$SANDBOX/tg.env"

# run_gate <env assignments...> -- <gate args...>
run_gate() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  rm -f "$SANDBOX/store/.fleet-safe-mode" "$SANDBOX/store/.fleet-memgate-alert"
  OUT="$(env PATH="$SANDBOX/bin:$PATH" \
      MARVEEN_STORE="$SANDBOX/store" \
      MARVEEN_ALERT_CHAT_ID="111" \
      TELEGRAM_ENV="$SANDBOX/tg.env" \
      MARVEEN_CORE_AGENTS="corebot" \
      MARVEEN_MEM_GATE_OBSERVE=0 \
      MARVEEN_AGENT_CAP=1000 \
      ${envs[@]+"${envs[@]}"} \
      "$BASH" "$GATE" "$@" 2>&1)"
  RC=$?
}
ok()  { echo 0; }
bad() { echo 1; }
DARWIN=(MEMGATE_UNAME=Darwin MEMGATE_PROC_MEMINFO="$NO_PROC"
        MEMGATE_DARWIN_VMSTAT="$SANDBOX/vmstat" MEMGATE_DARWIN_MEMSIZE="$MEMSIZE")

# The fixture reads 94% used by the old percent model (60000 of 1000000 pages
# available) -- the Mac case that motivated this: the band must still follow
# the pressure level, not the percent.
write_vmstat 20000 30000 10000

# 1. level 1 (normal) -> ok band for core and non-core, despite 94% "used".
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=1 -- --check somebody --dry-run
check "level 1: non-core allowed although vm_stat reads 94% used" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q '^allow: somebody .*pressure=normal(1) used=94%(info) avail=937MB(info) .*band=ok signal=kernel-pressure' && ok || bad)" "rc=$RC out: $OUT"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=1 -- --status --dry-run
check "level 1: --status exit 0 and names the deciding signal" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'band=ok signal=kernel-pressure' && ok || bad)" "rc=$RC out: $OUT"
# Percent thresholds have no effect on Darwin.
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=1 MARVEEN_MEM_WARN_PCT=1 MARVEEN_MEM_HARD_PCT=2 -- --check somebody --dry-run
check "level 1: MARVEEN_MEM_*_PCT ignored on Darwin" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'band=ok' && ok || bad)" "rc=$RC out: $OUT"

# 2. level 2 (warn) -> safe-mode band: non-core blocked, core allowed.
write_vmstat 100000 300000 50000   # 55% used: low percent must not rescue warn
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=2 -- --check somebody --dry-run
check "level 2: non-core blocked (exit 10) although vm_stat reads 55%" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'block non-core (warn).*pressure=warn(2) used=55%(info)' && ok || bad)" "rc=$RC out: $OUT"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=2 -- --check corebot --dry-run
check "level 2: core allowed (exit 0)" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'allow core: corebot.*band=warn' && ok || bad)" "rc=$RC out: $OUT"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=2 -- --verdict --dry-run
check "level 2: --verdict exit 10" "$([ "$RC" = 10 ] && ok || bad)" "rc=$RC out: $OUT"

# 3. level 4 (critical) -> hard band: even core blocked.
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=4 -- --check corebot --dry-run
check "level 4: core blocked (exit 10)" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'block core (hard pause).*pressure=critical(4)' && ok || bad)" "rc=$RC out: $OUT"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=4 -- --check somebody --dry-run
check "level 4: non-core blocked (exit 10)" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'block non-core (hard)' && ok || bad)" "rc=$RC out: $OUT"

# 4. Non-dry level 4 writes the safe-mode flag with the pressure in it and
#    sends the alert through the curl stub (stamp written).
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=4 -- --check somebody
check "level 4 (non-dry): safe-mode flag written with pressure" \
      "$([ "$RC" = 10 ] && grep -q 'pressure=critical(4) used=55% avail=7031MB' "$SAFE_FLAG_PATH" 2>/dev/null && ok || bad)" "rc=$RC out: $OUT"
check "level 4 (non-dry): alert sent through the stub and stamped" \
      "$(echo "$OUT" | grep -q 'Telegram sent \[hard\]' && grep -q '^hard:[0-9]' "$SANDBOX/store/.fleet-memgate-alert" 2>/dev/null && ok || bad)" "out: $OUT"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=1 -- --check somebody
check "level 1 (non-dry): no safe-mode flag" \
      "$([ "$RC" = 0 ] && [ ! -f "$SAFE_FLAG_PATH" ] && ok || bad)" "rc=$RC out: $OUT"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=4 -- --check somebody --dry-run
check "level 4 alert text: kernel level + numbers marked informational" \
      "$(echo "$OUT" | grep -q 'DRY-RUN alert \[hard\]: .*memorystatus_vm_pressure_level=4).*Tájékoztató adat (nem ez dönt macOS-en).*használt 55%' && ok || bad)" "out: $OUT"

# 5. Unreadable or garbage level -> fail-open allow with its own log line,
#    whatever vm_stat says.
for lvl in "" 0 3 8 "-1" "1x" "abc" "normal"; do
  run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE="$lvl" -- --check corebot
  check "level '$lvl': fail-open allow" \
        "$([ "$RC" = 0 ] && echo "$OUT" | grep -q '^pressure-unreadable: allow' && echo "$OUT" | grep -q 'cannot read macOS memory pressure level' && [ ! -f "$SAFE_FLAG_PATH" ] && ok || bad)" "rc=$RC out: $OUT"
done

# 6. vm_stat / memsize unreadable but level readable -> the level still decides;
#    numbers shown as unknown.
run_gate MEMGATE_UNAME=Darwin MEMGATE_PROC_MEMINFO="$NO_PROC" MEMGATE_DARWIN_PRESSURE=2 \
         MEMGATE_DARWIN_VMSTAT="$SANDBOX/no-such-vmstat" MEMGATE_DARWIN_MEMSIZE="$MEMSIZE" -- --check somebody --dry-run
check "vm_stat unreadable, level 2: still blocks non-core, numbers unknown" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'used=unknown(info) avail=unknown(info).*band=warn' && echo "$OUT" | grep -q 'numbers unknown' && ok || bad)" "rc=$RC out: $OUT"
run_gate MEMGATE_UNAME=Darwin MEMGATE_PROC_MEMINFO="$NO_PROC" MEMGATE_DARWIN_PRESSURE=1 \
         MEMGATE_DARWIN_VMSTAT="$SANDBOX/vmstat" MEMGATE_DARWIN_MEMSIZE="not-a-number" -- --check somebody --dry-run
check "hw.memsize not numeric, level 1: allows, numbers unknown" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'used=unknown(info).*band=ok' && ok || bad)" "rc=$RC out: $OUT"
grep -v '^Pages purgeable:' "$SANDBOX/vmstat" > "$SANDBOX/vmstat.nopurg"
run_gate MEMGATE_UNAME=Darwin MEMGATE_PROC_MEMINFO="$NO_PROC" MEMGATE_DARWIN_PRESSURE=4 \
         MEMGATE_DARWIN_VMSTAT="$SANDBOX/vmstat.nopurg" MEMGATE_DARWIN_MEMSIZE="$MEMSIZE" -- --check corebot --dry-run
check "vm_stat line missing, level 4: still hard, numbers unknown" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'block core (hard pause).*used=unknown(info)' && ok || bad)" "rc=$RC out: $OUT"
grep -v 'page size of' "$SANDBOX/vmstat" > "$SANDBOX/vmstat.nops"
run_gate MEMGATE_UNAME=Darwin MEMGATE_PROC_MEMINFO="$NO_PROC" MEMGATE_DARWIN_PRESSURE=1 \
         MEMGATE_DARWIN_VMSTAT="$SANDBOX/vmstat.nops" MEMGATE_DARWIN_MEMSIZE="$MEMSIZE" -- --check somebody --dry-run
check "page size header missing, level 1: allows, numbers unknown" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'used=unknown(info).*band=ok' && ok || bad)" "rc=$RC out: $OUT"

# 7. Linux unchanged: a readable meminfo wins even if the host says Darwin (the
#    pressure level is then never consulted), the status line has no signal=
#    field, and a non-Darwin host without meminfo keeps the old log line.
printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$SANDBOX/meminfo"
run_gate MEMGATE_UNAME=Linux MEMGATE_PROC_MEMINFO="$SANDBOX/meminfo" -- --verdict --dry-run
check "Linux meminfo fixture: used 50%, band ok, line unchanged" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -qx 'used=50% avail=7812MB running_agents=[0-9]* cap=1000 band=ok' && ok || bad)" "rc=$RC out: $OUT"
printf 'MemTotal:       16000000 kB\nMemAvailable:    1000000 kB\n' > "$SANDBOX/meminfo.hard"
run_gate MEMGATE_UNAME=Linux MEMGATE_PROC_MEMINFO="$SANDBOX/meminfo.hard" -- --check corebot --dry-run
check "Linux 93% used: hard band by percent, as before" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'block core (hard pause): corebot | used=93% avail=976MB' && ok || bad)" "rc=$RC out: $OUT"
run_gate MEMGATE_UNAME=Darwin MEMGATE_PROC_MEMINFO="$SANDBOX/meminfo" MEMGATE_DARWIN_PRESSURE=4 \
         MEMGATE_DARWIN_VMSTAT="$SANDBOX/vmstat" MEMGATE_DARWIN_MEMSIZE="$MEMSIZE" -- --verdict --dry-run
check "readable meminfo is used before the Darwin branch (level 4 ignored)" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'used=50% avail=7812MB' && ! echo "$OUT" | grep -q 'pressure' && ok || bad)" "rc=$RC out: $OUT"
run_gate MEMGATE_UNAME=Linux MEMGATE_PROC_MEMINFO="$NO_PROC" MEMGATE_DARWIN_PRESSURE=1 \
         MEMGATE_DARWIN_VMSTAT="$SANDBOX/vmstat" MEMGATE_DARWIN_MEMSIZE="$MEMSIZE" -- --check somebody
check "non-Darwin without meminfo: unchanged fail-open, Linux log line" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'cannot read /proc/meminfo' && echo "$OUT" | grep -q '^meminfo-unreadable: allow' && ! echo "$OUT" | grep -q 'macOS' && ok || bad)" "rc=$RC out: $OUT"

# 8. Kill-switch still comes first, before any read.
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=4 MARVEEN_MEM_GATE_DISABLE=1 -- --check corebot
check "kill-switch wins over a Darwin critical level" \
      "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'gate-disabled: allow' && ! echo "$OUT" | grep -q pressure && ok || bad)" "rc=$RC out: $OUT"

# 9. The running non-core CAP rule applies on Darwin at level 1 (new on macOS:
#    before the pressure branch a Mac exited fail-open before reaching it).
mkdir -p "$SANDBOX/capbin"
cat > "$SANDBOX/capbin/tmux" <<'STUB'
#!/usr/bin/env bash
printf 'agent-a: 1 windows\nagent-b: 1 windows\n'
STUB
chmod +x "$SANDBOX/capbin/tmux"
run_gate "${DARWIN[@]}" MEMGATE_DARWIN_PRESSURE=1 PATH="$SANDBOX/capbin:$SANDBOX/bin:$PATH" MARVEEN_AGENT_CAP=2 -- --check somebody --dry-run
check "level 1 + running at cap: non-core blocked by the cap rule" \
      "$([ "$RC" = 10 ] && echo "$OUT" | grep -q 'block non-core (cap 2/2)' && ok || bad)" "rc=$RC out: $OUT"

# 10. Live smoke on a real Mac: the real kernel level decides, and on a host
#     under normal pressure the band is ok.
if [ "$(uname -s)" = "Darwin" ] && [ ! -f /proc/meminfo ]; then
  live_lvl="$(/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  run_gate -- --status --dry-run
  echo "      live: $OUT"
  echo "      kernel level now: $live_lvl"
  if [ -x /usr/bin/memory_pressure ]; then
    echo "      compare: $(/usr/bin/memory_pressure -Q 2>/dev/null | tail -1)"
  fi
  check "live macOS: status decided by kernel-pressure" \
        "$(echo "$OUT" | grep -q 'signal=kernel-pressure' && ok || bad)" "out: $OUT"
  if [ "$live_lvl" = "1" ]; then
    check "live macOS at normal pressure: band ok, exit 0" \
          "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'pressure=normal(1) .*band=ok' && ok || bad)" "rc=$RC out: $OUT"
  else
    echo "SKIP  live band=ok check (kernel level is '$live_lvl', not 1)"
  fi
else
  echo "SKIP  live macOS smoke (not a Mac)"
fi

echo
echo "$((DONE-FAILS))/$DONE passed  (script under test: $GATE)"
[ "$FAILS" = "0" ] || exit 1
