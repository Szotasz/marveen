# Memória-rendszer

> Az asszisztens nem felejt két üzenet között. Réteges memória hibrid kereséssel, ami magától priorizál és felejt, mint az emberi emlékezet.

---

## 🎯 Mit tud / miért érdekes

A nyelvi modellek alapból "amnéziásak": minden munkamenet üres lappal indul. Marveen ezt egy **réteges, öntisztító memóriával** oldja meg, ami az emberi emlékezetet utánozza:

- **hot** — ami MOST történik (aktív feladatok, függő döntések)
- **warm** — stabil tudás (preferenciák, konfiguráció, projekt-kontextus)
- **cold** — hosszútávú tanulságok, történeti döntések, archívum
- **shared** — más ügynököknek is releváns infó

A memóriák **salience decay**-en mennek át: ami sokáig nincs használva, halványul; ami gyakran előkerül, az "elöl" marad. A keresés **hibrid** (kulcsszó + jelentés szerint egyszerre), és minden este készül egy **napi napló** — emberi összefoglaló arról, mi történt aznap.

**Kuriózum:** az ügynök nem "adatbázist kérdez le" — ugyanúgy olvassa a memória-bejegyzéseket, mint bármi mást a kontextusában. Ettől az élmény természetes: valódi emlékezés, nem keresés. Minden adat helyi (SQLite + helyi embedding), nincs felhő-függőség, és munkamenet-újraindítást is túléli — amit az ügynök megtanult, megmarad. A dashboardon Obsidian-stílusú kapcsolati gráfban is böngészhető.

---

## 🛠 Hogyan működik

### Tárolás és tier-ek

SQLite (`store/`), FTS5 indexszel. Minden emlék: tartalom + tier + kulcsszavak + időbélyegek + opcionális 768-dimenziós embedding.

| Tier | Mikor | Példa |
|------|-------|-------|
| **hot** | aktív feladat, függő döntés | "folyamatban lévő kutatás" |
| **warm** | stabil konfig, preferencia | "tömör válaszokat kér" |
| **cold** | tanulság, történeti döntés | "a cache TTL 5 perc volt optimális" |
| **shared** | más ügynöknek is kell | "az X API kulcs a vaultban van" |

Réteg-választás automatikus: feladat kész → hot-ból törlés + napi naplóba; preferencia → warm; tanulság → cold; több ügynöknek → shared.

### Hibrid keresés (FTS5 + Vektor + RRF)

A keresés két párhuzamos csatornán fut, majd fúzionál:

- **FTS5** — SQLite natív full-text, pontos szóegyezés, gyors.
- **Vektor** — minden emlék mentéskor kap egy 768-dim embedding-et (Ollama `nomic-embed-text`); cosine similarity rangsorol, a jelentést érti, nem csak a szavakat.
- **RRF (Reciprocal Rank Fusion, k=60)** — a két lista összefésülése: `score(d) = Σ 1/(k + rank)`. Előnye: nem kell a pontszámokat normalizálni, csak a rangsor számít.

Az Ollama opcionális — nélküle is megy, csak FTS5-tel.

### Salience decay

- Első **7 nap**: nincs decay.
- 7 nap után: **0,5%/nap** csökkenés (`salience * 0.995`).
- Minimum **0,01** — sosem törlődik, csak háttérbe kerül.
- Hozzáféréskor **+0,1 boost** (max 5,0) — amit gyakran keresnek, releváns marad.

A "gentle decay": a régi emlékek nem zavarják a keresést, de mindig visszakereshetők. Az éjszakai [dream-engine](dream-engine.md) mozgatja az elavult hot tételeket cold-ba (sosem törlés).

### Napi napló

Append-only, ágensenként: automatikus bejegyzések napközben + 23:00-kor napi összefoglaló. Nem módosul — kronológiai archívum, ez kerül reggel a napindítóba.

### PreCompact hook (automatikus mentés)

Mielőtt a Claude Code kontextusablaka tömörítődik, a `PreCompact` hook átnézi a beszélgetést, kiemeli a fontos döntéseket/preferenciákat/tanulságokat, elmenti a megfelelő tierbe, és napi napló bejegyzést ír — így a tömörítéskor semmi fontos nem vész el.

### Gráf nézet + embedding backfill

A dashboard memória-oldalán force-directed (HTML5 Canvas) gráf: zoom/pan, keresés-highlight, kattintásra kibontható panel, a kulcsszó-kapcsolatokat mutatja ágensek közt. A régi, embedding nélküli emlékek automatikusan (és `POST /api/memories/backfill`-lel manuálisan) kapnak vektort.

### API

```bash
POST /api/memories                       # mentés (agent_id, content, tier, keywords)
GET  /api/memories?agent=&q=&tier=        # keresés (kulcsszó)
GET  /api/memories/search?agent=&q=&hybrid=true   # hibrid (FTS5 + vektor)
POST /api/daily-log                       # napi napló (append-only)
POST /api/memories/backfill               # embedding backfill
```

Zero-config: az SQLite automatikusan létrejön, az embedding mentéskor generálódik.
