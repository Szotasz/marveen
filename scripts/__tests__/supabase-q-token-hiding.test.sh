#!/bin/bash
# Contract tests for scripts/supabase-q.sh (PATSZIVARGAS912).
# Run: bash scripts/__tests__/supabase-q-token-hiding.test.sh
#
# THE PROPERTY UNDER TEST is not "the query works" -- it is that the PAT never
# becomes durable text. Measured 2026-09-14: all 167 leaks of the account-level
# token had one shape, an agent typing `export SUPABASE_ACCESS_TOKEN="<value>"`
# into its own command, which lands in the transcript AND in
# tool_call_log.input_summary. So the tests below assert the ABSENCE of the
# secret in every channel an agent or a log can see, and its PRESENCE only in
# the child's environment.
#
# Hermetic: `curl`, `supabase` and the vault are stubs on PATH, ROOT is a
# throwaway dir, and no network or real secret is involved.
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

setup() {
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/scripts" "$TMP/store" "$TMP/bin"
  cp "$REPO/scripts/supabase-q.sh" "$TMP/scripts/"
  printf 'dashboard-token-xyz' > "$TMP/store/.dashboard-token"
  # curl stub: answers the vault call with the fake PAT (or empty, on demand)
  cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
if [ -n "\${VAULT_EMPTY:-}" ]; then echo '{"value":""}'; else echo '{"value":"$FAKE_PAT"}'; fi
STUB
  # supabase stub: records argv and whether the env carried the token, WITHOUT
  # echoing the value -- a test that prints the secret to prove it is hidden
  # would be its own leak.
  cat > "$TMP/bin/supabase" <<'STUB'
#!/bin/sh
echo "ARGV: $*" > "$MARKER.argv"
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  printf '%s' "$SUPABASE_ACCESS_TOKEN" | shasum -a 256 | cut -c1-12 > "$MARKER.envsha"
else
  echo "NINCS-ENV" > "$MARKER.envsha"
fi
echo '{"rows":[]}'
STUB
  chmod +x "$TMP/bin/curl" "$TMP/bin/supabase"
  MARKER="$TMP/called"
  export MARKER PATH="$TMP/bin:$PATH"
}
teardown() { rm -rf "$TMP"; unset VAULT_EMPTY; }

echo "== 1. a token SEHOL nem jelenik meg a kimenetben =="
setup
OUT="$(cd "$TMP" && sh scripts/supabase-q.sh proj-ref "select 1" 2>&1)"
RC=$?
check_eq "lefutott (exit 0)" "$RC" "0"
case "$OUT" in *"$FAKE_PAT"*) fail "a stdout/stderr NEM tartalmazza a tokent" "megjelent" ;; *) pass "a stdout/stderr NEM tartalmazza a tokent" ;; esac
case "$(cat "$MARKER.argv")" in *"$FAKE_PAT"*) fail "az ARGV nem tartalmazza a tokent" "megjelent az argv-ben" ;; *) pass "az ARGV nem tartalmazza a tokent" ;; esac

echo "== 2. a token VISZONT eljut a gyerekhez, kornyezeten at =="
WANT="$(printf '%s' "$FAKE_PAT" | shasum -a 256 | cut -c1-12)"
check_eq "a gyerek env-jeben a HELYES token all (sha-elotag)" "$(cat "$MARKER.envsha")" "$WANT"
teardown

echo "== 3. FAIL-CLOSED: ures vault -> exit 3, es supabase EL SEM INDUL =="
setup
export VAULT_EMPTY=1
(cd "$TMP" && sh scripts/supabase-q.sh proj-ref "select 1" >/dev/null 2>&1)
check_eq "exit 3" "$?" "3"
[ -f "$MARKER.argv" ] && fail "a supabase NEM indult el" "elindult" || pass "a supabase NEM indult el"
teardown

echo "== 4. FAIL-CLOSED: hianyzo dashboard-token -> exit 3 =="
setup
rm -f "$TMP/store/.dashboard-token"
(cd "$TMP" && sh scripts/supabase-q.sh proj-ref "select 1" >/dev/null 2>&1)
check_eq "exit 3" "$?" "3"
[ -f "$MARKER.argv" ] && fail "a supabase NEM indult el" "elindult" || pass "a supabase NEM indult el"
teardown

echo "== 5. hasznalati hiba -> exit 2 (NEM 3: a 'nem mertem' es a 'rosszul hivtak' kulon allapot) =="
setup
(cd "$TMP" && sh scripts/supabase-q.sh >/dev/null 2>&1); check_eq "project-ref nelkul exit 2" "$?" "2"
(cd "$TMP" && sh scripts/supabase-q.sh proj-ref >/dev/null 2>&1); check_eq "SQL nelkul exit 2" "$?" "2"
teardown

echo "== 6. MUTACIOS KONTROLL: ha a token ARGV-be kerulne, az 1. teszt BUKNA =="
setup
sed 's|SUPABASE_ACCESS_TOKEN="$PAT" exec supabase db query "$@"|exec supabase db query "$@" --token "$PAT"|' \
  "$TMP/scripts/supabase-q.sh" > "$TMP/scripts/mutant.sh"
(cd "$TMP" && sh scripts/mutant.sh proj-ref "select 1" >/dev/null 2>&1)
case "$(cat "$MARKER.argv" 2>/dev/null)" in
  *"$FAKE_PAT"*) pass "a mutans TENYLEG kiszivarogtatja az argv-be (tehat az 1. teszt fog)" ;;
  *) fail "a mutans kiszivarogtat" "a fixture nem diszkriminal -- az 1. teszt dekoracio lenne" ;;
esac
teardown

if [ "$FAILS" -gt 0 ]; then echo; echo "$FAILS FAILED"; exit 1; fi
echo; echo "All supabase-q token-hiding tests passed."
