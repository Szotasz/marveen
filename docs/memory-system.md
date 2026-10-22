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

#### Kereshető tükör a memóriában

Minden `POST /api/daily-log` bejegyzés ugyanabban az SQLite-tranzakcióban egy `memories` sort is létrehoz, ezért a napló a memória-keresésben (`GET /api/memories`, kulcsszavas és `mode=hybrid` is) azonnal megtalálható; a vektor az embedding elkészülte után (másodpercek) csatlakozik, Ollama nélkül a meglévő embedding-backfill pótolja.

- **Tier és forma:** `cold` (hogy a hot-lista ne teljen meg napló-sorokkal, amik nyitott feladatnak látszanának), szektor `episodic`. A tartalom `[Napló ÉÉÉÉ-HH-NN ÓÓ:PP] <szöveg>`, a kulcsszavak `napi-naplo, ÉÉÉÉ-HH-NN`; a sor `created_at`-je a napló-sor `created_at`-je.
- **Kapcsolat:** a `daily_log_memory` tábla köti a napló-sort a tükör-sorhoz (mindkét oldal `UNIQUE`), ez teszi az újrafuttatást idempotenssé. Ha valaki töröl egy tükör-sort, a kapcsolat marad, így a backfill nem támasztja fel szándékosan törölt emléket.
- **Tartalomszűrő:** a tükör ugyanazon a szűrőn megy át, mint a `POST /api/memories`. Ha a szöveg elbukik rajta, a napló-sor ettől még elmentődik (a napló viselkedése nem változik), a tükör-sor nem jön létre, és a válaszban `memory_mirror: "skipped:content-filter"` jelzi (siker esetén a `memory_mirror` a tükör-sor azonosítója). Adatbázis-hiba mindkét sort visszagörgeti.
- **Backfill a régi sorokra:** `npx tsx scripts/daily-log-backfill-memories.ts [--db <út>]` (szárazon fut, csak számol és NEM ír: az adatbázist csak olvasásra nyitja, migrációt sem futtat; ha a kapcsolat-tábla hiányzik, kiírja, mit hozna létre az `--apply`, és minden napló-sort függőnek számol), `--apply`-jal ír. Minden sor a saját `created_at`-jével tükröződik. A végén kiírja: napló-sorok, már tükrözött, új (vagy "would create"), kihagyott (szűrő vagy üres), hibás. Az embeddinget nem készíti el (a folyamat előbb kilép), azt a meglévő backfill pótolja.

### Dátumszűrő a keresésen

`GET /api/memories` három paramétert fogad el, mind az `Europe/Budapest` (telepítési zóna) naptári napjaira vonatkozik, a határok zárt intervallumok (00:00:00 - 23:59:59 helyi idő, az óraállítás napján is: 2026-10-25 25 órás nap):

| Paraméter | Érték |
|---|---|
| `date=` | a `/api/recall` nyelvtana: `ma`, `tegnap`, `mult heten`, `ezen a heten`, `ÉÉÉÉ-HH-NN`, `ÉÉÉÉ-HH-NN - ÉÉÉÉ-HH-NN`, `utolso 7 nap` stb. |
| `since=` | nap vagy kifejezés; kifejezésnél annak első napja |
| `until=` | nap vagy kifejezés; kifejezésnél annak utolsó napja |

- A `date` nem keverhető `since`/`until`-lal. Ismeretlen kifejezés, nem létező nap (`2026-02-30`), fordított tartomány (`since` > `until`) és a fenti keverés **400**, a felismert alakok felsorolásával: a szűrő soha nem marad el némán.
- **A szűrő SQL-ben, a LIMIT előtt érvényesül, minden ágban:** kulcsszavas (relaxed és strict), LIKE-tartalék, vektor-jelöltek, a hibrid mindkét lába a fúzió előtt, és a sima listázás (ágenssel és anélkül). Soha nem utószűrő: a 200 frissebb, ablakon kívüli sor nem tolja ki a találatot a `limit`-ből.
- **`X-Memory-Search`:** a fejléc végén `date=<tól>..<ig>` a ténylegesen használt tartománnyal (megadott `since` vagy `until` nélküli oldal üres: `date=2026-10-01..`). Szűrő nélkül nincs `date` mező. A `relaxed`, `strict`, `hits` jelentése változatlan; a dátumszűrő soha nem lazul, a "relaxed" csak a szavakra vonatkozik.
- **`offset`:** listázásnál `date`-tel együtt működik; `q`-val továbbra is 400.
- **Relevancia és dátumszűrő:** minden relevancia-számítás a szűrt jelölt-halmazon fut. A vektor-ág hasonlósági küszöbe (a medián + `MEMORY_VECTOR_MIN_MARGIN`, kis halmaznál az abszolút padló) a dátumablakba eső sorokból számolódik, nem a teljes tárból. Egy szűk ablak ezért kisebb halmazt (`MEMORY_VECTOR_BASELINE_MIN_ROWS` alatt a kis-korpusz padlót) jelent, ami a vektor-találatot szigorúbbá teheti; ugyanez igaz minden olyan relevancia-címkére vagy elhallgatásra (abstain), amely a legjobb jelölt hasonlóságából (`topCos`) dönt: a szűrés a `topCos`-t csökkentheti, és a címke a szűrt jelöltekre vonatkozik. Az üres találat ezért az ablakra szól, nem a teljes memóriára.
- **Index:** `memories(agent_id, created_at)` és `memories(category, created_at)` (idempotens migráció; a második az ágens listájába tartozó `shared` sorok miatt kell, különben az OR miatt teljes táblaolvasás lenne).

```bash
# tegnapi bejegyzések (a napló tükör-sorai is), kulcsszóra
curl -s -G -D /tmp/mem-fejlec.txt -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  --data-urlencode "agent=brainy" --data-urlencode "q=levél" --data-urlencode "date=tegnap" \
  "http://localhost:3420/api/memories"
grep -i '^x-memory-search' /tmp/mem-fejlec.txt
```

### PreCompact hook (automatikus mentés)

Mielőtt a Claude Code kontextusablaka tömörítődik, a `PreCompact` hook átnézi a beszélgetést, kiemeli a fontos döntéseket/preferenciákat/tanulságokat, elmenti a megfelelő tierbe, és napi napló bejegyzést ír — így a tömörítéskor semmi fontos nem vész el.

### Gráf nézet + embedding backfill

A dashboard memória-oldalán force-directed (HTML5 Canvas) gráf: zoom/pan, keresés-highlight, kattintásra kibontható panel, a kulcsszó-kapcsolatokat mutatja ágensek közt. A régi, embedding nélküli emlékek automatikusan (és `POST /api/memories/backfill`-lel manuálisan) kapnak vektort.

### API

```bash
POST /api/memories                       # mentés (agent_id, content, tier, keywords)
GET  /api/memories?agent=&q=&tier=        # keresés (kulcsszó); &date= | &since=&until= időszakra szűr
GET  /api/memories/search?agent=&q=&hybrid=true   # hibrid (FTS5 + vektor)
POST /api/daily-log                       # napi napló (append-only)
POST /api/memories/backfill               # embedding backfill
```

Zero-config: az SQLite automatikusan létrejön, az embedding mentéskor generálódik.

## Névjegyek

A névjegyek nem a memóriában élnek, hanem külön, append-only táblákban, forrással és tartománnyal: [contacts.md](contacts.md).
