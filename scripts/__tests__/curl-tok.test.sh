#!/usr/bin/env bash
# curl_tok: a dashboard-token nem kerulhet curl argv-ba (ps-ben lathato).
# 1) statikus: a 3 erintett script nem hasznal argv-alaku Bearer fejlecet
# 2) futtatas: a helper eljuttatja a tokent a szervernek, es a curl futasa kozben a ps argv-ban NEM latszik
# 3) kontroll: az argv-alaku hivasnal a ps-ben LATSZIK (a proba diszkriminal, nem vak)
# 4) a helper elutasitja az idezojelet a tokenben (rc 2), nem kuld
# Teszt-token, nem eles: a szerver csak a fejlecet irja egy fajlba es 4 mp-et var.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILS=0
ok() { echo "  OK   $1"; }
bad() { echo "  FAIL $1"; FAILS=$((FAILS + 1)); }

echo "1) statikus: argv-alaku Bearer a 3 scriptben"
for f in scripts/agent-inbox.sh scripts/fleet-safe-start.sh scripts/set-bot-menu.sh; do
  n=$(grep -c -E 'Authorization: Bearer|Bearer \$' "$ROOT/$f" || true)
  if [ "$n" = 0 ]; then ok "$f: 0 talalat"; else bad "$f: $n talalat"; fi
done

TOK="probe-$(date +%s)-$$"
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
HDR="$(mktemp)"
python3 - "$PORT" "$HDR" >/dev/null 2>&1 <<'PY' &
import http.server, sys, time
port, hdr = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        open(hdr, 'w').write(self.headers.get('Authorization', ''))
        time.sleep(4)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PY
SRV=$!
sleep 1

# shellcheck source=../lib/curl-tok.sh
. "$ROOT/scripts/lib/curl-tok.sh"

echo "2) helper: a token eljut a szerverhez, es a ps argv-ban nincs ott futas kozben"
( curl_tok "$TOK" -s "http://127.0.0.1:$PORT/x" >/dev/null ) &
CT=$!
sleep 1.5
if ps -ww -o args= | grep -v grep | grep -q -F 'curl -K -'; then ok "a curl fut a proba alatt (kontroll-pozicio)"; else bad "a curl nem futott a proba alatt -- a ps-ellenorzes nem ervenyes"; fi
if ps -ww -o args= | grep -F -- "$TOK" | grep -v grep >/dev/null; then bad "a token MEGJELENT a ps argv-ben"; else ok "a token NINCS a ps argv-ben"; fi
wait "$CT"
if [ "$(cat "$HDR")" = "Bearer $TOK" ]; then ok "a szerver a helyes Authorization fejlecet kapta"; else bad "a szerver fejléce hibas: $(cat "$HDR")"; fi

echo "3) kontroll: az argv-alaku hivas ps-ben LATSZIK (a proba diszkriminal)"
( curl -s -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/x" >/dev/null ) &
CK=$!
sleep 1.5
if ps -ww -o args= | grep -F -- "$TOK" | grep -v grep >/dev/null; then ok "kontroll: a token lathato az argv-ben (a proba ler)"; else bad "kontroll: a proba NEM latja az argv-alaku tokent -- vak"; fi
wait "$CK"

echo "4) helper: idezojel a tokenben -> rc 2, nincs kuldes"
curl_tok 'a"b' -s "http://127.0.0.1:$PORT/x" >/dev/null 2>&1; RC=$?
if [ "$RC" = 2 ]; then ok "rc 2"; else bad "rc $RC (vart 2)"; fi

kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
rm -f "$HDR"
echo "OSSZESEN: $FAILS hiba"
exit "$FAILS"
