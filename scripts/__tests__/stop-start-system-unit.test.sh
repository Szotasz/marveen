#!/bin/bash
# Contract tests for the Linux service-scope branches of scripts/stop.sh and
# scripts/start.sh.
# Run: bash scripts/__tests__/stop-start-system-unit.test.sh
#
# Regression guard: on a root-style install the services run as SYSTEM units,
# and as root `systemctl --user status` fails -- so stop.sh fell through to the
# pidfile fallback (killed a possibly-stale PID, reported success, left the
# services running) and start.sh fell through to the direct nohup launch
# (second dashboard instance, EADDRINUSE crash loop). Both scripts must use
# the system scope when the system units exist, and must NOT claim success
# when acting on them fails.
#
# The scripts run against a throwaway install tree and a PATH shim that fakes
# systemctl / pidof / tmux / node, recording every systemctl invocation.

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# --- throwaway install tree --------------------------------------------------
INSTALL="$TMP/install"
mkdir -p "$INSTALL/scripts" "$INSTALL/store" "$INSTALL/dist"
cp "$REPO/scripts/stop.sh" "$REPO/scripts/start.sh" "$INSTALL/scripts/"
cp "$REPO/install-lang.sh" "$INSTALL/"
echo "MAIN_AGENT_ID=testslug" > "$INSTALL/.env"
echo "hu" > "$INSTALL/.lang"
: > "$INSTALL/scripts/boot-hook-prune.py"   # start.sh runs this; a no-op stub
: > "$INSTALL/dist/index.js"                # so start.sh never triggers a build

# --- PATH shim ----------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
LOG="$TMP/systemctl.log"

cat > "$BIN/systemctl" <<'SH'
#!/bin/bash
echo "$*" >> "$SYSTEMCTL_LOG"
case "$1" in
  cat)   [ "${FAKE_SYSTEM_UNIT:-0}" = "1" ] && exit 0 || exit 1 ;;
  --user) [ "${FAKE_USER_MANAGER:-0}" = "1" ] && exit 0 || exit 1 ;;
  stop|start) exit "${FAKE_SYSTEMCTL_RC:-0}" ;;
esac
exit 0
SH
for tool in pidof tmux node; do
  printf '#!/bin/bash\n%s\n' \
    "$([ "$tool" = node ] && echo 'if [ "$1" = --version ]; then echo v20.0.0; fi; exit 0' || echo 'exit 0')" \
    > "$BIN/$tool"
done
chmod +x "$BIN"/*
export PATH="$BIN:$PATH"
export SYSTEMCTL_LOG="$LOG"

run_script() { # script_name -> rc; log reset first
  : > "$LOG"
  ( cd "$INSTALL" && bash "scripts/$1" >/dev/null 2>&1 )
}

# --- stop.sh ------------------------------------------------------------------

# 1. System units exist -> system-scope stop, and the stale pidfile is untouched.
echo "99999" > "$INSTALL/store/dashboard.pid"
FAKE_SYSTEM_UNIT=1 FAKE_USER_MANAGER=0 run_script stop.sh
rc=$?
if grep -q "^stop testslug-dashboard testslug-channels$" "$LOG" && [ "$rc" = 0 ]; then
  pass "stop: system units are stopped at system scope"
else
  fail "stop: system units are stopped at system scope (rc=$rc, log: $(cat "$LOG"))"
fi
if [ -f "$INSTALL/store/dashboard.pid" ]; then
  pass "stop: system branch does not touch the pidfile fallback"
else
  fail "stop: system branch does not touch the pidfile fallback"
fi

# 2. System units exist but stopping fails -> exit non-zero, no false success.
FAKE_SYSTEM_UNIT=1 FAKE_SYSTEMCTL_RC=1 run_script stop.sh
rc=$?
if [ "$rc" != 0 ]; then
  pass "stop: failure to stop system units is an error, not a claimed success"
else
  fail "stop: failure to stop system units is an error, not a claimed success"
fi

# 3. No system units, user manager present -> the --user branch still runs.
FAKE_SYSTEM_UNIT=0 FAKE_USER_MANAGER=1 run_script stop.sh
if grep -q -- "^--user stop testslug-dashboard testslug-channels$" "$LOG"; then
  pass "stop: user-manager installs keep the --user branch"
else
  fail "stop: user-manager installs keep the --user branch (log: $(cat "$LOG"))"
fi

# 4. No systemd scopes at all -> pidfile fallback (existing behaviour kept).
echo "99999" > "$INSTALL/store/dashboard.pid"
FAKE_SYSTEM_UNIT=0 FAKE_USER_MANAGER=0 run_script stop.sh
if [ ! -f "$INSTALL/store/dashboard.pid" ]; then
  pass "stop: no-systemd installs keep the pidfile fallback"
else
  fail "stop: no-systemd installs keep the pidfile fallback"
fi

# --- start.sh -----------------------------------------------------------------

# 5. System units exist -> system-scope start, and NO direct nohup double-spawn.
FAKE_SYSTEM_UNIT=1 FAKE_USER_MANAGER=0 run_script start.sh
rc=$?
if grep -q "^start testslug-dashboard testslug-channels$" "$LOG" && [ "$rc" = 0 ]; then
  pass "start: system units are started at system scope"
else
  fail "start: system units are started at system scope (rc=$rc, log: $(cat "$LOG"))"
fi
if [ ! -f "$INSTALL/store/dashboard.pid" ] || [ "$(cat "$INSTALL/store/dashboard.pid")" = "99999" ]; then
  pass "start: system branch does not double-spawn a direct instance"
else
  fail "start: system branch does not double-spawn a direct instance"
fi

# 6. System units exist but starting fails -> exit non-zero.
FAKE_SYSTEM_UNIT=1 FAKE_SYSTEMCTL_RC=1 run_script start.sh
rc=$?
if [ "$rc" != 0 ]; then
  pass "start: failure to start system units is an error"
else
  fail "start: failure to start system units is an error"
fi

# 7. No system units, user manager present -> the --user branch still runs.
FAKE_SYSTEM_UNIT=0 FAKE_USER_MANAGER=1 run_script start.sh
if grep -q -- "^--user start testslug-dashboard testslug-channels$" "$LOG"; then
  pass "start: user-manager installs keep the --user branch"
else
  fail "start: user-manager installs keep the --user branch (log: $(cat "$LOG"))"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
