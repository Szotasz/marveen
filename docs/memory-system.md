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

---

## 📡 Olvasás-tracing és stale-read detekció

### Span reads

Minden ágenshez nyomon követjük, mikor és milyen kontextusban olvasta az egyes emlékeket. Ez az alap a "stale" detektáláshoz és az auto tier-átsoroláshoz.

```bash
# Egyszeri olvasás rögzítése
POST /api/memories/read-event
{ "agent_id": "agent-a", "memory_id": 42, "context": "heartbeat" }

# Batch rögzítés (heartbeat)
POST /api/memories/read-event
{ "reads": [
    { "agent_id": "agent-a", "memory_id": 42, "context": "heartbeat" },
    { "agent_id": "agent-a", "memory_id": 17, "context": "search" }
  ]
}
```

Érvényes `context` értékek: `heartbeat`, `search`, `direct`.

### Stale-read

Egy emlék **stale** (elavult), ha `updated_at > az ágens utolsó olvasásának időpontja`. Nincs fix időküszöb: kizárólag az ágenshez kötött span_read timestamp számít.

```bash
# Az ágens számára stale emlékek listája
GET /api/memories/stale?agent_id=agent-a
```

A dashboardon a memória-kártyákon narancssárga **Stale** badge jelzi az érintett emlékeket. Keresési eredményekben az `is_stale` mező is megjelenik, ha `q` és `agent` paraméter egyszerre van megadva — és a stale találatok kerülnek az eredménylista elejére.

---

## 🕓 Verzió-előzmények

Minden `updateMemory()` hívásnál, ha a tartalom, kategória vagy kulcsszavak változnak, a rendszer snapshot-ot ment a `memory_versions` táblába. A trigger helyett explicit `SELECT → INSERT → UPDATE` szekvencia fut, hogy a tulajdonos (`agent_id`) ne íródjon felül, ha egy másik ágens szerkeszt.

```bash
# Emlék verziótörténete
GET /api/memories/:id/versions
```

A dashboardon a szerkesztő-modálban **Előzmények** tab mutatja a változásokat időrendben (tartalom, kategória, változtató ágens, időbélyeg).

**Prune:** a `memory_versions` táblából 180 napnál régebbi sorok automatikusan törlődnek a karbantartó job futásakor.

---

## 🔄 Auto tier-átsorolás

A `runMemoryMaintenance()` egy tranzakcióban végzi el a három karbantartási lépést:

| Lépés | Feltétel | Eredmény |
|-------|----------|----------|
| warm → cold | legalább 30 napos ÉS az utolsó 30 napban egyetlen ágenstől sem olvasódott | cold-ba kerül |
| cold → warm | az utolsó 30 napban 2+ különböző ágens olvasta | warm-ba kerül |
| verzió prune | `changed_at < most - 180 nap` | törlés |

Fontos korlátok:
- **hot** soha nem kerül automatikusan cold-ba — hot-ot csak manuálisan mozgat a dream-engine.
- **shared** szintén kizárt az auto-cold-ból — minden ágenshez tartozik.
- Az **életkor-guard** (`created_at < most - 30 nap`) védi a frissen mentett emlékeket: egy ma létrehozott, még nem olvasott warm emlék nem kerül az első karbantartáson azonnal cold-ba.

```bash
POST /api/memories/resort
# Opcionális body (mind default-olt):
{ "warm_to_cold_days": 30, "cold_to_warm_days": 30, "min_agents": 2, "version_ttl_days": 180 }
# Válasz: { "ok": true, "warmToCold": N, "coldToWarm": N, "prunedVersions": N }
```

### Ütemezett karbantartó job

A `memory-maintenance` karbantartó job **alapból kikapcsolt** (`enabled: false`). Ez szándékos opt-in döntés: a tier-átsorolás visszafordítható ugyan, de éles rendszeren csak akkor szabad automatizálni, ha az operátor meggyőződött róla, hogy a threshold-ok (30 nap, 2 ágens) illeszkednek az adott flotta munkastílusához.

Bekapcsolás: a job megjelenik a dashboard **Ütemezések** listájában `memory-maintenance` néven, alapból kikapcsolva. Ott kapcsold be a sorához tartozó kapcsolóval — nem kell fájlt másolni vagy configot szerkeszteni.

Alapértelmezetten naponta 03:00-kor fut (`0 3 * * *`), csak akkor jelent Telegramon, ha valamelyik szám > 0.

---

## 🗄 Migráció: meglévő emlékek

A `0004_memory_span_tracing.sql` migration két dolgot tesz a meglévő adatokkal:

1. **`updated_at` backfill**: minden régi emlék kap `updated_at = created_at` értéket.
2. **Seed span_read**: minden meglévő emlékhez bekerül egy `context = NULL` span_read a migráció pillanatával mint `read_at`. Ez 30 napos kegyelmi időt ad — az első karbantartó futáson egyetlen aktívan használt emlék sem esik cold-ba pusztán azért, mert a span_reads tábla előtte nem létezett.

A `context = NULL` szándékos: az `IN ('heartbeat', 'search', 'direct')` CHECK constraint nem sérül, és a seed sorok megkülönböztethetők a valódi olvasásoktól.
