# Ötletbox (Ideas)

> Gyors ötletrögzítés, AI-alapú kanban-bontás, jóváhagyott alfeladatok közvetlen felrakása a táblára.

---

## 🎯 Mit tud / miért érdekes

Az Ötletbox egy **könnyűsúlyú ötletkártya-rendszer**, amely az impulzusoktól a végrehajtható feladatokig vezeti az ötleteket -- anélkül, hogy azonnal el kellene dönteni, hogyan bontjuk le.

Folyamat:

1. Gyors rögzítés (cím, leírás, kategória)
2. Opcionális AI-bontás: az LLM 3-5 alfeladatot javasol assignee-vel és prioritással
3. Jóváhagyott alfeladatok **egyetlen kattintással** kerülnek fel a kanban-táblára, szülőkártyával együtt
4. Promóció után az ötlet státusza `kanban`-ra vált, hivatkozva a létrehozott kártyára

---

## 🛠 API

### Ötletek listázása

```
GET /api/ideas[?status=<státusz>][&category=<kategória>]
```

Státuszok: `new` | `kanban` (promótálva) | `archived`

### Kategóriák listája

```
GET /api/ideas/categories
```

Visszaadja a meglévő kategóriák halmazát (dinamikus, az adatbázisból).

### Ötlet létrehozása

```
POST /api/ideas
Content-Type: application/json

{
  "title": "Ötlet rövid neve",
  "description": "Részletes leírás (opcionális)",
  "category": "Fejlesztés",
  "source": "manual"
}
```

| Mező | Kötelező | Leírás |
|------|----------|--------|
| `title` | igen | Az ötlet rövid neve |
| `description` | nem | Részletes szöveg |
| `category` | nem | Alapértelmezett: `Egyéb` |
| `source` | nem | `manual` / `agent` / bármilyen string |

Válasz: `{ "ok": true, "id": "<8 karakteres id>" }`

### Ötlet módosítása

```
PUT /api/ideas/<id>
Content-Type: application/json

{ "title": "...", "description": "...", "category": "..." }
```

### Ötlet törlése

```
DELETE /api/ideas/<id>
```

---

## 🤖 AI-bontás (Breakdown)

### Bontás kérése

```
POST /api/ideas/<id>/breakdown
```

Az LLM elemzi az ötlet címét és leírását, majd **3-5 alfeladatot** javasol:

```json
{
  "subtasks": [
    {
      "title": "API végpont tervezése",
      "description": "REST endpoint megtervezése...",
      "assignee": "zack",
      "priority": "high"
    },
    {
      "title": "Frontend integráció",
      "assignee": "marveen",
      "priority": "normal"
    }
  ]
}
```

A bontás **nem ír adatbázist** -- a felhasználó jóváhagyja, esetleg szerkeszti a javasolt alfeladatokat, majd a promote-breakdown hívással rögzíti.

### Bontás mentése és promóció

```
POST /api/ideas/<id>/promote-breakdown
Content-Type: application/json

{
  "subtasks": [
    { "title": "...", "description": "...", "assignee": "zack", "priority": "high" }
  ]
}
```

- Létrehoz egy szülő kanban-kártyát (`status: planned`) az ötlet nevével
- Minden alfeladathoz létrehoz egy gyermek kártyát (`parent_id` hivatkozással)
- Frissíti az ötlet státuszát `kanban`-ra, beírja a `kanban_id`-t
- Legalább 1 alfeladat kötelező

Válasz:
```json
{ "ok": true, "parent_id": "<szülőkártya id>", "child_count": 3 }
```

---

## ⚡ Gyors promóció (bontás nélkül)

Ha az ötlet elég egyértelmű és nem kell LLM-bontás:

```
POST /api/ideas/<id>/promote
Content-Type: application/json

{ "phase": "detail" }
```

| `phase` értéke | Létrehozott kártya státusza | Cím prefix |
|---------------|---------------------------|------------|
| `detail` | `waiting` | `[Részlet kidolgozás] <ötlet neve>` |
| `plan` | `planned` | `<ötlet neve>` (prefix nélkül) |

---

## 🖥 Dashboard

Az **Ötletbox** oldal a dashboardon kanban-szerű nézetben mutatja az ötleteket. Elérhető gombok:

- **AI bontás** -- breakdown generálás, subtask-szerkesztő panel
- **Promótálás** -- közvetlen kanban-kártyává alakítás
- **Törlés** -- ötlet archiválása/törlése

---

## 💡 Példák

```bash
TOKEN=$(cat store/.dashboard-token)

# Új ötlet rögzítése
curl -s -X POST http://localhost:3420/api/ideas \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Automatikus PR-összefoglaló generálás",
    "description": "Minden merged PR után rövid összefoglaló Telegramon.",
    "category": "Automatizálás"
  }'

# AI bontás kérése
curl -s -X POST http://localhost:3420/api/ideas/<id>/breakdown \
  -H "Authorization: Bearer $TOKEN"

# Jóváhagyott subtaskokkal promóció
curl -s -X POST http://localhost:3420/api/ideas/<id>/promote-breakdown \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "subtasks": [
      { "title": "GitHub webhook figyelő", "assignee": "zack", "priority": "high" },
      { "title": "Telegram üzenet sablon", "assignee": "marveen", "priority": "normal" }
    ]
  }'

# Összes ötlet listázása
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/ideas?status=new"
```

---

## Kapcsolódó dokumentumok

- [Kanban](kanban.md) -- hova kerülnek a promótált ötletek
- [Ügynök-flotta](agent-fleet.md) -- assignee ügynökök listája
