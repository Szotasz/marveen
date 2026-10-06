#!/bin/bash
# Contract tests for update.sh strip_legacy_notifier_telegram_env (UPDUNITTGENV930).
# Run: bash scripts/__tests__/notifier-unit-telegram-env.test.sh
#
# #1450 removed `Environment=TELEGRAM_ENV=<home>/.claude/channels/telegram/.env`
# from the two notifier units install-linux.sh writes, but only for new installs.
# On an existing, MIGRATED install the line points at the empty legacy path and
# overrides the notifier's own resolution, so the failure notifier never sends.
# update.sh has to reach those hosts; these tests hold what it may and may not touch.
#
# Hermetic: the function is extracted from update.sh and run against a throwaway
# units dir with a `systemctl` stub on PATH that only records its calls.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FN="$(awk '/^strip_legacy_notifier_telegram_env\(\) \{/,/^\}$/' "$REPO/update.sh")"
if [ -z "$FN" ]; then
  fail "strip_legacy_notifier_telegram_env() not found in update.sh"
  echo ""; echo "Results: $PASS passed, $FAIL failed"; exit 1
fi

mkdir -p "$TMP/bin"
cat >"$TMP/bin/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >>"$STUB_LOG"
EOF
chmod +x "$TMP/bin/systemctl"

# One run of the extracted function against $1; the systemctl calls land in $1/../calls.log.
run_fn() {
  local units="$1"
  : >"$units.calls"
  STUB_LOG="$units.calls" PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash -c "$FN
strip_legacy_notifier_telegram_env \"$units\"" >"$units.out" 2>&1
  echo $?
}

unit_body() {  # $1 = the TELEGRAM_ENV line (or empty)
  printf '[Service]\nType=oneshot\n%sEnvironment=HOME=/home/anna\nExecStart=/home/anna/marveen/scripts/unit-fail-notify.sh %%i\n' "${1:+$1
}"
}

# ---------------------------------------------------------------------------
echo "the installer's expanded legacy line goes, from BOTH units"
U="$TMP/u1"; mkdir -p "$U"
unit_body 'Environment=TELEGRAM_ENV=/home/anna/.claude/channels/telegram/.env' >"$U/anna-host-watchdog.service"
unit_body 'Environment=TELEGRAM_ENV=/home/anna/.claude/channels/telegram/.env' >"$U/anna-notify@.service"
assert_eq "exits 0" "0" "$(run_fn "$U")"
for f in anna-host-watchdog.service anna-notify@.service; do
  B="$(cat "$U/$f")"
  assert_not_contains "$f: the legacy line is gone" "$B" "TELEGRAM_ENV="
  assert_contains "$f: the rest of the unit survives (HOME)" "$B" "Environment=HOME=/home/anna"
  assert_contains "$f: the rest of the unit survives (ExecStart)" "$B" "ExecStart=/home/anna/marveen/scripts/unit-fail-notify.sh %i"
  [ -e "$U/$f.marveen-bak" ] && fail "$f: no .marveen-bak left behind" || pass "$f: no .marveen-bak left behind"
done
assert_eq "one daemon-reload for the whole pass" "1" "$(grep -c 'daemon-reload' "$U.calls")"
echo ""

# ---------------------------------------------------------------------------
echo "the shipped template's /home/USER form goes too"
U="$TMP/u2"; mkdir -p "$U"
printf '[Service]\nEnvironment=TELEGRAM_ENV=/home/USER/.claude/channels/telegram/.env\nEnvironment=HOME=/home/USER\n' >"$U/marveen-notify@.service"
run_fn "$U" >/dev/null
assert_not_contains "template form removed" "$(cat "$U/marveen-notify@.service")" "TELEGRAM_ENV="
echo ""

# ---------------------------------------------------------------------------
echo "an operator's deliberate TELEGRAM_ENV elsewhere is kept"
U="$TMP/u3"; mkdir -p "$U"
unit_body 'Environment=TELEGRAM_ENV=/opt/bots/tg.env' >"$U/anna-host-watchdog.service"
unit_body 'Environment=TELEGRAM_ENV=/home/anna/marveen/.claude/channels/telegram/.env' >"$U/anna-notify@.service"
run_fn "$U" >/dev/null
assert_contains "a path outside the legacy dir survives" "$(cat "$U/anna-host-watchdog.service")" "Environment=TELEGRAM_ENV=/opt/bots/tg.env"
assert_contains "the install-scoped channel path survives" "$(cat "$U/anna-notify@.service")" "Environment=TELEGRAM_ENV=/home/anna/marveen/.claude/channels/telegram/.env"
assert_eq "nothing changed, no daemon-reload" "0" "$(grep -c 'daemon-reload' "$U.calls")"
echo ""

# ---------------------------------------------------------------------------
echo "idempotent, and only the two notifier units are touched"
U="$TMP/u4"; mkdir -p "$U"
unit_body 'Environment=TELEGRAM_ENV=/home/anna/.claude/channels/telegram/.env' >"$U/anna-notify@.service"
unit_body 'Environment=TELEGRAM_ENV=/home/anna/.claude/channels/telegram/.env' >"$U/anna-channels.service"
run_fn "$U" >/dev/null
assert_contains "another unit with the same line is not touched" "$(cat "$U/anna-channels.service")" "TELEGRAM_ENV="
run_fn "$U" >/dev/null
assert_eq "the second run reloads nothing" "0" "$(grep -c 'daemon-reload' "$U.calls")"
echo ""

# ---------------------------------------------------------------------------
echo "a unit without a HOME line falls back to the updater's HOME"
U="$TMP/u5"; mkdir -p "$U"
printf '[Service]\nEnvironment=TELEGRAM_ENV=%s/.claude/channels/telegram/.env\n' "$TMP/home" >"$U/x-host-watchdog.service"
run_fn "$U" >/dev/null
assert_not_contains "fallback HOME form removed" "$(cat "$U/x-host-watchdog.service")" "TELEGRAM_ENV="
echo ""

echo "a host without a units dir is a no-op"
assert_eq "missing dir exits 0" "0" "$(run_fn "$TMP/nincs")"
echo ""

# ---------------------------------------------------------------------------
echo "wiring"
WRAPPER="$(awk '/^run_unit_maintenance\(\) \{/,/^\}$/' "$REPO/update.sh")"
assert_contains "run_unit_maintenance calls it" "$WRAPPER" 'strip_legacy_notifier_telegram_env "$@"'
echo ""

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
