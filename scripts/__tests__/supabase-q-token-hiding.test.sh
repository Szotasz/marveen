#!/bin/bash
# Contract tests for scripts/supabase-q.sh (PATSZIVARGAS912, SUPAQLOGINROLE1010).
# Run: bash scripts/__tests__/supabase-q-token-hiding.test.sh
#
# THE PROPERTIES UNDER TEST:
#   - the PAT never becomes durable text and never appears in any argv (`ps`);
#   - the query goes straight to the Management API (POST .../database/query):
#     the cli/login-role endpoint is never called and the supabase CLI never runs
#     (SUPAQLOGINROLE1010: `supabase db query --linked` created a write-capable
#     login role on every call);
#   - the output keeps the CLI's JSON shape the callers parse ("rows" on success,
#     no "rows" on an error), and the exit codes keep their meaning.
#
# Hermetic: `curl` and `supabase` are stubs on PATH, ROOT is a throwaway dir, and
# no network or real secret is involved. The curl stub records its own argv and
# the config it was given on -K, so "the PAT is not in argv" and "the PAT did
# reach curl" are two separate, measured statements.
set -u
FAILS=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1: $2"; FAILS=$((FAILS+1)); }
check_eq() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "got=$2 want=$3"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# A FIXTURE SZANDEKOSAN NEM PAT-ALAKU. Az elso valtozatom `sbp_` + 40 hex volt,
# es a GitHub push-protection JOGGAL utasitotta el a pusht: egy valodi formatumu
# hamis titok ugyanugy titoknak latszik, es a megkerulo-link hasznalata pont ezen
# a kartyan lett volna a legrosszabb valasz. A teszt a sztringre keres, nem az
# alakjara, tehat semmit nem veszit azzal, hogy felismerhetoen hamis.
FAKE_PAT="FAKE-TOKEN-FOR-TESTS-ONLY-not-a-real-supabase-pat"
DASH_TOKEN="dashboard-token-xyz"
REF="abcdefghijklmnopqrst"

setup() {
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/scripts" "$TMP/store" "$TMP/bin"
  cp "$REPO/scripts/supabase-q.sh" "$TMP/scripts/"
  printf '%s' "$DASH_TOKEN" > "$TMP/store/.dashboard-token"
  MARKER="$TMP/called"
  # curl stub. Every call appends its argv to $MARKER.argv and the config it got
  # on -K (a file path or "-" for stdin) to $MARKER.cfg. The vault call answers
  # the fake PAT (or empty, on demand). The API call stores the request body,
  # writes the canned response to the -o file, and prints the HTTP code (-w).
  cat > "$TMP/bin/curl" <<'STUB'
#!/bin/bash
echo "ARGV: $*" >> "$MARKER.argv"
out=""; url=""; cfg=""; prev=""
for a in "$@"; do
  case "$prev" in -K) cfg="$a" ;; -o) out="$a" ;; esac
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
if [ "$cfg" = "-" ]; then cat >> "$MARKER.cfg"; elif [ -n "$cfg" ]; then cat "$cfg" >> "$MARKER.cfg"; fi
echo "URL: $url" >> "$MARKER.urls"
case "$url" in
  */api/vault/*)
    if [ -n "${VAULT_EMPTY:-}" ]; then echo '{"value":""}'; else echo "{\"value\":\"$FAKE_PAT_FOR_STUB\"}"; fi ;;
  */database/query)
    cat > "$MARKER.body"
    [ -n "${STUB_CURL_FAIL:-}" ] && exit 7
    resp='[{"b":1,"a":"x"}]'; [ -n "${STUB_RESP+set}" ] && resp="$STUB_RESP"
    printf '%s' "$resp" > "$out"
    printf '%s' "${STUB_HTTP:-201}" ;;
  *) echo "unexpected url" >&2; exit 99 ;;
esac
STUB
  # supabase stub: it must never run. If it does, it says so and fails.
  cat > "$TMP/bin/supabase" <<'STUB'
#!/bin/sh
echo "SUPABASE CLI RAN: $*" >> "$MARKER.cli"
exit 42
STUB
  chmod +x "$TMP/bin/curl" "$TMP/bin/supabase"
  FAKE_PAT_FOR_STUB="$FAKE_PAT"
  export MARKER FAKE_PAT_FOR_STUB PATH="$TMP/bin:$PATH"
}
teardown() { rm -rf "$TMP"; unset VAULT_EMPTY STUB_RESP STUB_HTTP STUB_CURL_FAIL; }
run() { (cd "$TMP" && sh scripts/supabase-q.sh "$@"); }

echo "== 1. a token SEHOL nem jelenik meg: kimenet, argv =="
setup
OUT="$(run "$REF" "select 1" 2>&1)"
RC=$?
check_eq "lefutott (exit 0)" "$RC" "0"
case "$OUT" in *"$FAKE_PAT"*) fail "a stdout/stderr NEM tartalmazza a tokent" "megjelent" ;; *) pass "a stdout/stderr NEM tartalmazza a tokent" ;; esac
case "$(cat "$MARKER.argv")" in *"$FAKE_PAT"*) fail "egyik curl ARGV-je sem tartalmazza a PAT-ot" "megjelent az argv-ben" ;; *) pass "egyik curl ARGV-je sem tartalmazza a PAT-ot" ;; esac
case "$(cat "$MARKER.argv")" in *"$DASH_TOKEN"*) fail "a dashboard-token sincs argv-ben" "megjelent" ;; *) pass "a dashboard-token sincs argv-ben" ;; esac

echo "== 2. a token VISZONT eljut a curl-hoz, a -K configon at =="
grep -qx "header = \"Authorization: Bearer $FAKE_PAT\"" "$MARKER.cfg" && pass "a PAT a -K configban erkezik" || fail "a PAT a -K configban erkezik" "nincs ott"
grep -qx "header = \"Authorization: Bearer $DASH_TOKEN\"" "$MARKER.cfg" && pass "a dashboard-token a vault-hivas -K configjaban erkezik" || fail "dashboard-token a configban" "nincs ott"

echo "== 3. SUPAQLOGINROLE1010: csak a database/query, login-role soha, CLI soha =="
check_eq "a lekerdezes a Management API database/query vegpontjara megy" \
  "$(grep -c "URL: https://api.supabase.com/v1/projects/$REF/database/query" "$MARKER.urls")" "1"
grep -q "login-role" "$MARKER.urls" && fail "a cli/login-role NEM hivodik" "hivodott" || pass "a cli/login-role NEM hivodik"
[ -f "$MARKER.cli" ] && fail "a supabase CLI NEM fut" "$(cat "$MARKER.cli")" || pass "a supabase CLI NEM fut"
grep -q -- "-X POST" "$MARKER.argv" && pass "POST" || fail "POST" "nincs -X POST"

echo "== 4. a torzs: query JSON-ban, read_only csak --read-only-val =="
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d=={"query":"select 1"}, d' "$MARKER.body" \
  && pass "alapbol {query} (read_only nelkul, mint eddig)" || fail "torzs" "$(cat "$MARKER.body")"
teardown
setup
run "$REF" "select '\"x\" \\ y'" --read-only >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d=={"query":"select '"'"'\"x\" \\ y'"'"'","read_only":True}, d' "$MARKER.body" \
  && pass "--read-only -> read_only:true, idezojel/backslash epen" || fail "read_only torzs" "$(cat "$MARKER.body")"
teardown

echo "== 5. a kimenet a CLI alakja: {boundary, rows, warning}, rendezett kulcsok =="
setup
OUT="$(run "$REF" "select 1" 2>/dev/null)"
python3 - "$OUT" <<'PY' && pass "rows + boundary + warning, a sor kulcsai rendezve" || fail "kimenet-alak" "$OUT"
import json, sys
d = json.loads(sys.argv[1])
assert set(d) == {"boundary", "rows", "warning"}, d
assert d["rows"] == [{"a": "x", "b": 1}] and list(d["rows"][0]) == ["a", "b"], d["rows"]
assert d["boundary"] in d["warning"]
PY
teardown
setup
export STUB_RESP='[]'
OUT="$(run "$REF" "select 1 where false" 2>/dev/null)"; RC=$?
check_eq "ures eredmeny: exit 0" "$RC" "0"
python3 -c 'import json,sys; assert json.loads(sys.argv[1])["rows"]==[]' "$OUT" && pass "ures eredmeny: rows == []" || fail "ures rows" "$OUT"
teardown

echo "== 6. API-hiba: exit 1, es a kimenetben NINCS rows (a hivok ebbol tudjak, hogy hiba) =="
setup
export STUB_HTTP=400 STUB_RESP='{"message":"ERROR: 42P01: relation \"nincs\" does not exist"}'
OUT="$(run "$REF" "select * from nincs" 2>/dev/null)"; RC=$?
check_eq "exit 1" "$RC" "1"
python3 - "$OUT" <<'PY' && pass "_tag Error, uzenet atjon, rows nincs" || fail "hiba-alak" "$OUT"
import json, sys
d = json.loads(sys.argv[1])
assert d["_tag"] == "Error" and "rows" not in d and "42P01" in d["error"]["message"] and d["error"]["status"] == "400", d
PY
teardown
setup
export STUB_CURL_FAIL=1
OUT="$(run "$REF" "select 1" 2>/dev/null)"; RC=$?
check_eq "atviteli hiba: exit 1" "$RC" "1"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert "rows" not in d and d["_tag"]=="Error"' "$OUT" && pass "atviteli hiba: nincs rows" || fail "atviteli hiba alak" "$OUT"
teardown

echo "== 7. FAIL-CLOSED: ures vault -> exit 3, es API-hivas NINCS =="
setup
export VAULT_EMPTY=1
run "$REF" "select 1" >/dev/null 2>&1
check_eq "exit 3" "$?" "3"
grep -q "database/query" "$MARKER.urls" && fail "az API NEM hivodott" "hivodott" || pass "az API NEM hivodott"
teardown

echo "== 8. FAIL-CLOSED: hianyzo dashboard-token -> exit 3 =="
setup
rm -f "$TMP/store/.dashboard-token"
run "$REF" "select 1" >/dev/null 2>&1
check_eq "exit 3" "$?" "3"
[ -f "$MARKER.urls" ] && fail "semmilyen curl NEM futott" "futott" || pass "semmilyen curl NEM futott"
teardown

echo "== 9. hasznalat -> exit 2 (NEM 3: a 'nem mertem' es a 'rosszul hivtak' kulon allapot) =="
setup
run >/dev/null 2>&1; check_eq "project-ref nelkul exit 2" "$?" "2"
run "$REF" >/dev/null 2>&1; check_eq "SQL nelkul exit 2" "$?" "2"
run "$REF" "" >/dev/null 2>&1; check_eq "ures SQL exit 2" "$?" "2"
run "Abc/../x" "select 1" >/dev/null 2>&1; check_eq "ervenytelen project-ref exit 2" "$?" "2"
# 20 characters, lowercase, but with a path in it: only the character check stops it.
run "abcdefghij/../klmnop" "select 1" >/dev/null 2>&1; check_eq "20 karakteres, de utat tartalmazo project-ref exit 2" "$?" "2"
run "$REF" "select 1" --linked >/dev/null 2>&1; check_eq "ismeretlen kapcsolo exit 2 (nem nyeljuk el)" "$?" "2"
run "$REF" "select 1" --output-format table >/dev/null 2>&1; check_eq "--output-format table exit 2" "$?" "2"
[ -f "$MARKER.urls" ] && fail "hasznalati hibanal semmi nem futott" "futott curl" || pass "hasznalati hibanal semmi nem futott"
run "$REF" "select 1" --output-format json >/dev/null 2>&1; check_eq "--output-format json (a hivok 23 helyen adjak) elfogadva" "$?" "0"
teardown

echo "== 9b. a cel-host FIX: kornyezetbol nem irhato at (a PAT ebben a keresben megy) =="
setup
SUPABASE_API_ORIGIN="https://evil.example" API="https://evil.example" run "$REF" "select 1" >/dev/null 2>&1
grep -q "evil" "$MARKER.urls" && fail "a PAT nem mehet mas hostra" "elment: $(cat "$MARKER.urls")" || pass "a PAT nem mehet mas hostra (env-felulirassal sem)"
teardown

echo "== 10. MUTACIOS KONTROLL: ha a PAT -H-val argv-be kerulne, az 1. teszt BUKNA =="
setup
python3 - "$TMP/scripts/supabase-q.sh" "$TMP/scripts/mutant.sh" <<'PY'
import sys
s = open(sys.argv[1]).read()
old = '      -K /dev/fd/3 \\\n'
assert s.count(old) == 1
open(sys.argv[2], "w").write(s.replace(old, '      -H "Authorization: Bearer $PAT" \\\n'))
PY
(cd "$TMP" && sh scripts/mutant.sh "$REF" "select 1" >/dev/null 2>&1)
case "$(cat "$MARKER.argv" 2>/dev/null)" in
  *"$FAKE_PAT"*) pass "a mutans TENYLEG kiszivarogtatja az argv-be (tehat az 1. teszt fog)" ;;
  *) fail "a mutans kiszivarogtat" "a fixture nem diszkriminal -- az 1. teszt dekoracio lenne" ;;
esac
teardown

if [ "$FAILS" -gt 0 ]; then echo; echo "$FAILS FAILED"; exit 1; fi
echo; echo "All supabase-q tests passed."
