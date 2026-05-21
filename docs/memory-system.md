# Memória-rendszer

> Az asszisztens nem felejt két üzenet között. Réteges memória, ami magától priorizál és felejt, mint az emberi emlékezet.

---

## 🎯 Mit tud / miért érdekes

A nyelvi modellek alapból "amnéziásak": minden munkamenet üres lappal indul. Marveen ezt egy **háromrétegű, öntisztító memóriával** oldja meg, ami az emberi emlékezetet utánozza:

- **hot** — ami MOST történik (aktív feladatok, függő döntések)
- **warm** — stabil tudás (preferenciák, konfiguráció, projekt-kontextus)
- **cold** — hosszútávú tanulságok, történeti döntések, archívum

A memóriák **salience decay**-en mennek át: ha egy emlék sokáig nincs használva, a fontossága csökken, és idővel hűvösebb rétegbe csúszik. Ami fontos és gyakran előkerül, az "elöl" marad. Így a rendszer magától karbantartja magát anélkül hogy tele szemetelődne.

Keresni **szemantikusan** lehet (jelentés szerint, nem csak kulcsszóra), és minden este készül egy **napi napló** — egy emberi összefoglaló arról, mi történt aznap.

**Kuriózum:** a memória fájl-alapú és helyi — nincs felhő-függőség, a tudás a gépen marad, és a munkamenet-újraindítást is túléli.

---

## 🛠 Hogyan működik

### Tárolás

- **SQLite** adatbázis (`store/`), **FTS5** full-text indexszel a gyors kereséshez.
- Minden emlék: tartalom + kategória (`hot`/`warm`/`cold`/`shared`) + kulcsszavak + időbélyegek (`created_at`, `accessed_at`) + opcionális vektor-embedding a szemantikus kereséshez.

### Réteg-logika

| Esemény | Réteg |
|---------|-------|
| Aktív feladat, függő döntés | hot |
| Feladat kész | törlés hot-ból → napi naplóba |
| Preferencia, konfiguráció | warm |
| Tanulság, hiba, döntés | cold |
| Más ügynöknek is releváns | shared |

### Salience decay

24 órás ciklusban a nem hivatkozott emlékek `accessed_at`-je öregszik; az elavult `hot` tételek (pl. >7 nap, nem hivatkozott) automatikusan `cold`-ba kerülnek (sosem törlés). A pontos duplikátumok szintén cold-ba mozognak. Ezt egy éjszakai folyamat (lásd dream-engine) végzi.

### Szemantikus keresés

Az embeddinget egy helyi modell (Ollama) készíti fire-and-forget módon. Keresésnél a lekérdezés-vektor és az emlék-vektorok hasonlósága rangsorol; FTS5 a kulcsszavas fallback. Megjelenítéskor az időbélyegek mindig helyi időzónára konvertálva.

### Napi napló

Minden este append-only összefoglaló generálódik az aznapi emlékekből — ez kerül reggel a napindítóba is.

### API

```
POST /api/memories          # új emlék (agent_id, content, category, keywords)
GET  /api/memories?q=...&category=...   # keresés
POST /api/daily-log         # napi napló bejegyzés (append-only)
```
