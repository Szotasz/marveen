#!/bin/bash
# scripts/hook-scope-audit.py must catch the ONE thing that makes a hook run
# twice, and stay quiet about the thing that does not.
#
# Measured with a two-scope probe on 2026-09-05 (claude -p, one prompt):
#   identical command string in both scopes -> 1 firing (Claude Code dedupes)
#   different spelling, same script         -> 2 firings
# So byte-identical registrations across scopes are FINE and must not be
# reported; only a differing spelling of the same script is the defect.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT="$ROOT/scripts/hook-scope-audit.py"
PASS=0; FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

WRAPPED="bash -c '[ -f /abs/scripts/hooks/provenance-gate.py ] && exec python3 /abs/scripts/hooks/provenance-gate.py; exit 0'"
PROJECT_SPELLING='python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/provenance-gate.py"'

write_scope() { # path, command
  mkdir -p "$(dirname "$1")"
  python3 - "$1" "$2" <<'PY'
import json,sys
json.dump({"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":sys.argv[2]}]}]}},
          open(sys.argv[1],"w"), indent=2)
PY
}

run() { python3 "$AUDIT" --pair="probe:$1:$2" 2>&1; }

# (a) same script, two spellings across the scopes -> reported, exit 1
write_scope "$T/a/user.json" "$WRAPPED"
write_scope "$T/a/proj.json" "$PROJECT_SPELLING"
OUT="$(run "$T/a/user.json" "$T/a/proj.json")"; RC=$?
[ "$RC" = "1" ] && ok "elteru irasmod: exit 1" || bad "elteru irasmod: exit $RC, vart 1"
echo "$OUT" | grep -q "provenance-gate.py" && ok "elteru irasmod: megnevezi a scriptet" || bad "elteru irasmod: nem nevezi meg ($OUT)"
echo "$OUT" | grep -q "UserPromptSubmit" && ok "elteru irasmod: megnevezi az esemenyt" || bad "elteru irasmod: nincs esemeny"

# (b) byte-identical in both scopes -> NOT reported (measured: fires once)
write_scope "$T/b/user.json" "$WRAPPED"
write_scope "$T/b/proj.json" "$WRAPPED"
run "$T/b/user.json" "$T/b/proj.json" >/dev/null 2>&1
[ $? = "0" ] && ok "azonos parancsszoveg: exit 0 (nem hiba)" || bad "azonos parancsszoveg: hibat jelzett, pedig egyszer fut"

# (c) different scripts -> not reported
write_scope "$T/c/user.json" "$WRAPPED"
write_scope "$T/c/proj.json" 'python3 /abs/scripts/hooks/staleness-guard.py'
run "$T/c/user.json" "$T/c/proj.json" >/dev/null 2>&1
[ $? = "0" ] && ok "kulonbozo script: exit 0" || bad "kulonbozo script: hibat jelzett"

# (d) same script twice INSIDE one file, two spellings -> reported
mkdir -p "$T/d"
python3 - "$T/d/user.json" "$WRAPPED" "$PROJECT_SPELLING" <<'PY'
import json,sys
json.dump({"hooks":{"UserPromptSubmit":[
  {"hooks":[{"type":"command","command":sys.argv[2]}]},
  {"hooks":[{"type":"command","command":sys.argv[3]}]}]}}, open(sys.argv[1],"w"), indent=2)
PY
write_scope "$T/d/proj.json" 'python3 /abs/scripts/hooks/staleness-guard.py'
OUT="$(run "$T/d/user.json" "$T/d/proj.json")"; RC=$?
[ "$RC" = "1" ] && ok "egy fajlon belul ketszer: exit 1" || bad "egy fajlon belul ketszer: exit $RC"
echo "$OUT" | grep -q "egy fajlon belul" && ok "egy fajlon belul: megmondja hol" || bad "egy fajlon belul: nem mondja meg hol"

# (e) same script under DIFFERENT events -> not a double run
write_scope "$T/e/user.json" "$WRAPPED"
mkdir -p "$T/e"
python3 - "$T/e/proj.json" "$PROJECT_SPELLING" <<'PY'
import json,sys
json.dump({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":sys.argv[2]}]}]}},
          open(sys.argv[1],"w"), indent=2)
PY
run "$T/e/user.json" "$T/e/proj.json" >/dev/null 2>&1
[ $? = "0" ] && ok "mas esemeny: exit 0" || bad "mas esemeny: hibat jelzett"

# (f) a missing or unparseable scope file must not crash the audit
write_scope "$T/f/user.json" "$WRAPPED"
run "$T/f/user.json" "$T/f/nincs-ilyen.json" >/dev/null 2>&1
[ $? = "0" ] && ok "hianyzo fajl: nem omlik ossze" || bad "hianyzo fajl: nem 0"
mkdir -p "$T/g"; echo '{ nem json' > "$T/g/proj.json"
write_scope "$T/g/user.json" "$WRAPPED"
run "$T/g/user.json" "$T/g/proj.json" >/dev/null 2>&1
[ $? = "0" ] && ok "olvashatatlan fajl: nem omlik ossze" || bad "olvashatatlan fajl: nem 0"

echo ""
echo "hook-scope-audit: $PASS ok, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
