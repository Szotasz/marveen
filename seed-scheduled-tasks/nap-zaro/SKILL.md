---
name: nap-zaro
description: Esti napzáró. A napi naplóba beírja, ami az utolsó bejegyzés óta történt (új emlékek, mozgott kártyák), hogy a délután és az este ne maradjon ki a naplóból.
---

# Napzáró bejegyzés a napi naplóba

## Miért van ez a kör

A napi naplót a hajnali és reggeli körök írják (dream-engine, reggeli-napindító), ezért a
naplóban a nap délben véget ér, pedig délután és este is folyik a munka (NAPLODELUTAN916,
mért 2026-09-12..16: egyetlen napon sem volt bejegyzés 12:45 után). Az információ nem veszett
el, csak az emlékek és a kanban között szóródik szét. Ez a kör naponta egyszer összegyűjti és
egy bejegyzésben beírja.

**Csendes kör: a beállított csatornára NEM küld üzenetet, AKKOR SEM, ha a prompt elején
kézbesítési utasítás áll** (pl. "Az eredményt küldd el <csatorna>"). A kör terméke egy
`POST /api/daily-log` írás, nem egy üzenet, és a 3-4. lépésben nincs is jelentés-lépés.
Ez a bekezdés szándékosan NEM hivatkozik a `task-config.json`-ra: a frissítés a két fájlt
külön-külön cseréli, és a gazda által szerkesztett config (ütemezés, `enabled`) a régi
`"type"` értékkel maradhat, miközben ez a fájl frissül. A csendet ezért ennek a szövegnek kell
kimondania, függetlenül attól, mit mond a config. (A másik irány -- valódi esti jelentés a
gazdának -- védhető, de ahhoz a skillbe egy jelentés-lépés is kellene, és az termék-döntés,
nem dokumentáció-javítás.)

## Eljárás

1. **Előkészítés, és kilépés, ha ma már lefutott.** Ez a kör NEM idempotens (a napló
   append-only), ezért egy kétszer kézbesített prompt két bejegyzést írna. Ha a mai naplóban
   már van `Napzáró` bejegyzés, állj meg, és ne írj semmit.
   ```bash
PORT="$(sed -n 's/^WEB_PORT=//p' {{INSTALL_DIR}}/.env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-3420}"
TOKEN="$(cat {{INSTALL_DIR}}/store/.dashboard-token)"
TODAY="$(date +%F)"
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/daily-log?agent={{MAIN_AGENT_ID}}&date=$TODAY" \
  | python3 -c "import json,sys; rows=json.load(sys.stdin); print('MAR_LEFUTOTT' if any('Napzáró' in r['content'] for r in rows) else 'last_ts=%d' % max([r['created_at'] for r in rows] or [0]))"
   ```
   A dátumot MINDIG add meg (`date=`): a végpont alapértéke UTC-nap, este 22 és éjfél között
   az a holnapi nap lenne.

2. **Mi történt az utolsó bejegyzés óta.** A határ a mai utolsó naplóbejegyzés `created_at`-ja;
   ha ma még nincs bejegyzés, a mai nap eleje. A memória-listázás `q` nélkül fut, így NEM
   frissíti az `accessed_at`-et (a keresés igen, azt itt ne használd).
   ```bash
SINCE=<az 1. lépés last_ts értéke; ha 0, akkor: $(date -d "$TODAY 00:00" +%s)>
python3 - "$PORT" "$TOKEN" "$SINCE" <<'PY'
import json, sys, urllib.request, datetime as dt
port, token, since = sys.argv[1], sys.argv[2], int(sys.argv[3])
def get(path):
    req = urllib.request.Request(f'http://localhost:{port}{path}', headers={'Authorization': f'Bearer {token}'})
    return json.load(urllib.request.urlopen(req))
hhmm = lambda t: dt.datetime.fromtimestamp(t).strftime('%H:%M')
uj, frissitett, off = [], [], 0
while True:  # a listázás accessed_at szerint rendez, ezért a teljes halmazon szűrünk
    page = get(f'/api/memories?agent={{MAIN_AGENT_ID}}&limit=200&offset={off}')
    rows = page if isinstance(page, list) else page.get('memories', page.get('results', []))
    if not rows: break
    for m in rows:
        if m.get('agent_id') != '{{MAIN_AGENT_ID}}':
            continue
        is_uj = m.get('created_at', 0) > since
        if is_uj:
            uj.append(m)
        elif (m.get('updated_at') or 0) > since:
            frissitett.append(m)
    off += len(rows)
print(f'-- uj emlekek: {len(uj)}')
for m in sorted(uj, key=lambda m: m['created_at']):
    print(f"   {hhmm(m['created_at'])} [{m.get('category')}] {m['content'][:160]!r}")
print(f'-- frissitett emlekek: {len(frissitett)}')
for m in sorted(frissitett, key=lambda m: m['updated_at']):
    print(f"   {hhmm(m['updated_at'])} [{m.get('category')}] {m.get('updated_by')} {m['content'][:60]!r} ... {m['content'][-300:]!r}")
cards = [c for c in get('/api/kanban') if (c.get('updated_at') or 0) > since]
print(f'-- mozgott kartyak: {len(cards)}')
for c in sorted(cards, key=lambda c: c['updated_at']):
    print(f"   {hhmm(c['updated_at'])} {c['id'][:8]} {c.get('status')} {(c.get('title') or '')[:70]!r}")
PY
   ```
   **Harmadik tároló: a módosított skill- és feladat-fájlok.** Az első éles futás (2026-09-16 21:47)
   mérte: az emlékek és a kártyák NULLÁT adtak, közben két skill-patch és egy nyilvántartó-javítás
   történt, amelyek csak fájl-módosításként hagytak nyomot. Ezért ezeket is listázd:
```bash
find ~/.claude/skills ~/.claude/scheduled-tasks {{INSTALL_DIR}}/.claude/skills -name 'SKILL.md' -newermt "@$SINCE" 2>/dev/null
```
   Ha a munkád más, tartós nyilvántartó fájlba is ír (pl. lelet-nyilvántartó a `store/` alatt), azt is nézd
   meg a módosítási idejével. A gyorsan változó állapot-fájlokat (`*-state.json`) ne sorold fel.

   **Negyedik tároló: a `task_runs` tábla -- KÜLÖNBEN A HEARTBEAT-MUNKA SZERKEZETILEG
   LÁTHATATLAN.** Egy csendes heartbeat-kör definíció szerint nem ír memóriát (nincs új lelet),
   nem mozdít kártyát (level 1 = csak jelzés) és nem módosít skill-fájlt (a patchek jóváhagyásra
   várnak). Az egyetlen nyoma a state-fájl, amit a fenti bekezdés KIFEJEZETTEN kizár -- vagyis
   pont az a munka esik ki a naplóból, amiből a legtöbb van. Ugyanaz a család, mint a
   NAPLODELUTAN916 hiány, ami miatt ez a kör létezik, csak most nem a napszak a vakfolt, hanem a
   munka TÍPUSA. A state-fájl kizárása maradhat: **nem a fájlt kell listázni, hanem a FUTÁST.**
```bash
python3 -c "
import sqlite3, sys, datetime as dt
since=int(sys.argv[1])
# FIGYELEM: a task_runs.ts MILLISZEKUNDUM, a tobbi tabla idooszlopa masodperc.
# A kor SAJAT sorat kizarjuk: a 'fired' sor a kikuldeskor irodik, a prompt elott,
# tehat mindig az ablakban van, es a kor magat is listazna.
q='''SELECT name, status, COUNT(*), MIN(ts), MAX(ts) FROM task_runs
     WHERE ts > ?*1000 AND name != 'nap-zaro'
     GROUP BY name, status ORDER BY name, status'''
hm=lambda ms: dt.datetime.fromtimestamp(ms/1000).strftime('%H:%M')
for name, st, n, first, last in sqlite3.connect('{{INSTALL_DIR}}/store/claudeclaw.db').execute(q,(since,)):
    print('%-26s %-16s %4d  elso %s, utolso %s' % (name, st, n, hm(first), hm(last)))" "$SINCE"
```
   Ez megmutatja, MELYIK kör futott le az ablakban, akkor is, ha semmit nem írt. Egy sor
   egy név-státusz párt összegez: az időpontjai az első és az utolsó előfordulás, a köztes
   futások idejét nem mutatja.
   A `status` lista NYITOTT: a runner a későbbiekben új értéket is írhat. Ismeretlen értéket ne
   dobj el és ne találgass, hanem írd ki a nevével. Az ismert értékek két csoportba esnek:
   - **A kört KIKÜLDTÉK (ez számít futásnak):** `fired`, `fired_late`, `fired_busy`, és
     `sent-direct` (ágens-kör nélkül kézbesített összesítő). A kiküldés nem bizonyítja, hogy a
     kör végig is ment: `fired_busy`-nál a prompt foglalt panelbe ment, a kézbesítés épsége
     kérdéses, és egy kiküldés később `lost` sorral is lezárulhat.
   - **NEM futott:** `skipped`, `skipped-precheck`, `skipped-desktop-lock`, `missed`, `error`,
     `lost`, `lost-giveup`, `missing-retrying`.
   Egyik sem olvasható "elmaradt slot"-nak önmagában. A `missed` és a `fired_late` egy kiesés
   VÉGÉN, egyszerre keletkező visszatérés-bélyeg, és a timestampjük a visszatérés ideje, nem az
   elmaradt sloté. **A `skipped-precheck` sorokra külön figyelj: egy előszűrővel dolgozó, gyakran
   futó kör ELÁRASZTJA velük a kimenetet** (egy telepítésen mért eset, 2026-10-12, hét órás
   ablak: 211 `skipped-precheck` sor egyetlen körtől, szemben 28 `fired` sorral egy másiktól).
   Ha a bejegyzés olvasható marad, ezeket összevontan említsd.

   Ha a válasz alakja más, mint amit a szkript vár (hibaüzenet, üres lista a várt adat helyett),
   azt írd le, ne nullát: a „0 új emlék” csak akkor igaz, ha a lekérdezés sikerült.

3. **Bejegyzés írása.** Ha 0 új emlék, 0 frissített emlék, 0 mozgott kártya, 0 módosított
   skill-fájl ÉS 0 lefutott kör a `task_runs`-ban (lefutott = a fenti KIKÜLDÖTT csoport; a
   lekérdezés ennek a körnek a saját sorát már kizárja, a `skipped-precheck` és a többi NEM-futott
   státusz itt nem számít), akkor is írj egy egysoros bejegyzést
   (`nincs új tétel az utolsó bejegyzés óta`), mert így látszik, hogy a kör lefutott, és a csend
   nem kimaradás. Egyébként témák szerint csoportosíts, ne emlékenként listázz: minden téma egy
   rövid bekezdés, időponttal, az eredménnyel, és a kártya-azonosítóval, ha van. Ne találj ki
   olyat, ami nincs az emlékekben vagy a kártyákon.
   ```bash
python3 -c "import json,sys; print(json.dumps({'agent_id':'{{MAIN_AGENT_ID}}','content':sys.stdin.read()}))" <<'TXT' \
  | curl -s -X POST "http://localhost:$PORT/api/daily-log" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d @-
## HH:MM -- Napzáró (utolsó bejegyzés óta: HH:MM)
<témák szerinti összefoglaló>
TXT
   ```

4. **Ellenőrzés.** Kérd le újra a mai naplót, és nézd meg, hogy PONTOSAN egy `Napzáró`
   bejegyzés van benne. Ha kettő, jelezd a kör végén, és NE töröld magadtól.
