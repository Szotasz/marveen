---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (előző audit óta nem mozdult in_progress -> ping az assignee-nek).
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
for c in json.load(sys.stdin):
    if c.get('status')=='done' and not c.get('archived_at') and (c.get('updated_at') or 0) < cut:
        print(c['id'])
" | while read -r id; do
     curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban/$id/archive" >/dev/null
   done
   ```

3. **Beakadt task detection** (előző audit óta nem mozdult): in_progress kártyák amik `updated_at < last_audit_at`:
   ```bash
   LAST="$(python3 -c "
import json
try: print(json.load(open('{{INSTALL_DIR}}/store/kanban-audit-state.json')).get('last_audit_at') or 0)
except Exception: print(0)
")"
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,time
last=int('''$LAST''' or 0); now=int(time.time())
rows=[c for c in json.load(sys.stdin)
      if c.get('status')=='in_progress' and not c.get('archived_at') and (c.get('updated_at') or 0) < last]
rows.sort(key=lambda c: c.get('updated_at') or 0)
for c in rows:
    print(c['id'], '|', (c.get('assignee') or '-'), '|', round((now-(c.get('updated_at') or now))/3600.0,1), 'h |', c.get('title'))
"
   ```

4. **Beakadt task -> ping**: minden beakadt kártyához küldj inter-agent message-t az assignee-nek (kivéve {{MAIN_AGENT_ID}}-nek és üres assignee-nek):
   ```
   "Kanban-audit: a {card_id} ({title}) {hours_stale}h-ja in_progress mozgás nélkül (előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj komment-et hogy mit blokkol."
   ```

5. **State-fájl frissítés** (a futás VÉGÉN): `store/kanban-audit-state.json` -> `{"last_audit_at": <current Unix timestamp>}`.

6. **Delegálatlan kártyák**: in_progress/waiting/planned amiknek assignee NULL/üres -> log + Telegram csak akkor ha 3+ ilyen van.

7. **Telegram csak akkor írj ha**:
   - 3+ beakadt task van (kritikus)
   - Új blokker (waiting > 48h)
   - Egyébként csendben (heartbeat-stílus)

## Buktatók
- **NE `sqlite3` CLI-t és NE `jq`-t használj.** Egyik sincs telepítve egy átlagos Linux
  gépen (a telepítő függőségei: ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip), és a
  hívás ott `exit 127`-tel elhal -- ez a lépés némán kimarad, miközben az audit sikeresnek
  látszik. Élő gépen mérve 2026-08-04: két külön Linux telepítésen `sqlite3` és `jq`
  egyaránt hiányzott, `python3` mindkettőn ott volt. A macOS gépeken azért nem tűnt fel,
  mert ott a `sqlite3` gyárilag van.
- Az "előző audit óta nem mozdult" feltétel azt jelenti: `updated_at < last_audit_at`. NE használj abszolút 24h-os küszöböt.
- Ne archiválj done-t ha <7 nap (a felhasználó még látni akarja).
- NE pingelj saját magadat (skip ha assignee='{{MAIN_AGENT_ID}}').
- Ne re-pingelj 4 órán belül ugyanazt: a state-fájlban tárolt `last_audit_at` automatikusan kezeli ezt.
- Első futáskor (state-fájl üres) -> ne pingelj, csak inicializáld a state-et.
- A státuszváltozás (in_progress -> done) is updated_at frissítést jelent, így a következő audit nem fogja megfogni a most-még-aktív taskokat.

## Ellenőrzés
- A state-fájl frissült a futás végén.
- Inter-agent message-ek sikeresek (200 response).
