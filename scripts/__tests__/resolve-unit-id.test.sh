#!/bin/bash
# Contract tests for scripts/resolve-unit-id.sh (sourced by start.sh / stop.sh).
# Run: bash scripts/__tests__/resolve-unit-id.test.sh
#
# Pins the unit-name resolution on BOTH platforms, including the launchd side,
# which stop-start-system-unit.test.sh cannot reach (it is Linux-only): the
# helper decides by `uname -s`, so a PATH shim for uname runs the Darwin branch
# on any host. Cases: SERVICE_ID unset, SERVICE_ID set with its own units,
# SERVICE_ID set but only the MAIN_AGENT_ID units installed (fallback, the
# review note on #2667), and neither installed (SERVICE_ID kept).

set -u
PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO/scripts/resolve-unit-id.sh"
INSTALL="$TMP/install"; mkdir -p "$INSTALL"
BIN="$TMP/bin"; mkdir -p "$BIN"

# uname: FAKE_OS decides. systemctl: `cat <id>-dashboard.service` succeeds only
# for the ids in FAKE_UNIT_IDS (system scope; --user is accepted the same way).
printf '#!/bin/bash\necho "${FAKE_OS:-Linux}"\n' > "$BIN/uname"
cat > "$BIN/systemctl" <<'SH'
#!/bin/bash
[ "$1" = "--user" ] && shift
[ "$1" = "cat" ] || exit 0
case " ${FAKE_UNIT_IDS:-} " in *" ${2%-dashboard.service} "*) exit 0 ;; esac
exit 1
SH
chmod +x "$BIN"/*

resolve() { # resolve <env-file-content> -> prints UNIT_ID (stderr dropped)
  printf '%b' "$1" > "$INSTALL/.env"
  ( export PATH="$BIN:$PATH"
    INSTALL_DIR="$INSTALL"; SLUG="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL/.env" | head -1 | cut -d= -f2-)"
    SLUG="${SLUG:-marveen}"
    # shellcheck source=../resolve-unit-id.sh
    source "$HELPER" 2>/dev/null
    echo "$UNIT_ID" )
}

expect() { # expect <label> <got> <want>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
}

# --- Linux / systemd ---------------------------------------------------------
export FAKE_OS=Linux
expect "systemd: no SERVICE_ID -> MAIN_AGENT_ID" \
  "$(FAKE_UNIT_IDS=main resolve 'MAIN_AGENT_ID=main\n')" "main"
expect "systemd: SERVICE_ID with its own units wins" \
  "$(FAKE_UNIT_IDS='main svc' resolve 'MAIN_AGENT_ID=main\nSERVICE_ID="svc"\n')" "svc"
expect "systemd: only MAIN_AGENT_ID units installed -> fallback" \
  "$(FAKE_UNIT_IDS=main resolve 'MAIN_AGENT_ID=main\nSERVICE_ID=svc\n')" "main"
expect "systemd: nothing installed -> SERVICE_ID kept" \
  "$(FAKE_UNIT_IDS='' resolve 'MAIN_AGENT_ID=main\nSERVICE_ID=svc\n')" "svc"

# --- Darwin / launchd ----------------------------------------------------------
export FAKE_OS=Darwin
export HOME="$TMP/home"; LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
touch "$LA/com.main.dashboard.plist"
expect "launchd: only com.main.* installed -> fallback" \
  "$(resolve 'MAIN_AGENT_ID=main\nSERVICE_ID=svc\n')" "main"
touch "$LA/com.svc.dashboard.plist"
expect "launchd: com.svc.* installed -> SERVICE_ID wins" \
  "$(resolve 'MAIN_AGENT_ID=main\nSERVICE_ID=svc\n')" "svc"

# --- the launchd lines in start.sh / stop.sh use the resolved name ------------
for f in start.sh stop.sh; do
  if grep -q 'com\.\${SLUG}\.' "$REPO/scripts/$f"; then
    fail "$f: a launchd label still uses SLUG instead of UNIT_ID"
  else
    pass "$f: launchd labels use UNIT_ID"
  fi
done

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
