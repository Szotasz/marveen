#!/bin/bash
# ISSUE1895 (#1895): scripts/lib/install-tz.sh resolves the install zone for the
# shell helpers the same way src/config.ts resolves APP_TZ: SCHEDULER_TZ from
# store/config-overrides.json over .env, only when it names a real zone, else
# the host zone. And its two callers that write something out:
#   - the macOS helper plists carry a TZ key ONLY when a zone is pinned (no key
#     = the OS zone, like the main units; it used to be a fixed Europe/Budapest);
#   - heartbeat-metrics.sh stamps its ts= line in that zone.
# Runs under /bin/bash with `set -euo pipefail`, in throwaway install dirs.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LIB="$REPO/scripts/lib/install-tz.sh"
# The runner's own TZ must not decide the cases below; the TZ cases set it explicitly.
unset TZ
HOST="$(/bin/bash -c ". '$LIB'; host_tz")"

# Stubs for the installer runs: uname says Darwin (the inbox-observer installer
# refuses anything else, and CI runs on Linux), and the service manager CLI only
# records, so nothing is ever loaded on the machine running the suite.
mkdir -p "$TMP/bin"
printf '#!/bin/bash\necho Darwin\n' > "$TMP/bin/uname"
printf '#!/bin/bash\necho "$*" >> "%s/svc-calls"\n' "$TMP" > "$TMP/bin/launchctl"
chmod +x "$TMP/bin/uname" "$TMP/bin/launchctl"

pinned() { /bin/bash -c "set -euo pipefail; . '$LIB'; install_tz_pinned '$1'"; }
zone() { /bin/bash -c "set -euo pipefail; . '$LIB'; install_tz '$1'"; }
fresh() { rm -rf "$TMP/i"; mkdir -p "$TMP/i/store"; }

echo "1. install_tz / install_tz_pinned"
fresh
assert_eq "nothing pinned: no pinned zone" "" "$(pinned "$TMP/i")"
assert_eq "nothing pinned: the host zone" "$HOST" "$(zone "$TMP/i")"
printf 'SCHEDULER_TZ=Europe/London\n' > "$TMP/i/.env"
assert_eq ".env pins it" "Europe/London" "$(zone "$TMP/i")"
printf 'SCHEDULER_TZ="Europe/London"\r\n' > "$TMP/i/.env"
assert_eq "quotes and CR dropped (env-parse parity)" "Europe/London" "$(pinned "$TMP/i")"
printf 'SCHEDULER_TZ=Europe/Berlin\nSCHEDULER_TZ=Europe/London\n' > "$TMP/i/.env"
assert_eq "the last occurrence wins" "Europe/London" "$(pinned "$TMP/i")"
printf '{\n  "SCHEDULER_TZ": "America/New_York"\n}\n' > "$TMP/i/store/config-overrides.json"
assert_eq "config-overrides.json wins over .env" "America/New_York" "$(zone "$TMP/i")"
printf '{"SCHEDULER_TZ":"Mars/Olympus"}' > "$TMP/i/store/config-overrides.json"
printf 'SCHEDULER_TZ=Not/AZone\n' > "$TMP/i/.env"
assert_eq "a zone that does not exist is not pinned" "" "$(pinned "$TMP/i")"
assert_eq "...and the install zone falls back to the host" "$HOST" "$(zone "$TMP/i")"
printf 'SCHEDULER_TZ=../../etc/passwd\n' > "$TMP/i/.env"; rm -f "$TMP/i/store/config-overrides.json"
assert_eq "a path is not a zone" "" "$(pinned "$TMP/i")"

echo "1b. host_tz reads TZ first (the same answer as config.ts and usage-collect.py)"
tzhost() { TZ="$1" /bin/bash -c "set -euo pipefail; . '$LIB'; host_tz"; }
assert_eq "TZ names the zone" "America/New_York" "$(tzhost America/New_York)"
assert_eq "a leading colon is dropped" "America/New_York" "$(tzhost :America/New_York)"
assert_eq "a TZ that is not a zone falls back to the OS lookup" "$HOST" "$(tzhost Not/AZone)"
assert_eq "a TZ without a slash falls back to the OS lookup" "$HOST" "$(tzhost CET-1)"
assert_eq "a TZ path is not a zone" "$HOST" "$(tzhost ../../etc/passwd)"
fresh
assert_eq "nothing pinned: install_tz follows TZ" "America/New_York" "$(TZ=America/New_York /bin/bash -c ". '$LIB'; install_tz '$TMP/i'")"
printf 'SCHEDULER_TZ=Europe/London\n' > "$TMP/i/.env"
assert_eq "a pinned zone still wins over TZ" "Europe/London" "$(TZ=America/New_York /bin/bash -c ". '$LIB'; install_tz '$TMP/i'")"

echo "2. the macOS helper plists"
for inst in install-channel-keepalive-probe install-stuck-modal-guard install-main-inbox-observer; do
  rm -rf "$TMP/p"; mkdir -p "$TMP/p/store" "$TMP/p/home"; cp -R "$REPO/scripts" "$TMP/p/"
  PATH="$TMP/bin:$PATH" HOME="$TMP/p/home" /bin/bash "$TMP/p/scripts/$inst.sh" >/dev/null 2>&1
  P="$(cat "$TMP/p/home/Library/LaunchAgents/"*.plist 2>/dev/null)"
  assert_contains "$inst: the plist was written" "$P" "</plist>"
  assert_not_contains "$inst: no zone pinned -> no TZ key (the OS zone, like the main units)" "$P" "<key>TZ</key>"
  assert_eq "$inst: no zone pinned -> no blank line left in the plist" "0" "$(grep -c '^[[:space:]]*$' "$TMP/p/home/Library/LaunchAgents/"*.plist 2>/dev/null)"
  printf '{"SCHEDULER_TZ":"Europe/London"}' > "$TMP/p/store/config-overrides.json"
  PATH="$TMP/bin:$PATH" HOME="$TMP/p/home" /bin/bash "$TMP/p/scripts/$inst.sh" >/dev/null 2>&1
  P="$(cat "$TMP/p/home/Library/LaunchAgents/"*.plist 2>/dev/null)"
  assert_contains "$inst: a pinned zone is written" "$P" "<key>TZ</key>
    <string>Europe/London</string>"
  assert_not_contains "$inst: never the old hardcoded zone" "$P" "Europe/Budapest"
  if command -v plutil >/dev/null 2>&1; then
    assert_eq "$inst: plutil accepts the plist" "0" "$(plutil -lint "$TMP/p/home/Library/LaunchAgents/"*.plist >/dev/null 2>&1; echo $?)"
  fi
done

assert_eq "no installer run touched the service manager" "" "$(cat "$TMP/svc-calls" 2>/dev/null)"

echo "3. heartbeat-metrics.sh stamps ts= in the install zone"
rm -rf "$TMP/h"; mkdir -p "$TMP/h/store"; cp -R "$REPO/scripts" "$TMP/h/"
printf '{"SCHEDULER_TZ":"Pacific/Kiritimati"}' > "$TMP/h/store/config-overrides.json"
FIRST="$(CLAW_DASHBOARD_ORIGIN=http://127.0.0.1:9 /bin/bash "$TMP/h/scripts/heartbeat-metrics.sh" 2>/dev/null | head -1)"
assert_eq "the ts= line is Kiritimati time (UTC+14)" "HB_METRICS_V1 ts=$(TZ=Pacific/Kiritimati date +'%Y-%m-%d %H')" "$(printf '%s' "$FIRST" | cut -c1-30)"
FIRST="$(CLAW_TZ=UTC CLAW_DASHBOARD_ORIGIN=http://127.0.0.1:9 /bin/bash "$TMP/h/scripts/heartbeat-metrics.sh" 2>/dev/null | head -1)"
assert_eq "CLAW_TZ still overrides it" "HB_METRICS_V1 ts=$(TZ=UTC date +'%Y-%m-%d %H')" "$(printf '%s' "$FIRST" | cut -c1-30)"
# No zone readable at all: the stamp must be the process's own time, not TZ="" (UTC).
# The library is replaced by one whose install_tz answers nothing; the process zone
# is Kiritimati (UTC+14), so a UTC stamp cannot pass for it.
printf 'install_tz() { printf %%s ""; }\ninstall_tz_pinned() { printf %%s ""; }\nhost_tz() { printf %%s ""; }\n' > "$TMP/h/scripts/lib/install-tz.sh"
rm -f "$TMP/h/store/config-overrides.json"
FIRST="$(TZ=Pacific/Kiritimati CLAW_DASHBOARD_ORIGIN=http://127.0.0.1:9 /bin/bash "$TMP/h/scripts/heartbeat-metrics.sh" 2>/dev/null | head -1)"
assert_eq "an empty install zone stamps the process zone, not UTC" "HB_METRICS_V1 ts=$(TZ=Pacific/Kiritimati date +'%Y-%m-%d %H')" "$(printf '%s' "$FIRST" | cut -c1-30)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
