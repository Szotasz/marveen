# Archivált kártyák

> A kanban tábláról eltüntetett, befejezett vagy félretett kártyák dedikált áttekintő nézete, visszaállítással.

---

## Mit tud / miért érdekes

A kanban tábla automatikusan archiválja a `done` állapotú kártyákat, ha azok `KANBAN_ARCHIVE_DONE_DAYS` napnál régebbiek (alapértelmezés: 30 nap). Ezek az "Archivált" nézetben megmaradnak és kereshetők, de nem zsúfolják a táblát.

Az archivált nézet:
- Teljes szöveges keresés (cím, projekt, felelős).
- Szűrés projekt, dátumtartomány szerint.
- Visszaállítás gombbal kártyanként (a kártya visszakerül a táblára).

---

## Konfiguráció

| Kulcs | Leírás | Alapértelmezés |
|-------|--------|----------------|
| `KANBAN_ARCHIVE_DONE_DAYS` | Ennyi napnál régebbi "done" kártyák archiválódnak. | 30 |
| `KANBAN_ARCHIVED_MAX_ROWS` | Az archivált nézetben egyszerre megjelenített kártyák maximuma. | 500 |

Mindkét érték a Beállítások oldalon változtatható, újraindítás nélkül érvényes.

---

## API

### GET /api/kanban/archived

Lekéri az archivált kártyákat. Az eredmény tartalmazza a kártyánkénti cimkéket is.

Query paraméterek (mind opcionális):

| Paraméter | Típus | Leírás |
|-----------|-------|--------|
| `q` | string | Szabad szöveges keresés (cím, projekt, felelős). |
| `project` | string | Projektre szűrés (pontos egyezés). |
| `label` | string | Cimke nevére szűrés. |
| `from` | unix timestamp | Archiválás időpontja ettől. |
| `to` | unix timestamp | Archiválás időpontja eddig. |
| `limit` | int | Max visszaadott elemszám (legfeljebb 5000; alapértelmezés: `KANBAN_ARCHIVED_MAX_ROWS`). |

Válasz:

```json
{
  "cards": [
    {
      "id": "AB12CD34",
      "title": "Kártya neve",
      "status": "done",
      "project": "Projekt neve",
      "priority": "normal",
      "assignee": "jarvis",
      "archived_at": 1718000000,
      "updated_at": 1718000000,
      "labels": [{ "id": "x1", "name": "AI", "color": "#3b82f6" }]
    }
  ],
  "total": 1,
  "limit": 500
}
```

### POST /api/kanban/:id/unarchive

Visszaállít egy archivált kártyát (`archived_at = NULL`). Csak archivált kártyán működik; aktív kártyán 404-et ad vissza.

```bash
curl -s -X POST http://localhost:3420/api/kanban/AB12CD34/unarchive \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"
```

Válasz: `{ "ok": true }`

---

## Megjegyzések

- Az archivált nézet csak-olvasható -- szerkesztés vagy státuszváltás a visszaállítás után a rendes kanban táblán lehetséges.
- A `listKanbanCards()` és a heartbeat-szűrők (`archived_at IS NULL`) változatlanok maradnak; az archivált kártyák nem jelennek meg a táblán és nem kerülnek be a heartbeat-összefoglalóba.
