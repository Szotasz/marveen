# Visszakeresés (Recall)

> A napi napló és az emlékek **dátum-alapú visszakeresése** -- természetes nyelvű dátumkifejezésekkel, szűréssel, kombinált kereséssel.

---

## 🎯 Mit tud / miért érdekes

Az ügynökök minden fontos eseményt beírnak a napi naplóba, és az emlékrendszerbe is mentenek kontextust. A Recall modul lehetővé teszi, hogy ezeket **dátum szerint visszakeressd** -- akár egy konkrét napra, akár egy időszakra, akár kulcsszóval kombinálva.

Különlegesség: **teljesen magyar nyelvű dátumkifejezéseket** ért: `"tegnap"`, `"múlt héten"`, `"március 3"`, `"elmúlt 7 nap"`, `"2026-05-01 - 2026-05-15"`.

---

## 🛠 API

### Visszakeresés dátum szerint

```
GET /api/recall?date=<kifejezés>[&agent=<agent_id>][&q=<kulcsszó>][&limit=50]
```

| Paraméter | Leírás | Alapértelmezett |
|-----------|--------|-----------------|
| `date` | Dátumkifejezés (ld. lentebb) | mai nap |
| `agent` | Szűrés ügynökre | összes |
| `q` | Kulcsszó-szűrő (naplón + emlékeken is) | nincs |
| `limit` | Max. visszaadott elem | 50 (max. 200) |

Ha csak `q` van `date` nélkül: **teljes szöveges keresés** az összes naplóbejegyzésben és emlékben, dátumtól függetlenül.

### Elérhető dátumlista

```
GET /api/recall/dates?agent=<agent_id>[&limit=90]
```

Visszaadja azokat a napokat (ISO dátum lista), amelyekhez van naplóbejegyzés -- hasznos kalender-nézethez.

---

## 📅 Dátumkifejezések

### Relatív napok

| Kifejezés | Jelentés |
|-----------|----------|
| `ma` | mai nap |
| `tegnap` | tegnap |
| `tegnapelőtt` | 2 napja |
| `3 napja` | 3 nap |
| `5 nappal ezelőtt` | 5 nap |

### Hetek

| Kifejezés | Jelentés |
|-----------|----------|
| `ezen a héten` / `ez a hét` | hétfőtől máig |
| `múlt héten` / `előző hét` | előző hétfőtől vasárnapig |
| `2 hete` | 2 héttel ezelőtt (teljes hét) |
| `múlt hétfő` | legutóbbi hétfő |
| `előző szerda` | legutóbbi szerda |

### Hónapok

| Kifejezés | Jelentés |
|-----------|----------|
| `ebben a hónapban` | első-tól máig |
| `múlt hónapban` | előző hónap teljes |
| `március` / `márc` | idén március teljes hónap |
| `március 3` | március 3. |
| `március második hét` | március 2. hete |
| `március utolsó hét` | március utolsó hete |
| `elmúlt 30 nap` | utolsó 30 nap |

### Pontosan megadott dátumok

```
2026-05-03
2026-05-01 - 2026-05-15
```

---

## 📦 Válasz formátum

```json
{
  "dateRange": { "from": "2026-05-01", "to": "2026-05-31" },
  "logs": [
    {
      "id": 42,
      "agent_id": "jarvis",
      "content": "## 09:30 -- Reggeli napindító\n...",
      "created_at": 1746091800,
      "created_label": "2026. május 1., 9:30:00"
    }
  ],
  "memories": [
    {
      "id": 17,
      "agent_id": "jarvis",
      "category": "warm",
      "content": "Jonas preferálja a rövid válaszokat...",
      "keywords": "preferencia, stílus",
      "created_label": "2026. május 1., 10:15:00"
    }
  ],
  "summary": {
    "logCount": 5,
    "memoryCount": 2,
    "agents": ["jarvis", "zack"]
  }
}
```

---

## 🖥 Dashboard

A **Dashboard > Visszakeresés** oldalon a dátumkifejezés szabadszövegesen beírható, és a találatok idővonal-szerűen jelennek meg -- naplóbejegyzések és emlékek egymás mellett, ügynök szerint színkódolva.

---

## 💡 Példák

```bash
TOKEN=$(cat store/.dashboard-token)

# Tegnap összes esemény (Jarvis)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?date=tegnap&agent=jarvis"

# Múlt hét, kulcsszóval szűrve
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?date=mult+heten&q=kanban"

# Március 5.
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?date=marc+5"

# Teljes szöveges keresés dátum nélkül
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall?q=PR+review"

# Napok listája, ahol van bejegyzés (max. 90 nap visszamenőleg)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/recall/dates?agent=jarvis"
```

---

## Kapcsolódó dokumentumok

- [Memória-rendszer](memory-system.md) -- emlékek írása és olvasása
- [Napi napló](memory-system.md#napi-napló) -- mibe kerülnek a naplóbejegyzések
- [Ügynök-flotta](agent-fleet.md) -- agent_id-k listája
