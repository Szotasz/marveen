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
egy bejegyzésben beírja. Csendes kör: a beállított csatornára NEM küld üzenetet.

## Eljárás

1. **Előkészítés, és kilépés, ha ma már lefutott.** Ez a kör NEM idempotens (a napló
   append-only), ezért egy kétszer kézbesített prompt két bejegyzést írna. Ha a mai naplóban
   már van `Napzáró` bejegyzés, állj meg, és ne írj semmit.
   ```bash
PORT="$(sed -n 's/^WEB_PORT=//p' {{INSTALL_DIR}}/.env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-{{WEB_PORT}}}"
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
mems, off = [], 0
while True:  # a listázás accessed_at szerint rendez, ezért a teljes halmazon szűrünk
    page = get(f'/api/memories?agent={{MAIN_AGENT_ID}}&limit=200&offset={off}')
    rows = page if isinstance(page, list) else page.get('memories', page.get('results', []))
    if not rows: break
    mems += [m for m in rows if m.get('created_at', 0) > since and m.get('agent_id') == '{{MAIN_AGENT_ID}}']
    off += len(rows)
print(f'-- uj emlekek: {len(mems)}')
for m in sorted(mems, key=lambda m: m['created_at']):
    print(f"   {hhmm(m['created_at'])} [{m.get('category')}] {m['content'][:160]!r}")
cards = [c for c in get('/api/kanban') if (c.get('updated_at') or 0) > since]
print(f'-- mozgott kartyak: {len(cards)}')
for c in sorted(cards, key=lambda c: c['updated_at']):
    print(f"   {hhmm(c['updated_at'])} {c['id'][:8]} {c.get('status')} {(c.get('title') or '')[:70]!r}")
PY
   ```
   Ha a válasz alakja más, mint amit a szkript vár (hibaüzenet, üres lista a várt adat helyett),
   azt írd le, ne nullát: a „0 új emlék” csak akkor igaz, ha a lekérdezés sikerült.

3. **Bejegyzés írása.** Ha 0 új emlék ÉS 0 mozgott kártya, akkor is írj egy egysoros bejegyzést
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
