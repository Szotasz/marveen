#!/usr/bin/env bash
# Fej-aktivitas pillanatkep -- a MUNKA-MOTOR hianyzo emlekezete.
#
# Kimenet: soronkent egy fej, `<nev> <contextTokens> <in_progress kartyak szama> <ures-prompt 0/1>`,
#          ES a KULONBSEG az elozo korhoz kepest a STDERR-re, emberi alakban.
#          A "ALL:" sorok azok a fejek, akiket meg kell nezni.
#
# MIERT LETEZIK (merve 2026-08-14 00:2x):
#   Az `akka` a cleartext-jelentese vegen kiirta, hogy "Visszaallok a 0ab6e3d2-re" -- es a kor
#   OTT VEGET ERT. NEGYVEN PERCIG allt ures prompton, 202 030 tokennel VALTOZATLANUL, mikozben a
#   tablan a kartyaja `in_progress` volt.
#   EGYIK MEGLEVo DETEKTOR SEM FOGTA MEG:
#     * pending-sor kora        -> ures sor (senki nem irt neki)
#     * pane-szelesseg / footer -> a footer teljes volt
#     * friss-ablak jel         -> a contextTokens 202k, NEM None
#     * nulla-komment `waiting` -> a kartya `in_progress`, es van rajta komment
#   AZ EGYETLEN JEL: a contextTokens KET MERES KOZOTT valtozatlan + ures prompt + nyitott kartya.
#   Es epp ehhez hianyzott az ELoZo ERTEK -- a heartbeat minden kort nullarol kezd.
#
# 🛑 A `contextTokens` KULCSA A `name`, NEM `id` -- a `/api/agents` rekordban nincs `id` mezo.
#   Aki `id`-vel kulcsol, minden fejre None-t kap, es MINDEN fej "valtozott"-nak latszik --
#   vagyis epp a nema fejet tunteti el. Az elaltato irany.
#
# Onteszt: bash scripts/agent-activity-snapshot.sh --self-test

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_FILE="${AGENT_SNAPSHOT_FILE:-$REPO_ROOT/store/agent-activity-snapshot.txt}"
DB="${CLAUDECLAW_DB:-$REPO_ROOT/store/claudeclaw.db}"
TOKEN_FILE="${DASHBOARD_TOKEN_FILE:-$REPO_ROOT/store/.dashboard-token}"

gyujt() {
  local tok; tok="$(cat "$TOKEN_FILE" 2>/dev/null)"
  curl -s -H "Authorization: Bearer $tok" http://localhost:3420/api/agents 2>/dev/null \
    | AGENT_DB="$DB" python3 -c '
import json, os, subprocess, sys

try:
    agents = json.load(sys.stdin)
except Exception:
    sys.exit(0)                      # nincs adat -> ures kimenet, a hivo latja

db = os.environ["AGENT_DB"]
for a in agents:
    n = a.get("name")                # 🛑 name, NEM id -- a rekordban nincs id mezo
    if not n or not a.get("running"):
        continue
    ctx = a.get("contextTokens")
    ctx = "None" if ctx is None else str(ctx)

    q = ("select count(*) from kanban_cards where assignee=? and archived_at is null "
         "and status in (\x27in_progress\x27,\x27testing\x27)")
    try:
        nyitott = subprocess.run(["sqlite3", db, q.replace("?", "\x27" + n + "\x27")],
                                 capture_output=True, text=True).stdout.strip() or "0"
    except Exception:
        nyitott = "?"

    try:
        pane = subprocess.run(["tmux", "capture-pane", "-p", "-t", "agent-" + n],
                              capture_output=True, text=True).stdout
        sorok = [s for s in pane.split("\n") if s.strip()]
        # ures prompt: a footer FOLOTTI utolso erdemi sor maga a `❯` prompt
        ures = "1" if any(s.strip() == "❯" for s in sorok[-6:]) else "0"
    except Exception:
        ures = "?"

    print(n, ctx, nyitott, ures)
'
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  ki="$(gyujt)"
  # POZITIV KONTROLL: legalabb egy fejnek meg kell jelennie, kulonben a gyujtes hibas.
  n=$(printf '%s\n' "$ki" | grep -c . || true)
  if [ "${n:-0}" -gt 0 ]; then echo "  OK    a gyujtes $n futo fejet ert el"; else
    echo "  BUKIK a gyujtes NULLA fejet ert el -- a MEROD hibas, nem a flotta"; fail=1; fi
  # A sor-alak: negy mezo
  rossz=$(printf '%s\n' "$ki" | awk 'NF && NF!=4' | wc -l | tr -d ' ')
  if [ "$rossz" = 0 ]; then echo "  OK    minden sor negy mezos"; else
    echo "  BUKIK $rossz sor nem negy mezos"; fail=1; fi
  # ELLEN-PROBA: nem letezo fej neve NE szerepeljen
  if printf '%s\n' "$ki" | grep -q '^nincsilyenfej '; then
    echo "  BUKIK kitalalt fej a kimenetben"; fail=1; else
    echo "  OK    nincs kitalalt fej a kimenetben"; fi
  [ "$fail" = 0 ] && echo "onteszt: MIND ZOLD" || echo "onteszt: VAN BUKO SOR"
  exit "$fail"
fi

uj="$(gyujt)"
[ -z "$uj" ] && { echo "nincs adat (a dashboard nem valaszolt)" >&2; exit 1; }

if [ -f "$SNAP_FILE" ]; then
  # 🛑 A FRISS ADAT FAJLBAN MEGY AT, NEM STDIN-EN. Az elso valtozat `python3 - <<'PYEOF' <<<"$uj"`
  # alakot hasznalt: KET bemenet-atiranyitas ugyanarra a leiroa, es a MASODIK nyer -- vagyis a
  # Python a SZKRIPT helyett az ADATOT kapta, `SyntaxError`-t irt a stderr-re, es a kulonbseg-logika
  # SOHA NEM FUTOTT LE. A script kimenete es kilepesi kodja valtozatlanul jonak latszott.
  # A sajat ellen-probam is ATENGEDTE: nullat szamolt, de azert, mert semmi nem futott. (Merve.)
  UJ_TMP="$(mktemp)"
  printf '%s\n' "$uj" > "$UJ_TMP"
  # A KULONBSEG a lenyeg, nem a pillanatfelvetel. "ALL" = ctx VALTOZATLAN + ures prompt +
  # van nyitott kartya. Barmelyik hianyzik -> a fej dolgozik, hagyd bekeen.
  AGENT_PREV="$SNAP_FILE" AGENT_NEW="$UJ_TMP" python3 - >&2 <<'PYEOF'
import os, sys

prev = {}
try:
    for s in open(os.environ["AGENT_PREV"]):
        r = s.split()
        if len(r) == 4:
            prev[r[0]] = r
except FileNotFoundError:
    pass

for s in open(os.environ["AGENT_NEW"]):
    r = s.split()
    if len(r) != 4:
        continue
    nev, ctx, nyitott, ures = r
    p = prev.get(nev)
    if not p:
        print(f"  uj    {nev}: nincs elozo meres")
        continue
    if ctx == p[1] and ures == "1" and nyitott not in ("0", "?"):
        print(f"  ALL:  {nev} -- ctx VALTOZATLAN ({ctx}), ures prompt, {nyitott} nyitott kartya")
    elif ctx != p[1]:
        print(f"  megy  {nev}: {p[1]} -> {ctx}")
    else:
        print(f"  ---   {nev}: ctx valtozatlan, de nem all (ures={ures}, nyitott={nyitott})")
PYEOF
  rm -f "$UJ_TMP"
else
  echo "elso futas -- nincs mihez merni, a kovetkezo kor mar osszevet" >&2
fi

printf '%s\n' "$uj" > "$SNAP_FILE"
printf '%s\n' "$uj"
