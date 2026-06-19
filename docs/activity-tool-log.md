# Tevékenységnapló és Tool Log

> Valós idejű eszközhívás-napló, munkamenet-statisztikák és automatikus workflow-kandidáns detektor.

---

## 🎯 Mit tud / miért érdekes

Minden ügynök-munkamenet során a Claude Code eszközei (Bash, Read, Write, WebFetch stb.) hívásai **naplózódnak** egy közös SQLite táblába. Ez lehetővé teszi:

- **Átláthatóság**: mi fut éppen, milyen eszközöket hív egy ügynök
- **Diagnosztika**: lassú vagy hibás munkamenetek utólagos elemzése
- **Workflow-detektor**: hosszú, ismétlődő munkamenet-minták automatikus felismerése -- skill-generálás javaslathoz

A Dashboard **Activity** oldala ezeket az adatokat valós időben mutatja.

---

## 🛠 API

### Tool call naplózása (hook-ból)

A PostToolUse hook automatikusan meghívja:

```
POST /api/tool-log
Content-Type: application/json

{
  "session_id": "abc-123",
  "tool_name": "Bash",
  "input_summary": "git push origin feat/...",
  "success": true
}
```

| Mező | Kötelező | Leírás |
|------|----------|--------|
| `session_id` | igen | Claude Code session azonosító |
| `tool_name` | igen | Eszköz neve (Bash, Read, Write, WebFetch, ...) |
| `input_summary` | nem | Rövid összefoglaló a hívás tartalmáról |
| `success` | nem | `true` ha sikerült (alapértelmezett: `true`) |

### Legutóbbi tool call-ok lekérése

```
GET /api/tool-log?since=<másodperc>
```

| Paraméter | Leírás | Alapértelmezett |
|-----------|--------|-----------------|
| `since` | Mennyi másodpercre visszamenőleg | 3600 (1 óra) |

Válasz: eszközhívások listája időrendben (legújabb elöl).

```json
[
  {
    "id": 1042,
    "session_id": "abc-123",
    "tool_name": "Bash",
    "input_summary": "git push origin feat/...",
    "success": true,
    "ts": 1748956800
  }
]
```

### Régi bejegyzések törlése

```
POST /api/tool-log/prune
Content-Type: application/json

{ "older_than_secs": 86400 }
```

Alapértelmezett: 86400 másodperc (1 nap) réginél idősebb bejegyzések törlése.

---

## 🔍 Workflow-kandidáns detektor

Az elemző endpoint azonosítja azokat a **munkameneteket, amelyek érdemesek lehetnek skill-be mentésre**: legalább N eszközhívást tartalmaznak, egy időablakon belül zajlottak, és ismétlődő mintát mutatnak.

```
GET /api/tool-log/analyze?since=<mp>&min_calls=<n>&gap=<mp>
```

| Paraméter | Leírás | Alapértelmezett |
|-----------|--------|-----------------|
| `since` | Vizsgált időablak visszamenőleg | 3600 mp |
| `min_calls` | Minimum tool-hívásszám a jelöléshez | 5 |
| `gap` | Munkamenet-határ: ennyi másodperc szünet után új session | 300 mp |

Válasz: munkamenet-összefoglalók listája.

```json
[
  {
    "session_id": "abc-123",
    "tool_count": 14,
    "duration_minutes": 8.2,
    "start_ts": 1748956800,
    "end_ts": 1748957292,
    "tools": ["Bash", "Read", "Edit", "Write"],
    "steps_preview": [
      { "tool": "Bash", "description": "git worktree add ..." },
      { "tool": "Read", "description": "src/web/routes/agents.ts" }
    ]
  }
]
```

A `steps_preview` az első 10 hívást tartalmazza -- elegendő annak megítéléséhez, hogy érdemes-e skill-t létrehozni.

---

## 🖥 Dashboard -- Activity oldal

A Dashboard **Activity** oldala a következőket mutatja:

| Szekció | Tartalom |
|---------|----------|
| Valós idejű hívások | Legutóbbi N eszközhívás, munkamenetenként csoportosítva |
| Munkamenet-statisztikák | Ügynökönként: hívásszám, sikerráta, leggyakrabban használt eszközök |
| Workflow-kandidánsok | Automatikusan jelölt munkamenetek, "Skill létrehozása" gombbal |

---

## 💡 Példák

```bash
TOKEN=$(cat store/.dashboard-token)

# Utolsó 30 perc tool-hívásai
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/tool-log?since=1800"

# Workflow-kandidánsok az elmúlt 2 órából (min. 8 hívás)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/tool-log/analyze?since=7200&min_calls=8"

# Napnál idősebb bejegyzések törlése
curl -s -X POST http://localhost:3420/api/tool-log/prune \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"older_than_secs": 86400}'
```

---

## Kapcsolódó dokumentumok

- [Skill-factory](skill-factory.md) -- skill generálás munkamenet-minták alapján
- [Ügynök-flotta](agent-fleet.md) -- ügynök életciklus és hook-ok
- [Token Usage](token-usage.md) -- token-fogyasztás nyomon követése
