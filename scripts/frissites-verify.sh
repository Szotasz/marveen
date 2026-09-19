#!/bin/bash
# Post-restart verification for the v1.36.0 upgrade, as ONE script with TWO phases.
#
# WHY A SCRIPT AND NOT A CHECKLIST: when the before and after snapshots are produced
# by two hands in two formats, the format difference itself manufactures a false
# diff. One script means the only thing that can differ is the content.
#
#   bash scripts/frissites-verify.sh elotte 1.38.0   <- run IMMEDIATELY before stop.sh
#   bash scripts/frissites-verify.sh utana  1.38.0   <- run after start.sh comes up
#
# THE TARGET VERSION IS AN ARGUMENT, AND ON PURPOSE. The backup directory used to be
# hardcoded to backups/frissites-v1360 while the file names inside come from the
# PHASE only and carry no version -- so a v1.38.0 run would have overwritten the
# 2026-09-02 evidence in place, under identical file names. Deriving the version
# from package.json is not a fix either: measured 2026-09-16 it reads 1.37.0 on the
# deployed branch and 1.38.0 on develop, so it changes BETWEEN the two phases and
# would send them to different directories -- and the comparison would then report
# "NINCS elotte-pillanatkep" as if the operator had skipped it.
#
# Read-only with respect to the install: it never writes to store/ or to any
# settings file. Output goes to backups/frissites-<verzio>/verify-<phase>.txt and,
# for `utana`, the comparison.
set -uo pipefail
ROOT=/Users/macmini/marveen
FAZIS="${1:-}"
CEL_VERZIO="${2:-}"
[ "$FAZIS" = elotte ] || [ "$FAZIS" = utana ] || { echo "hasznalat: $0 elotte|utana <cel-verzio>" >&2; exit 64; }
# A konyvtar feloldasa ES orzese kulon szkriptben, mert igy tesztelheto (lasd
# src/__tests__/built-commit-provenance.test.ts). Ha mas verziohoz tartozo mappara
# mutatna, NEM nulla kilepokoddal all meg, es ide se jutunk el.
BK=$(node "$ROOT/scripts/frissites-backup-dir.mjs" --verzio "$CEL_VERZIO" --root "$ROOT" --stamp) || exit $?
OUT="$BK/verify-$FAZIS.txt"
TMP="$BK/.verify-$FAZIS.body"
# 0 = a dist-eredet kerdese rendben; nem nulla = HIANYZIK vagy ELTERES (lasd a vegen).
BUILT_COMMIT_HIBA=0
TOK=$(cat "$ROOT/store/.dashboard-token")
cd "$ROOT" || exit 1

dec() {
  python3 -c '
import sys, json
s = sys.stdin.read().strip()
if not s:
    print("allow"); raise SystemExit
try:
    print(json.loads(s).get("hookSpecificOutput", {}).get("permissionDecision", "allow"))
except Exception:
    print("allow")
'
}

{
echo "=== FAZIS: $FAZIS   ido: $(date '+%Y-%m-%d %H:%M:%S %Z')   (rendszerorabol) ==="
echo
echo "--- 1) git / build allapot ---"
echo "HEAD           : $(git rev-parse HEAD)"
# A dist eredetet NEM egy csendes `cat ... || echo HIANYZIK` mondja meg. A hianyzo
# marker sajat kilepokoddal all meg (lasd scripts/built-commit-check.mjs), mert a
# hianyzo bizonyitek ugyanolyan nyugodt sorkent olvasodott a riportban, mint a siker.
if node scripts/built-commit-check.mjs dist/.built-commit .; then :; else BUILT_COMMIT_HIBA=$?; fi
echo "package verzio : $(node -e 'console.log(require("./package.json").version)')"
echo "dirty          : $(git status --porcelain | wc -l | tr -d ' ')"

echo
echo "--- 2) DIFFERENCIALO HIVAS: a BETOLTOTT kod adja, nem egy fajl amit mi irunk ---"
echo "GET /api/kanban/heartbeat-summary"
# Kulon lepesben mentjuk, hogy a HALOZATI hiba es a PARSE hiba megkulonboztetheto legyen.
if curl -s --max-time 10 -H "Authorization: Bearer $TOK" \
     "http://localhost:3420/api/kanban/heartbeat-summary" -o "$TMP"; then
  python3 - "$TMP" <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("  valasz nem JSON:", e); raise SystemExit
c = d.get("counts", {})
print("  counts kulcsok :", sorted(c.keys()))
print("  db_size_mb     :", c.get("db_size_mb", "NINCS"))
print("  planned        :", c.get("planned", "NINCS"))
print("  VERDIKT        :", "UJ KOD FUT" if "db_size_mb" in c else "REGI KOD FUT")
PY
else
  echo "  a szolgaltatas NEM valaszolt (curl hiba) -- ez mas hiba, mint a hianyzo mezo"
fi

echo
echo "--- 3) szolgaltatas + agens-sessionok ---"
echo "dashboard /api/agents HTTP : $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $TOK" http://localhost:3420/api/agents)"
echo "token NELKUL (401 a helyes): $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:3420/api/agents)"
echo "tmux sessionok:"
tmux ls 2>/dev/null | sed 's/^/  /' || echo "  (nincs tmux session)"

echo
echo "--- 4) KAPU-KONTROLL: tagitott kapunal a tiszta futas semmit nem bizonyit ---"
echo "    (minden sor olyan bemenet, ami a merge ELOTT is tiltott volt -- lasd verify-elotte)"
for U in https://valami-random-domain-9x.example https://mnb.hu/arfolyamok; do
  D=$(printf '{"tool_name":"WebFetch","tool_input":{"url":"%s"},"agent_type":""}' "$U" | node scripts/hooks/egress-gate.mjs 2>/dev/null | dec)
  printf "  egress  fo agens   %-42s -> %-6s %s\n" "$U" "$D" "$([ "$D" = deny ] && echo OK || echo '<-- ATENGEDTE, ALLJ MEG')"
done
D=$(printf '{"tool_name":"WebFetch","tool_input":{"url":"https://valami-random-domain-9x.example"},"agent_type":"quarantine-reader"}' | node scripts/hooks/egress-gate.mjs 2>/dev/null | dec)
printf "  egress  karanten   %-42s -> %-6s %s\n" "(barmely domain)" "$D" "$([ "$D" = allow ] && echo OK || echo '<-- TILTOTT, pedig engednie kell')"
for T in mcp__gmail__send_email mcp__gmail__delete_emails; do
  D=$(printf '{"tool_name":"%s","tool_input":{}}' "$T" | node scripts/email-send-gate.mjs 2>/dev/null | dec)
  printf "  email              %-42s -> %-6s %s\n" "$T" "$D" "$([ "$D" = deny ] && echo OK || echo '<-- ATENGEDTE, ALLJ MEG')"
done
D=$(printf '{"tool_name":"mcp__gmail__list_emails","tool_input":{}}' | node scripts/email-send-gate.mjs 2>/dev/null | dec)
printf "  email  NEG.KONTROLL %-41s -> %-6s %s\n" "mcp__gmail__list_emails" "$D" "$([ "$D" = allow ] && echo OK || echo '<-- TULZAR')"
python3 - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location("o", "scripts/hooks/outgoing-copy-gate.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hit = bool(m.audit("koszonom szepen a valaszt es a segitseget"))
print(f"  outgoing-copy      {'ekezethianyos mondat':42} -> {'TALALAT' if hit else 'atengedte':6} " + ("OK" if hit else "<-- ATENGEDTE, ALLJ MEG"))
miss = bool(m.audit("a 429-es kod"))
print(f"  o-copy NEG.KONTROLL {'szamtoldalek (429-es)':41} -> {'TALALAT' if miss else 'atmegy':6} " + ("<-- TULZAR" if miss else "OK"))
PY

echo
echo "--- 5) bekotes-epseg: minden hivatkozott hook-szkript es ertelmezo letezik-e ---"
python3 - <<'PY'
import json, os, re, glob, shutil
files = ['.claude/settings.json', os.path.expanduser('~/.claude/settings.json')] + sorted(glob.glob('agents/*/.claude/settings.json'))
total = missing = 0; miss = []; interp_bad = []; reg = set()
for f in files:
    try:
        d = json.load(open(f))
    except Exception:
        continue
    for arr in (d.get('hooks') or {}).values():
        for entry in arr:
            for h in entry.get('hooks', []):
                # A hatarolo irasjeleket LE KELL VAGNI. A .mjs kapuk parancsa tartalmaz egy
                # HIBAUZENET-SZOVEGET is, amiben az ertelmezo utja zarojelben es ponttal all
                # ("... nem talalhato (/opt/.../node). A kapu ..."). Ezek nyers szotagolasa
                # egy ALLANDO hamis pozitivot ad -- egy ilyen sor egy het alatt leszoktat az
                # egesz ellenorzesrol, es akkor a VALODI hiany is atcsuszik ugyanott.
                for raw in h.get('command', '').split():
                    t = raw.strip('"\'()[]{},.;:')
                    if re.search(r'\.(mjs|py|sh)$', t):
                        p = t.replace('$CLAUDE_PROJECT_DIR', '/Users/macmini/marveen')
                        total += 1
                        reg.add((f, p))
                        if not os.path.isfile(p):
                            missing += 1; miss.append(p)
                    elif t.startswith('/') and t.endswith('/node'):
                        if not os.path.isfile(t):
                            interp_bad.append(t)
                    elif t in ('python3', 'bash'):
                        if shutil.which(t) is None:
                            interp_bad.append(t)
# A NEVEZO KULONBOZO ATTOL FUGGOEN, MIT SZAMOLSZ, ezert mindketto ki van irva.
# A nyers elofordulas-szam felduzzad, mert a burkolo HIBAUZENET-SZOVEGE is tartalmazza
# ugyanazokat az utakat; a dontheto szam az EGYEDI (settings-fajl, szkript) parok szama.
print(f"  egyedi (settings-fajl, szkript) regisztracio : {len(reg)}")
print(f"  nyers ut-elofordulas a parancsokban          : {total}  (a tobblet a hibauzenet-szoveg)")
print(f"  HIANYZO szkript                              : {missing}")
for p in miss:
    print("    HIANYZIK:", p)
print(f"  hianyzo ertelmezo                            : {len(set(interp_bad))} {sorted(set(interp_bad)) or ''}")
PY

echo
echo "--- 6) utemezes-pillanatkep ---"
python3 scripts/schedule-snapshot.py "$BK/schedule-$FAZIS.txt" "$FAZIS" 2>&1 | tail -4
} > "$OUT" 2>&1

cat "$OUT"

if [ "$FAZIS" = utana ]; then
  echo
  echo "############ OSSZEVETES ############"
  # FRISSESSEG-KAPU. Az 'elotte' pillanatkepet KOZVETLENUL a stop.sh ELE kell futtatni.
  # Egy oraval korabbi alapvonal KET IRANYBA is hamis: (a) hamis zold, mert a kozben
  # keletkezett task_runs sorok "restart utaninak" latszanak az elavult vagoponthoz kepest;
  # (b) hamis "allj meg", mert a datumhoz kotott egyszer-futo elemek kozben JOGOSAN lefutnak
  # es eltunnek. Ezt a szkript meri meg, nem az emlekezet -- egy proba-futas ugyanezt a
  # fajlt irja, es a valodi meres elmaradasa igy nem tud eszrevetlen maradni.
  KOR_MP=1800
  if [ -f "$BK/schedule-elotte.txt" ]; then
    ELOTTE_KOR=$(( $(date +%s) - $(stat -f %m "$BK/schedule-elotte.txt") ))
    if [ "$ELOTTE_KOR" -gt "$KOR_MP" ]; then
      echo "  !!! AZ 'elotte' PILLANATKEP $((ELOTTE_KOR / 60)) PERCES (a hatar $((KOR_MP / 60)) perc)."
      echo "  !!! Ez NEM merce: vagy nem futott le kozvetlenul a stop.sh elott, vagy egy proba-futas"
      echo "  !!! maradt itt. Az osszevetes eredmenye NEM ertelmezheto -- ne olvasd zoldnek."
      echo
    fi
  fi
  if [ -f "$BK/schedule-elotte.txt" ]; then
    python3 - "$BK/schedule-elotte.txt" "$BK/schedule-utana.txt" <<'PY'
import json, sys
a, b = [json.load(open(p)) for p in sys.argv[1:3]]
A = {r['name']: r for r in a['schedules']}
B = {r['name']: r for r in b['schedules']}
print('  csak-elotte :', sorted(set(A) - set(B)) or 'nincs')
print('  csak-utana  :', sorted(set(B) - set(A)) or 'nincs')
print('  megvaltozott:', [n for n in set(A) & set(B) if A[n] != B[n]] or 'nincs')
print()
print('  POZITIV TESZT a scheduler eletere. A vagopont az ELOTTE task_runs_max_ts_ms:')
print('   ', a.get('task_runs_max_ts_ms'))
print('  A vagopont utani sorok szamat ES az elottieket is szamold ki -- kulonben nem')
print('  tudod, hogy a szuro szurt-e, vagy ures halmazbol jott a "talalat".')
en = [r for r in b['schedules'] if r.get('enabled')]
print(f'  enabled=True sor utana: {len(en)} / {len(b["schedules"])}')
print('  MIELOTT a "15 percen belul tuzelnie kell" varakozast leirod: nezd meg, MELYIK')
print('  enabled sor esedekes ebben az ablakban, es HANY ilyen van. Ha egy, mondd ki, hogy egy.')
PY
  else
    echo "  NINCS elotte-pillanatkep -- az 'elotte' fazis nem futott le. Az osszevetes NEM elvegezheto,"
    echo "  es egy oraval korabbi pillanatkep NEM merce (ket iranyba is hamis: lasd a frissites-skillt)."
  fi
fi

# A KILEPOKOD. A szkript eddig MINDIG 0-val tert vissza, tehat egy hivo (vagy egy
# ember, aki `&&`-del fuz utana lepest) nem tudta megkulonboztetni a tiszta futast
# attol, amikor a dist eredete ismeretlen. A `built-commit` a legolcsobb olyan jel,
# amit gepiesen el lehet donteni, ezert ez kapja az elso nem-nulla kodot.
if [ "$BUILT_COMMIT_HIBA" -ne 0 ]; then
  echo
  echo "############ ALLJ MEG ############"
  echo "  A dist eredete nem igazolt (lasd az 1) szakasz VERDIKT sorat)."
  echo "  A tobbi ellenorzes kimenete ettol meg olvashato, de a 'melyik kod fut' kerdesre"
  echo "  NEM ez a szkript adta meg a valaszt -- ne olvasd zoldnek."
  exit "$BUILT_COMMIT_HIBA"
fi
exit 0
