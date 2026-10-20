---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (megkezdett, azóta nem mozdult -> ping az assignee-nek).
---

# Kanban 4 órás audit

## Mikor fut
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Autonómia-szint (config-vezérelt, KÖTELEZŐ ELŐSZÖR)

Olvasd be (python3-mal, mert `jq` NINCS telepítve egy átlagos Linux gépen):
```bash
python3 -c "
import json
d=json.load(open('{{INSTALL_DIR}}/store/autonomy-config.json'))
for c in d.get('categories',[]):
    if c.get('key') in ('kanban_archive_done','kanban_stuck_nudge'):
        print(c['key'], c.get('level'))
" 2>/dev/null
```

A két kategória szintje szabályozza a 2. és 4. lépést:
- **`kanban_archive_done`** (2. lépés): level 3 → archiváld magától (alapért). level 2 → NE archiválj, Telegramon javasold ("X db 7+ napos done archiválásra vár, mehet?") és várj jóváhagyást. level 1 → csak jelezd a számot.
- **`kanban_stuck_nudge`** (4. lépés): level 3 → pingeld az assignee-t magától, és CSAK 2 eredménytelen audit-kör után eszkalálj a tulajdonoshoz ({{OWNER_NAME}}) (a komment-történetből látod hányszor pingelted). level 2 → ne pingelj magadtól, Telegramon javasold a tulajdonosnak ({{OWNER_NAME}}). level 1 → csak listázd a beakadt taskokat.

Ha a config hiányzik vagy a kulcs nincs benne → default level 3 (régi viselkedés).

## Eljárás

1. **State-fájl beolvasás**: `store/kanban-audit-state.json` tartalmazza `last_audit_at` Unix timestampet. Első futáskor null -> ne pingelj senkit, csak állítsd be a state-et.

   A tábla eléréséhez a dashboard API-t használd, NE a `sqlite3` CLI-t (lásd a Buktatókat).
   A port a `.env`-ből jön, hogy nem-alapértelmezett porton is működjön:
   ```bash
   PORT="$(sed -n 's/^WEB_PORT=//p' {{INSTALL_DIR}}/.env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-3420}"
   TOKEN="$(cat {{INSTALL_DIR}}/store/.dashboard-token)"
   ```

2. **Tisztítás**: 7+ napos done kártyák archiválása (előbb listázd, aztán archiváld egyesével):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,time
cut=int(time.time())-7*86400
d=[c for c in json.load(sys.stdin) if c.get('status')=='done' and not c.get('archived_at')]
o=[c for c in d if (c.get('updated_at') or 0) < cut]
print(f'Tisztítás: vizsgált={len(d)}, találat={len(o)}' + ('' if d else ' (nem tudott mérni)'))
for c in o: print(c['id'])
" | tail -n +2 | while read -r id; do
     curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban/$id/archive" >/dev/null
   done
   ```

3. **Beakadt task detection** (megkezdett, nem mozdult -- nem csak `in_progress`; a logika a `/api/kanban/stuck`-ban él):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban/stuck?planned_days=7&active_days=3" | python3 -c "
import json,sys,time
d=json.load(sys.stdin)
print(f\"Beakadás: vizsgált={d['examined']}, találat={len(d['stuck'])}\" + ('' if d['examined'] else ' (nem tudott mérni)'))
now=int(time.time())
for c in sorted(d['stuck'], key=lambda c: -c['last_activity']):
    print(' ', c['id'], '|', (c.get('assignee') or '-'), '|', round((now-c['last_activity'])/3600.0,1), 'h |', c['title'])
w=d['waiting']
print(f\"Várakozó: {w['examined']}, határidőn túl: {len(w['overdue'])}, határidő nélkül: {w['without_deadline']}\")
for c in w['overdue']:
    print(' ', c['id'], '|', (c.get('assignee') or '-'), '|', c['overdue_days'], 'nap késés |', c['title'])
"
   ```
   Munka-nyom csak a felelős saját, nem gépi kommentje. Tömeges vagy gépi kommentet `"automated": true`-val írj (POST `/api/kanban/<id>/comments`). A `waiting` nem tétlenség: a határidőn túliakat a tulajdonosnak jelezd, ne pingeld.

4. **Beakadt task -> ping**: minden beakadt kártyához küldj inter-agent message-t az assignee-nek (kivéve {{MAIN_AGENT_ID}}-nek és üres assignee-nek):
   ```
   "Kanban-audit: a {card_id} ({title}) {hours_stale}h-ja in_progress mozgás nélkül (előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj komment-et hogy mit blokkol."
   ```


   **FUTTATASI MEGJEGYZES az alabbi SQL-ekhez:** a `sqlite3` CLI nincs telepitve minden gepen
   (lasd Buktatok), ezert az SQL-t a python3 beepitett sqlite3-moduljaval futtasd:
   ```bash
   python3 -c "import sqlite3
for r in sqlite3.connect('{{INSTALL_DIR}}/store/claudeclaw.db').execute('''<IDE AZ SQL>'''):
    print(*r, sep=' | ')"
   ```
   Az alabbi blokkok az SQL-t dokumentaljak; a `sqlite3 db "..."` alak a peldakban a LOGIKAT
   mutatja, a futtatas a fenti python3-wrapperrel megy.

4b. **WAITING-KOR ELLENORZES** (2026-07-27-tol, a teljes szoveg a referenciafajlban): `~/.claude/scheduled-tasks/kanban-audit/references/kanban-audit-step4b-waiting.md`.
   **KOTELEZO beolvasni a 4. lepes vegrehajtasakor** -- az SQL-ek es a dontesi szabalyok (ATLEPO/UJ BELEPO) ott vannak, nem hagyhatok ki.

4c. **KIKULDES-DETEKTOR A FRISS KARTYAKRA (2026-08-24-tol, AUDITKIKULD823 -- ez eddig HIANYZOTT,
   es egy ugyfel-bejelentes 4,5 orat ult miatta).** A fenti harom halo (done-archivalas, beakadt
   `in_progress`, 30+ napos `waiting`) EGYIKE SEM fogja meg azt a kartyat, ami MA keletkezett,
   `planned`-en all, MEGNEVEZETT flotta-gazdaja van, es SOSEM lett kikuldve neki. A kivalto eset:
   a 01ABD89F connectors-bejelentes 15:12-kor keletkezett `planned/samu`-n, 19:4x-ig nulla uzenet
   ment rola, es a GAZDA kerdezett ra Telegramon, nem mi vettuk eszre.
   ```bash
   LAST="$(python3 -c "
import json
try: print(json.load(open('{{INSTALL_DIR}}/store/kanban-audit-state.json')).get('last_audit_at') or 0)
except Exception: print(0)
")"
   ```
   ```sql
   -- futtatas a python3-sqlite wrapperrel; a $LAST erteket helyettesitsd be
     SELECT k.id, k.status, k.assignee, datetime(k.created_at,'unixepoch','localtime'), substr(k.title,1,60)
       FROM kanban_cards k
      WHERE k.archived_at IS NULL
        AND k.status IN ('planned','waiting')
        AND k.created_at >= $LAST
        AND lower(k.assignee) IN (<a telepites sub-agent nevei kisbetuvel, az agents/ konyvtar szerint>)  -- ALLOWLIST, NEM "NOT IN"
        AND NOT EXISTS (SELECT 1 FROM agent_messages m
                         WHERE m.from_agent <> 'heartbeat'
                           AND (m.content LIKE '%'||k.id||'%'
                                OR (k.id GLOB 'PR[0-9]*' AND m.content LIKE '%#'||substr(k.id,3)||'%'))
                           AND m.created_at >= k.created_at)
      ORDER BY k.created_at
   ```

   **A `NOT IN` SZURO NEM ELEG, ALLOWLIST KELL -- ES EZT A SAJAT SZOVEGEM MAR KIMONDTA, A LEKERDEZES MEGSEM
   KOVETTE (2026-08-26 08:00, merve).** A lenti bekezdes 2026-08-10 ota irja, hogy KULSO szerzonel a nulla
   inter-agent uzenet a VART allapot (nekik PR-komment vagy email megy). A lekerdezesben viszont
   `NOT IN ('', '<fo-agens>', '<tulajdonos>')` alaku kizaro lista allt, vagyis minden kulso nev ATCSUSZOTT rajta. A 08:00-s teljes-halmazos
   futas OT `waiting` tetelt jelentett kikuldetlennek, es MIND AZ OT kulso emberhez tartozott
   (zollak, stivi1g-gif, tekt, szuszupaks, zsuzsa). Nulla valodi lelet, ot sor zaj -- pont az a fajta,
   ami mellett a valodi lelet elveszne.
   Jelentsd: vizsgált=N,találat=K,0→nemmért.
   **A TAGABB TANULSAG: egy leirt szabaly, ami mellett a LEKERDEZES a regi marad, annyit er, mint a le nem
   irt szabaly.** A szoveget es a kodot EGYSZERRE kell javitani, kulonben a skill sajat maganak mond ellent.
   Talalat eseten a kartya NEM keszult el magatol: kuldd ki a gazdajanak, es a kartyara menjen
   komment, hogy a kikuldes az auditbol pótolva lett.
   **A NULLA TALALAT ONMAGABAN NEM BIZONYITEK -- FUTTASS POZITIV KONTROLLT (2026-08-23 20:2x, merve).**
   A friss ablak tipikusan ures, es az ures halmaz ugyanugy nez ki, mint egy sosem-tuzelo lekerdezes.
   Ezert a detektort a TELJES nyitott halmazon is futtasd le egyszer (a `created_at >= $LAST` sort
   elhagyva): ha ott sem talal semmit, a MUSZER a hibas, nem a vilag. A fenti lekerdezes 2026-08-24
   05:5x-kor lefuttatva: friss ablak 0 talalat, teljes halmaz `planned` 77 + `waiting` 9 -- tehat a
   detektor tuzel, es a friss nulla VALODI nulla.
   **DE A KARTYA-ID-RE ILLESZTES MINDEN PR-KARTYARA HAMIS POZITIVOT AD (2026-08-24 16:0x, merve).**
   A lekerdezes a kartya ID-jet keresi az uzenetekben (`content LIKE '%'||k.id||'%'`), a PR-kartyak
   ID-je viszont `PR1059` alaku -- mi viszont a PR-t a beszelgetesben SOHA nem igy hivjuk, hanem
   `#1059`-kent. Emiatt a mai kor a `PR1058`-at es a `PR1059`-et kikuldetlennek jelentette, holott
   mindkettorol irtam az assignee-nek ugyanabban az oraban. A hamis pozitiv itt dragabb a szokasosnal:
   ELREJTI A VALODI LELETET -- aznap egy 30 napos, tenylegesen kikuldetlen kartyat (`9D766E19`) --,
   mert a lista tele lesz zajjal, es a zajos listat az ember atfutja.
   **JAVITAS: PR-kartyanal a `#<szam>` alakot IS fogadd el.**
   ```sql
   AND NOT EXISTS (SELECT 1 FROM agent_messages m
                    WHERE m.from_agent <> 'heartbeat'
                      AND (m.content LIKE '%'||k.id||'%'
                           OR (k.id GLOB 'PR[0-9]*' AND m.content LIKE '%#'||substr(k.id,3)||'%'))
                      AND m.created_at >= k.created_at)
   ```
   A `substr(k.id,3)` a `PR` prefixet vagja le. A `GLOB` feltetel nelkul egy nem-PR kartya ID-jenek
   toredeke is veletlenul illeszkedne.

   **DE A SAJAT HEARTBEAT-DIGESTEM IS "EMLITI" A KARTYA-ID-T -- ES EZ HAMIS POZITIV (2026-08-25, merve).**
   Az orankenti digest felsorolja a kartya-azonositokat (az `urgent` lista ES a 8 legfrissebb `waiting`),
   tehat minden ilyen kartyara talal a `content LIKE '%<ID>%'`, es a detektor kikuldesnek olvassa.
   A MERT ESET: az INSTPWURES825 (urgent, holnapi hataridovel) harom oraig allt kikuldetlenul, es a
   uzenet-nyoma NEM nulla volt, hanem NEGY -- mind a negy a sajat digestem, ami visszaolvasta nekem a
   kartya ID-jet. A nyom tehat letezett, csak nem a gazdahoz vezetett.
   **JAVITAS, egy sor:** `AND m.from_agent <> 'heartbeat'` a NOT EXISTS belsejebe. Ez NEM mond ellent a
   lenti "barmilyen uzenet" szabalynak: a digest nem egy ember vagy agens emlitese, hanem egy automatikus
   visszaolvasas NEKEM.
   **A HATOKORE SZUK, ES EZT IS MERD, NE FELTETELEZD:** a 2026-08-25 20:00-s korben a ket valtozat
   (heartbeat-tel es nelkule) AZONOS eredmenyt adott, mert az akkori talalat `planned` volt, a digest
   pedig csak az `urgent` es a legfrissebb `waiting` kartyakat sorolja. Vagyis a vaksag CELZOTT: pont
   a legfontosabb kartyakra all fenn.

   **KET TOVABBI RES UGYANEBBEN A DETEKTORBAN (2026-08-25, ugyanaz a kor):**
   1. **A STATUSZ-VALTAS KIEJTI AZ ABLAKBOL.** A lekerdezes `status IN ('planned','waiting')`. Ha egy
      kikuldetlen kartyat barki `in_progress`-re allit, a detektor TOBBE nem keresi -- pont az a kartya
      esik ki, amirol a tabla azt allitja, hogy valaki EPP dolgozik rajta. Ha a kikuldes-nyom hianyzik,
      az `in_progress` allitas maga a gyanus.
   2. **A FRISS ABLAK EGYSZERI ESELYT AD.** A `created_at >= $LAST` szuro a backlog-zaj miatt indokolt
      (a regi `planned` halmazon a nulla uzenet a VART allapot), de ha egy kartya EGY kort atcsuszik,
      soha tobbe nem kerul a lathatoba. **Kell melle egy ritkabb, TELJES halmazos futas** (napi egyszer,
      pl. a 08:00-s korben), es annak a kimenete NE a puszta szam legyen: 2026-08-25-en a teljes halmaz
      76 `planned` + 5 `waiting` kikuldetlent adott, es ebbol a 76 nagy resze legitim backlog. A lelet a
      MEGNEVEZETT GAZDAS, FRISS kartya, nem a darabszam.

   **A FELTETEL SZANDEKOSAN BARMILYEN uzenetet elfogad, ami a kartya ID-jet emliti, nem csak a
   marveen -> gazda iranyt.** Ha a gazda MAGA hozta szoba (sajat kartyazas, visszajelzes), akkor tud
   rola, es a kikuldes celja teljesult. Ne "javitsd" ki kimeno-only szuresre: azzal a sajat maga
   altal felvett kartya minden korben hamis riasztast adna.
   **DE A 117-ET NE JELENTSD LELETKENT: SZETBONTVA MAST MOND (ugyanaz a meres).** `planned` 110/244,
   `waiting` 7/98. A regi `planned` halmaz BACKLOG -- ott a nulla uzenet a VART allapot, nem mulasztas.
   Ezert szur a lekerdezes a friss ablakra: a lelet az UJ kartya megnevezett gazdaval, nem a backlog.


5. **State-fájl frissítés** (a futás VÉGÉN): `store/kanban-audit-state.json` -> `{"last_audit_at": <current Unix timestamp>}`.

6. **Delegálatlan kártyák**: minden nem archivált, NEM `done` kártya (kizárással szűrj, ne a státuszok felsorolásával), aminek assignee NULL/üres -> log + Telegram csak akkor ha 3+ ilyen van.
   Jelentsd: vizsgált=N,találat=K,0→nemmért.

6a. **Detektorral nem fedett státuszú kártyák** (KANBANSTATUSZVAK916, KÖTELEZŐ minden körben): a többi
   detektor a `planned`, `in_progress`, `waiting`, `done` négyesre szűr, a tábla viszont ennél többet enged
   (a `kanban_cards` séma CHECK-je szerint a `testing` is érvényes). Az ilyen kártya SEMELYIK detektorban
   nem jelenik meg (mért eset 2026-09-16: `17d07456`, `testing`, 2026-09-05 óta), az audit számára nem létezik.
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,time
COVERED={'planned','in_progress','waiting','done'}
for c in json.load(sys.stdin):
    if c.get('archived_at') or c.get('status') in COVERED: continue
    age=(time.time()-(c.get('updated_at') or 0))/86400
    print(c['id'][:8],'|',c.get('status'),'|',round(age,1),'napja nem mozdult |',(c.get('title') or '')[:50])
"
   ```
   **Ha van találat:** a kör jelentésébe ID-vel, státusszal és korral kerüljön bele, és Telegramon is
   menjen ki (7. pont), mert ezekre a kártyákra a stuck- és a
   delegálatlan-mérés nem érvényes. **Ha 0:** a jelentésben is 0-ként szerepeljen, ne maradjon ki,
   különben nem látszik, hogy a lépés lefutott. A `COVERED` halmazt csak akkor bővítsd, ha
   az új státuszt egy detektor ténylegesen méri, különben a bővítés újra elrejti a kártyát.
   Jelentsd: vizsgált=N,találat=K,0→nemmért.

6b. **ELŐRE-DATÁLT CÍM-BÉLYEG detektor** (2026-08-25-én vezetve be, mert a hiba negyedszer fordult elő):
   a kártyacímbe írt óra BECSÜLT lehet, és hosszú munkamenetben MONOTON NÖVEKVŐ eltérést halmoz
   (mért eset: 17 kártya, +16 perctől +189 percig). A `updated_at` hiteles, a címbe másolt idő nem --
   ez denormalizálás, és a másolat el tud csúszni.
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,datetime,re
# FONTOS: a mintának a 'HH:1x' alakra IS illeszkednie kell, különben néma nulla
pat=re.compile(r'(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d)[\dxX]')
for c in json.load(sys.stdin):
    if c.get('archived_at') or not c.get('updated_at'): continue
    real=datetime.datetime.fromtimestamp(c['updated_at']); m=pat.search(c.get('title') or '')
    if not m or m.group(1)!=real.strftime('%Y-%m-%d'): continue
    d=(real.replace(hour=int(m.group(2)),minute=int(m.group(3))*10,second=0)-real).total_seconds()/60
    if d>10: print(c['id'],'| cim allit',m.group(0)[-5:],'| valodi',real.strftime('%H:%M'),'| +%d perc'%d)
"
   ```
   **Ha van találat:** javítsd a CÍMET a valódi `updated_at`-re (az `updated_at`-ot NE mozgasd, ez
   bélyeg-javítás, nem állapot-változás), és a kör jelentésébe írd bele a darabszámot. A kommenteket
   NE írd át -- a történet maradjon olvasható, a cím viszont állapot, amiből a heartbeat dolgozik.
   **Kontroll, hogy a nulla ne legyen vak:** ha 0 a találat, futtasd le egy ismert pozitívra is
   (bármely kártya címébe ideiglenesen írt jövőbeli idő), különben a minta-hiba nullának látszik.


7. **Telegram csak akkor írj ha**:
   - 3+ beakadt task van (kritikus)
   - Új blokker (waiting > 48h)
   - Detektorral nem fedett státuszú kártya (6a): ugyanarról a kártyáról naponta legfeljebb egyszer, a többi körben csak a jelentésben
   - **TULAJDONOSRA VÁRÓ KEMÉNY BLOKKOLÓ, státusztól és kortól függetlenül.**
     A fenti két küszöb szűk, mert mindkettő ÁLLAPOTOT vagy KORT néz, a
     blokkoló viszont lehet friss és lehet `planned` is. 2026-08-11: egy
     kártya arról, hogy elfogyott egy szolgáltató előrefizetett kerete és
     minden hívás 429-cel tér vissza, `planned` státuszban, 100 perce
     létezett, tehát SEM a "3+ beakadt", SEM a "waiting > 48h" nem fogta meg.
     Közben négy szálat állított meg, és csak a tulajdonos tudta feloldani,
     mert számlázás.
     A szabály: ha egy kártya (a) kemény megállást ír le, (b) az assignee-je a
     tulajdonos, vagy a leírása szerint csak ő tudja elvégezni, és (c) nem
     látszik, hogy szólt volna neki bárki, akkor kimegy Telegramon.
     A (c) ellenőrzése: nézd meg, kérte-e valaki inter-agent üzenetben a
     továbbítást, és fusd át a saját kimenő üzeneteidet. Ha kétséges, inkább
     szólj: a kétszer elmondott blokkoló olcsóbb, mint a négy órát álló flotta.
   - Egyébként csendben (heartbeat-stílus)

## Buktatók

A buktatók részletes listája: `~/.claude/scheduled-tasks/kanban-audit/references/kanban-audit-buktatok.md`.

## Ellenőrzés
- A state-fájl frissült a futás végén.
- Inter-agent message-ek sikeresek (200 response).
