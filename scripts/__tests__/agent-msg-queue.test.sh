#!/usr/bin/env bash
# agent-msg.sh prints the recipient's queue state from the POST response.
#
# WHAT THIS GUARDS. POST /api/messages returns `queue` (depth, median delay)
# next to the id, but agents send through this helper, and a number the helper
# does not print is a number nobody sees. The cases below pin the line format,
# the "unknown is not instant" rules (NULL delay -> no "(~n min)", a 20 s
# median -> 1 min, not 0), the threshold notice, and that a server which does
# not send `queue` still gets exactly the old "OK id=<n>".
#
# Run:  bash scripts/__tests__/agent-msg-queue.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HELPER="${HELPER_BIN:-$ROOT/scripts/agent-msg.sh}"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

[ -r "$HELPER" ] || { echo "FATAL: the helper is missing: $HELPER" >&2; exit 2; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/msgqueue.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
BIN="$SANDBOX/bin"; mkdir -p "$BIN"
printf 'test-token\n' > "$SANDBOX/token"

# curl stub: nothing leaves the machine; the response body comes from STUB_JSON.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n200' "${STUB_JSON:-}"
STUB
chmod +x "$BIN/curl"
# No sleeping between retries in the malformed-response case.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"; chmod +x "$BIN/sleep"

send() {  # send <json> [warn_at]
  OUT="$(env PATH="$BIN:$PATH" STUB_JSON="$1" MARVEEN_TOKEN_FILE="$SANDBOX/token" \
             ${2:+MARVEEN_QUEUE_WARN_AT="$2"} \
             /bin/bash "$HELPER" igor hex "tiszta szoveg" 2>"$SANDBOX/err.txt")"
  RC=$?
  ERR="$(cat "$SANDBOX/err.txt")"
}
has_notice() { printf '%s' "$ERR" | grep -q '^NOTICE:'; }

send '{"id":1,"status":"pending"}'
ok "old response shape prints exactly the old line" "$([ "$RC" = "0" ] && [ "$OUT" = "OK id=1" ] && echo 0 || echo 1)" "rc=$RC out='$OUT'"
ok "  ...and no notice" "$(has_notice && echo 1 || echo 0)" "err: $ERR"

send '{"id":2,"queue":{"queueDepth":1,"oldestPendingSec":0,"estimatedDelaySec":null}}'
ok "no delivery history: depth shown, delay OMITTED (not ~0)" "$([ "$OUT" = "OK id=2 queue=1" ] && echo 0 || echo 1)" "out='$OUT'"

send '{"id":3,"queue":{"queueDepth":8,"oldestPendingSec":4000,"estimatedDelaySec":4860}}'
ok "busy recipient: depth and minutes" "$([ "$OUT" = "OK id=3 queue=8 (~81 min)" ] && echo 0 || echo 1)" "out='$OUT'"
ok "  ...and the notice names the recipient and the delay" \
   "$(has_notice && printf '%s' "$ERR" | grep -q 'waiting for hex, measured delay ~81 min' && echo 0 || echo 1)" "err: $ERR"
ok "  ...and it is still a successful send" "$([ "$RC" = "0" ] && echo 0 || echo 1)" "rc=$RC"

send '{"id":4,"queue":{"queueDepth":1,"oldestPendingSec":0,"estimatedDelaySec":20}}'
ok "a 20 s median rounds UP to 1 min, never 0" "$([ "$OUT" = "OK id=4 queue=1 (~1 min)" ] && echo 0 || echo 1)" "out='$OUT'"

send '{"id":5,"queue":{"queueDepth":2,"oldestPendingSec":0,"estimatedDelaySec":null}}'
ok "depth 2 is below the default threshold" "$(has_notice && echo 1 || echo 0)" "err: $ERR"
send '{"id":6,"queue":{"queueDepth":3,"oldestPendingSec":0,"estimatedDelaySec":null}}'
ok "depth 3 reaches the default threshold" "$(has_notice && echo 0 || echo 1)" "err: $ERR"
send '{"id":7,"queue":{"queueDepth":8,"oldestPendingSec":0,"estimatedDelaySec":null}}' 0
ok "MARVEEN_QUEUE_WARN_AT=0 switches the notice off" "$(has_notice && echo 1 || echo 0)" "err: $ERR"
send '{"id":8,"queue":{"queueDepth":2,"oldestPendingSec":0,"estimatedDelaySec":null}}' 2
ok "MARVEEN_QUEUE_WARN_AT=2 lowers the threshold" "$(has_notice && echo 0 || echo 1)" "err: $ERR"

# The warning text is the LAST field of the parse; the queue fields must not
# swallow it, and it must not swallow them.
send '{"id":9,"targetRunning":false,"warning":"hex nem fut -- elveszik","queue":{"queueDepth":1,"oldestPendingSec":0,"estimatedDelaySec":null}}'
ok "warning + queue: stdout keeps both" "$([ "$OUT" = "OK id=9 queue=1 (warning)" ] && echo 0 || echo 1)" "out='$OUT'"
ok "  ...and the warning text arrives whole on stderr" \
   "$(printf '%s' "$ERR" | grep -q 'WARNING: hex nem fut -- elveszik' && echo 0 || echo 1)" "err: $ERR"

# An older server sends a warning but no `queue`: the empty queue fields must
# not let the warning words slide into the depth/minutes slots.
send '{"id":10,"targetRunning":false,"warning":"hex nem fut -- elveszik"}'
ok "warning without queue: the old line plus (warning)" "$([ "$OUT" = "OK id=10 (warning)" ] && echo 0 || echo 1)" "out='$OUT'"
ok "  ...and the warning text arrives whole on stderr" \
   "$(printf '%s' "$ERR" | grep -q 'WARNING: hex nem fut -- elveszik' && echo 0 || echo 1)" "err: $ERR"

send 'not json'
ok "malformed response is still a FAIL (the id check drives it)" "$([ "$RC" = "1" ] && echo 0 || echo 1)" "rc=$RC out='$OUT'"

echo "--- $((N-FAILS))/$N passed"
[ "$FAILS" = "0" ]
