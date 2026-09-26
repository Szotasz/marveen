#!/bin/bash
# scripts/sms/seeme-send.py teszt -- kartya `adbabf7f`, marveen 4. kikötese: a
# negativ kontroll TUDJON MEGBUKNI (szerkezetileg kepes "nem"-et adni), ne csak
# egyszer atmenjen. Az utolso szakasz ezt EGY MUTACIOVAL igazolja: a kapu-agat
# kiveszi egy IDEIGLENES masolatbol, es ELVARJA, hogy AKKOR a teszt buktassa el
# azt, ami az eredetin PASS volt.
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/sms/seeme-send.py"

FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

run() {
  # run <to> <approval-or-empty> <stdin-text>
  local to="$1" approval="$2" text="$3"
  local args=(--to "$to" --dry-run)
  [ -n "$approval" ] && args=(--to "$to" --approval "$approval" --dry-run)
  printf '%s' "$text" | python3 "$SCRIPT" "${args[@]}" 2>&1
}

echo "--- alapveto osztalyozas es normalizalas ---"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "osztalyozas : BELSO" \
  && pass "sajat szam (+36305552860) BELSo, exit 0" \
  || fail "sajat szam BELSo varva, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 06305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "cimzett     : 36305552860" \
  && pass "06-os alak ugyanarra a kanonikus szamra normalizal, mint a +36-os" \
  || fail "06-os normalizalas varva, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "osztalyozas : BELSO" \
  && pass "csupasz 36-os alak is BELSo" \
  || fail "csupasz 36-os alak varva BELSo, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36301234567 --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "KULSO cimzett, es nincs --approval" \
  && pass "ismeretlen szam KULSo, approval nelkul elutasitva (rc=1)" \
  || fail "KULSo elutasitas varva, kaptam (rc=$rc): $out"

echo "--- hibas bemenet ---"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to "nem-egy-telefonszam" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "nem magyar mobilszam" \
  && pass "ertelmezhetetlen szam elutasitva" \
  || fail "ertelmezhetetlen szam elutasitasat vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "" | python3 "$SCRIPT" --to +36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "ures a szoveg" \
  && pass "ures STDIN elutasitva" \
  || fail "ures STDIN elutasitasat vartam, kaptam (rc=$rc): $out"

long_text="$(python3 -c "print('a'*1601)")"
out="$(printf '%s' "$long_text" | python3 "$SCRIPT" --to +36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "1601 karakter" \
  && pass "1600 karakter feletti szoveg elutasitva" \
  || fail "hossz-limit elutasitasat vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36301234567 --approval "nem-letezo-approval-id-xyz" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "az approval lekerdezese" \
  && pass "nem letezo approval-id -> lekerdezesi hiba, elutasitva" \
  || fail "nem letezo approval-id elutasitasat vartam, kaptam (rc=$rc): $out"

echo "--- mutacios kontroll (4. kikotes: a kontroll TUDJON bukni) ---"
MUT="$(mktemp /tmp/seeme-send-mutated-XXXX.py)"
trap 'rm -f "$MUT"' EXIT
# A TELJES kulso-agat kivesszuk: az `if not is_internal:` felteteltdet mindig-
# hamisra cachereljuk, tehat egy KULSO szam is BELSOKENT viselkedik -- approval
# nelkul is atmegy.
sed 's/if not is_internal:/if False:/' "$SCRIPT" > "$MUT"
if ! diff -q "$SCRIPT" "$MUT" >/dev/null 2>&1; then
  pass "a mutacio ténylegesen mas szoveget hozott letre (nem no-op sed)"
else
  fail "a sed minta NEM talalt semmit -- a mutacio nem valtoztatott a fajlon"
fi

out="$(printf '%s' "teszt" | python3 "$MUT" --to +36301234567 --dry-run 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then
  pass "MUTALT valtozat: a kapu-ag kivetelevel a KULSo szam approval NELKuL is atmegy -- a kontroll TUD bukni"
else
  fail "a mutacio nem valtoztatta meg a viselkedest (rc=$rc) -- a fenti teszt NEM ezt a kaput meri"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "OSSZES PASS"
  exit 0
else
  echo "VAN BUKOTT TESZT"
  exit 1
fi
