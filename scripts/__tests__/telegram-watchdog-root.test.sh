#!/bin/bash
# TGWDOGVAK913 -- the watchdog must find the REAL fleet root, not ~/marveen.
#
# The daemon is launched by launchd/systemd, which pass NO shell env to a job,
# so MARVEEN_ROOT is unset unless the installer wrote it into the unit. The old
# default `~/marveen` does not exist on a real install (root: <home>/ClaudeClaw),
# so the watchdog scanned two non-existent globs and its log stayed 0 bytes -- a
# sentry guarding nothing. The fix self-locates from __file__ when the daemon
# runs the repo copy at <root>/scripts/hooks/, keeps MARVEEN_ROOT as an explicit
# override, and ~/marveen as the last-resort legacy fallback.
#
# This test measures the ROOT RESOLUTION specifically (the existing wedged test
# always pins MARVEEN_ROOT, so it never exercises the derivation that broke):
#   1. run from the repo-copy layout with MARVEEN_ROOT UNSET -> finds the marker
#      under <root>/agents (the fallback fires: proof it self-located);
#   2. MUTATION: run the same script from a NON scripts/hooks/ location with
#      MARVEEN_ROOT unset -> falls to ~/marveen, finds nothing (the vacuous
#      behaviour the fix leaves behind only when NOT run from the repo copy);
#   3. MARVEEN_ROOT override wins regardless of the script's location.
#
# Fully hermetic: HOME pinned to a temp tree (so ~/marveen and ~/.claude resolve
# into empty temp dirs, never the operator's real ones) and all Bot API traffic
# routed to a local stub via TELEGRAM_API_BASE.

set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_WATCHDOG="$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub (logs "<method> <body>" per request) -----------------
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        payload = json.dumps({"ok": True, "result": {"message_id": 9001}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as f: f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[ -z "$PORT" ] && { echo "FATAL: stub did not start"; exit 1; }
API_BASE="http://127.0.0.1:$PORT"
CHAT="10000000001"

count() { grep -c "^$1 " "$REQLOG" 2>/dev/null; }

# Plant a wedged marker under <root>/agents/<name>/... (only the agents glob,
# so ONLY a correctly-derived FLEET_ROOT can reach it). No transcript_path ->
# no recoverable answer -> the fire path is the generic-error edit.
plant_marker() { # root name
  local pdir="$1/agents/$2/.claude/channels/telegram/progress"
  local sdir="$1/agents/$2/.claude/channels/telegram"
  mkdir -p "$pdir"
  printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$sdir/.env"
  printf '[{"chat_id":"%s","message_id":555}]\n' "$CHAT" > "$pdir/SID.json"
  python3 - "$pdir/SID.json" <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-200,)*2)   # 200s > DOWN_GRACE_SEC (120)
PY
}

echo "telegram-watchdog-root tests (TGWDOGVAK913)"
echo "==========================================="

# ---------------------------------------------------------------------------
# (1) FIX: run from the repo-copy layout, MARVEEN_ROOT unset -> self-locates.
# ---------------------------------------------------------------------------
echo ""
echo "(1) __file__ derivation from <root>/scripts/hooks/ (MARVEEN_ROOT unset)"
R1="$TMP/case1"; HOME1="$TMP/home1"
mkdir -p "$R1/scripts/hooks" "$HOME1"
cp "$REAL_WATCHDOG" "$R1/scripts/hooks/telegram_progress_watchdog.py"
plant_marker "$R1" a1
: > "$REQLOG"
env -u MARVEEN_ROOT HOME="$HOME1" TELEGRAM_API_BASE="$API_BASE" \
  TELEGRAM_WATCHDOG_FORCE_AGENT_UP=0 \
  python3 "$R1/scripts/hooks/telegram_progress_watchdog.py"
assert_eq "self-located to <root>: the wedged marker fired (generic error)" "1" "$(count editMessageText)"

# ---------------------------------------------------------------------------
# (2) MUTATION: run from a NON scripts/hooks/ location -> falls to ~/marveen.
# Same marker, but the script sits at <root>/.claude/hooks/ (the old installer
# copy location), so the derivation cannot fire and ~/marveen (empty temp home)
# is scanned -> nothing found. This is exactly the vacuous state the card
# describes; it proves the fix is what makes case (1) fire.
# ---------------------------------------------------------------------------
echo ""
echo "(2) mutation: run from ~/.claude/hooks-style path -> ~/marveen, finds nothing"
R2="$TMP/case2"; HOME2="$TMP/home2"
mkdir -p "$R2/.claude/hooks" "$HOME2"
cp "$REAL_WATCHDOG" "$R2/.claude/hooks/telegram_progress_watchdog.py"
plant_marker "$R2" a2
: > "$REQLOG"
env -u MARVEEN_ROOT HOME="$HOME2" TELEGRAM_API_BASE="$API_BASE" \
  TELEGRAM_WATCHDOG_FORCE_AGENT_UP=0 \
  python3 "$R2/.claude/hooks/telegram_progress_watchdog.py"
assert_eq "not run from repo copy: no delivery (falls to nonexistent ~/marveen)" "0" "$(count editMessageText)"

# ---------------------------------------------------------------------------
# (3) OVERRIDE: MARVEEN_ROOT wins regardless of the script's location.
# ---------------------------------------------------------------------------
echo ""
echo "(3) MARVEEN_ROOT override wins (script at the non-repo path)"
: > "$REQLOG"
MARVEEN_ROOT="$R2" HOME="$HOME2" TELEGRAM_API_BASE="$API_BASE" \
  TELEGRAM_WATCHDOG_FORCE_AGENT_UP=0 \
  python3 "$R2/.claude/hooks/telegram_progress_watchdog.py"
assert_eq "MARVEEN_ROOT override reaches the marker: fired" "1" "$(count editMessageText)"

echo ""
echo "==========================================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL"; exit 1; fi
echo "All tests passed."
