#!/bin/bash
# Behaviour tests for scripts/migrate.sh against a fake dashboard API (#1840).
# Run: bash scripts/__tests__/migrate-dashboard-auth.test.sh
#
# The dashboard API requires the install's Bearer token on every /api call. The
# migration posted SOUL.md, USER.md and the memory chunks WITHOUT it, so every
# call got 401; the first two discarded the answer (> /dev/null 2>&1) and
# printed a check mark anyway. The fake server here answers 401 without the
# right token, records what it got, and the script runs end to end in a
# throwaway install tree with answers on stdin. python3 is the real binary.

set -u
PASS=0; FAIL=0
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN="test-dashboard-token-123"

# --- fake dashboard: Bearer required, every request recorded -----------------
LOG="$TMP/requests.log"; : > "$LOG"
PORT_FILE="$TMP/port"
cat > "$TMP/server.py" <<'PY'
import http.server, json, sys
token, log, port_file = sys.argv[1], sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode('utf-8', 'replace')
        auth = self.headers.get('Authorization') == f'Bearer {token}'
        try: data = json.loads(body)
        except Exception: data = None
        with open(log, 'a') as f:
            f.write(json.dumps({'path': self.path, 'auth': auth, 'keys': sorted(data.keys()) if isinstance(data, dict) else None,
                                'category': (data or {}).get('category') if isinstance(data, dict) else None}) + '\n')
        if not auth:
            self.send_response(401); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}'); return
        out = {'ok': True, 'imported': len((data or {}).get('chunks', [])), 'stats': {'warm': 1}} if self.path.endswith('/import') else {'ok': True, 'id': 1}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(out).encode())
s = http.server.HTTPServer(('127.0.0.1', 0), H)
open(port_file, 'w').write(str(s.server_address[1]))
s.serve_forever()
PY
python3 "$TMP/server.py" "$TOKEN" "$LOG" "$PORT_FILE" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORT_FILE")"

# --- throwaway install tree and an OpenClaw-shaped source (no cron files) -----
mk_install() {
  local d="$1"
  mkdir -p "$d/scripts" "$d/store"
  cp "$REPO/scripts/migrate.sh" "$d/scripts/"
  cp "$REPO/install-lang.sh" "$d/"
  printf 'WEB_PORT=%s\n' "$PORT" > "$d/.env"
  echo en > "$d/.lang"
}
SRC="$TMP/openclaw"
mkdir -p "$SRC/memory"
printf '# Soul\nI am a careful assistant with a long enough personality text.\n' > "$SRC/SOUL.md"
printf '# User\nThe owner prefers short answers and works in the morning.\n' > "$SRC/USER.md"
printf '# Memory\n\n## Project\nThe project uses SQLite and a small web dashboard for the owner.\n' > "$SRC/MEMORY.md"

run_migrate() {  # $1 install dir; answers: source type 1 (OpenClaw), the path, default agent id
  printf '1\n%s\n\n' "$SRC" | TERM=xterm-256color bash "$1/scripts/migrate.sh" > "$TMP/out.txt" 2>&1
  echo $? > "$TMP/rc"
}

echo "== with the dashboard token in the install"
I1="$TMP/install1"; mk_install "$I1"; printf '%s' "$TOKEN" > "$I1/store/.dashboard-token"
: > "$LOG"; run_migrate "$I1"
[ "$(cat "$TMP/rc")" = 0 ] && pass "the script runs to the end (exit 0)" || { fail "exit $(cat "$TMP/rc")"; tail -5 "$TMP/out.txt"; }
n="$(wc -l < "$LOG" | tr -d ' ')"
[ "$n" -ge 3 ] && pass "SOUL, USER and the chunk import all reached the API ($n requests)" || fail "only $n request(s) reached the API"
grep -q '"auth": false' "$LOG" && fail "a request went out without the Bearer token" || pass "every request carried the Bearer token"
grep -q '"/api/memories/import"' "$LOG" && pass "the chunk import was posted" || fail "no chunk import"
grep -q '"keys": \[.*"tier"' "$LOG" && fail "a memory still uses the deprecated tier field" || pass "memories are posted with category, not the deprecated tier"
grep -q 'Imported: ' "$TMP/out.txt" && pass "the chunk import reports what it imported" || fail "no import summary"
grep -q 'not migrated' "$TMP/out.txt" && fail "a successful run prints a failure line" || pass "a successful run prints no failure line"

echo "== without a token file: a refused call is reported, not ticked"
I2="$TMP/install2"; mk_install "$I2"
: > "$LOG"; run_migrate "$I2"
[ "$(cat "$TMP/rc")" = 0 ] && pass "a refused import does not abort the script" || fail "exit $(cat "$TMP/rc")"
grep -q '401' "$TMP/out.txt" && pass "the 401 is named in the output" || fail "the 401 is not in the output"
c401="$(grep -c 'not migrated: the dashboard answered HTTP 401 (http://localhost:[0-9]*/api/memories)' "$TMP/out.txt")"; [ "$c401" = 2 ] && pass "SOUL and USER each say they were not migrated (HTTP 401)" || fail "SOUL/USER failure lines missing"
grep -q 'Chunks not migrated: the dashboard answered HTTP 401' "$TMP/out.txt" && pass "the chunk import says it was not migrated (HTTP 401)" || fail "chunk import failure line missing"

echo
echo "migrate-dashboard-auth: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
