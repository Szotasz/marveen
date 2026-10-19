#!/usr/bin/env bash
# The update finalizer names where it was when it disappeared (FINSTAGE930, #1740).
#
# The verdict went missing on installs where the detached finalizer reached the
# restart and then was simply gone: nothing told "killed" apart from "never got
# to _write". The finalizer now logs a `stage=` line before each step and traps
# TERM/HUP/INT with the stage it was in. These tests RUN the generated finalizer
# (extracted from update.sh, as felugyeleti-riasztas.test.sh does) against fake
# stop/start/curl/systemctl, and pin:
#   1. the order of the stage= lines on the success path;
#   2. the order on the rollback path (the dashboard never answers);
#   3. a TERM delivered during the restart prints the trap line naming that stage,
#      and (the trap is non-fatal on purpose) the finalizer still writes the verdict.
#
# Run:  bash scripts/__tests__/update-finalize-stages.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0
N=0

check() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/finstage.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

F="$SANDBOX/fin"; mkdir -p "$F/store" "$F/scripts" "$F/bin"
python3 - "$ROOT/update.sh" "$F/finalize.sh" <<'EXTRACT'
import sys
src = open(sys.argv[1], encoding='utf-8').read()
i = src.index("cat > \"$FINALIZE_SCRIPT\" <<'FINALIZE_EOF'")
j = src.index("\nFINALIZE_EOF\n", i)
open(sys.argv[2], 'w', encoding='utf-8').write(src[i:j].split('\n', 1)[1] + '\n')
EXTRACT

printf 'MAIN_AGENT_ID=teszt\n' > "$F/.env"
printf '#!/usr/bin/env bash\nexit 0\n' > "$F/scripts/stop.sh"
# start.sh can deliver a TERM to its caller (the finalizer) on request, which is
# what a reaper does to the finalizer in the field.
cat > "$F/scripts/start.sh" <<'ST'
#!/usr/bin/env bash
[ "${SEND_TERM:-0}" = "1" ] && kill -TERM "$PPID"
exit 0
ST
# curl: the dashboard answers unless HEALTH_DOWN=1
cat > "$F/bin/curl" <<'CU'
#!/usr/bin/env bash
[ "${HEALTH_DOWN:-0}" = "1" ] && exit 7
exit 0
CU
printf '#!/usr/bin/env bash\nexit 0\n' > "$F/bin/sleep"     # keep the failing health poll fast
printf '#!/usr/bin/env bash\nexit 1\n' > "$F/bin/pidof"     # no systemd: _unit_drift is a no-op
chmod +x "$F/scripts/stop.sh" "$F/scripts/start.sh" "$F/bin/curl" "$F/bin/sleep" "$F/bin/pidof"

fin_run() {  # fin_run VAR=value... ; prints the finalizer's combined output
  ( cd "$F" && env PATH="$F/bin:$PATH" "$@" \
      bash "$F/finalize.sh" "$F" "" "" 3420 "$F/store/res.json" "$F/store/built" "" "" 0 ) 2>&1
}
stages() { sed -n 's/^\[finalize\] stage=\([a-z-]*\) .*/\1/p' | paste -sd' ' -; }

# 1. success path
out="$(fin_run HEALTH_DOWN=0)"
got="$(stages <<<"$out")"
check "1 success path: stage order is restart unit-drift health write-verdict" \
  "$([ "$got" = "restart unit-drift health write-verdict" ] && echo 0 || echo 1)" "got: $got"
check "1 success path still writes the verdict" \
  "$(grep -q '"status":"success"' "$F/store/res.json" 2>/dev/null && echo 0 || echo 1)"
check "1 no signal line when nothing signals the finalizer" \
  "$(grep -q 'SIGNAL caught' <<<"$out" && echo 1 || echo 0)"

# 2. rollback path (the dashboard never answers)
rm -f "$F/store/res.json"
out="$(fin_run HEALTH_DOWN=1)"
got="$(stages <<<"$out")"
check "2 rollback path: stage order is restart unit-drift health rollback" \
  "$([ "$got" = "restart unit-drift health rollback" ] && echo 0 || echo 1)" "got: $got"
check "2 rollback path writes the failed verdict" \
  "$(grep -q '"status":"failed"' "$F/store/res.json" 2>/dev/null && echo 0 || echo 1)"

# 3. TERM during the restart
rm -f "$F/store/res.json"
out="$(fin_run SEND_TERM=1)"
check "3 TERM during the restart prints the trap line with stage=restart" \
  "$(grep -q '^\[finalize\] SIGNAL caught in stage=restart ' <<<"$out" && echo 0 || echo 1)" "$(grep SIGNAL <<<"$out")"
check "3 the trap line comes after stage=restart and before stage=unit-drift" \
  "$(awk '/^\[finalize\] stage=restart /{r=NR} /SIGNAL caught/{s=NR} /^\[finalize\] stage=unit-drift /{u=NR} END{if (r && s>r && u>s) exit 0; exit 1}' <<<"$out" && echo 0 || echo 1)"

check "3 the finalizer survives the TERM and still writes the success verdict" \
  "$(grep -q '"status":"success"' "$F/store/res.json" 2>/dev/null && echo 0 || echo 1)"

echo
if [ "$FAILS" -gt 0 ]; then echo "$FAILS FAILED of $N" >&2; exit 1; fi
echo "OK: $N checks passed."
