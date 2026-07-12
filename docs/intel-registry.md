# Proaktív hírszerző (intel registry)

> Óránkénti gyűjtő + napi brief, közös SQLite registry-vel -- a reggeli összefoglaló nem a session emlékezetéből, hanem felhalmozott, strukturált tényekből épül.

---

## 🎯 Mit tud / miért érdekes

A legtöbb "napi hírösszefoglaló" automatizáció ugyanabba a falba ütközik: a reggeli brief csak azt látja, ami épp a kontextusában van, ezért vagy üres, vagy minden nap ugyanazt ismétli. Az intel registry ezt választja szét két szerepre:

- **Gyűjtő (intel-collector)**: óránként fut, csendben. Átfésüli az általad megadott témákat (versenytársak, árfolyamok, jogszabályi határidők -- bármi), és minden releváns találatot beír egy SQLite registry-be. Telegramot CSAK riasztás-szintű eseménynél küld (pl. sávon kívüli árfolyam).
- **Brief (intel-daily-brief)**: reggel 07:00-kor fut, és a registry utolsó 14 napjából épít priorizált összefoglalót: top 3 döntési jel, domainenkénti bontás, watchlist.

Amit ettől kapsz:

- **Deduplikáció**: ugyanaz a hír óránként újra felbukkanhat -- a determinista fact-id és a tartalom-hash miatt update lesz belőle, nem 24 duplikátum.
- **Tény-életciklus**: egy tény `new` → `evolving` → `stable` → `closed` státuszon megy át; a lezárt és a 14 napnál régebbi tételek kiesnek a briefből.
- **Watchlist**: ami még nem tény, csak irány ("figyelni érdemes, merre mozdul"), külön listán él, és a brief végén jelenik meg.
- **Döntésnapló**: az ajánlásokat feltevéssel, bizonyítékkal és falszifikálási feltétellel együtt rögzíti -- utólag visszamérhető, mi jött be.

## 🛠 Hogyan működik

### Komponensek

| Darab | Hely | Szerep |
|-------|------|--------|
| Séma + Python API + CLI | `scripts/intel_db.py` | 4 tábla, olvasó/író függvények, argparse CLI |
| Adatbázis | `store/intel.db` (override: `INTEL_DB` env) | első használatkor magától létrejön |
| Gyűjtő sablon | `seed-scheduled-tasks/intel-collector/` | óránkénti heartbeat, alapból kikapcsolva |
| Brief sablon | `seed-scheduled-tasks/intel-daily-brief/` | napi task 07:00, alapból kikapcsolva |

### Táblák

- `known_facts_registry`: id, title, domain, source, source_tier (1-3), status (new/evolving/stable/closed), priority_score (0..1), content, fact_hash (UNIQUE), created/updated/expires_at
- `watchlist`: követendő irányok, amelyek még nem tények
- `decision_log`: recommendation, reasoning, assumption, evidence, what_would_falsify, owner_reaction, outcome
- `active_focus`: aktuálisan kiemelt témák, deep/transient móddal és lejárattal

A séma idempotens (`CREATE TABLE IF NOT EXISTS`), minden CLI-hívás és import biztosítja -- friss telepítésen nincs külön migrációs lépés, de explicit is futtatható: `python3 scripts/intel_db.py init`.

### CLI

```bash
# Tény beírása (a collector fő útvonala)
python3 scripts/intel_db.py add-fact \
  --title "Versenytárs árcsökkentés" --domain market \
  --source "https://example.com/cikk" --tier 2 \
  --content "X termék ára 12%-kal csökkent Y piacon" --priority 0.7

# Watchlist / fókusz / döntés
python3 scripts/intel_db.py add-watch --title "Alapanyag-ár" --domain market --direction "emelkedő trend"
python3 scripts/intel_db.py add-focus --topic "Q3 beszerzés" --mode deep --days 30
python3 scripts/intel_db.py log-decision --recommendation "..." --reasoning "..."

# Minden, amit a brief olvas (JSON)
python3 scripts/intel_db.py dump --days 14   # vagy: --dump

# Health check (sorszámlálók)
python3 scripts/intel_db.py
```

Fact-id: ha nem adsz `--id`-t, a CLI determinista azonosítót generál (`<domain>-<YYYYMMDD>-<hash8>`), így ugyanaz a találat ugyanazon a napon update-be fut. Azonos tartalom MÁS id alatt (UNIQUE `fact_hash`) tiszta no-op: `DUPLICATE content already in registry`, exit 0 -- a collector-promptnak nem kell hibaágat kezelnie.

### Bekapcsolás

1. A telepítő a két sablont a `~/.claude/scheduled-tasks/` alá seedeli (`{{INSTALL_DIR}}`, `{{MAIN_AGENT_ID}}`, `{{OWNER_NAME}}` behelyettesítéssel), **kikapcsolt** állapotban.
2. Írd át az `intel-collector/SKILL.md` DOMAIN blokkjait a saját figyelt témáidra (a "FUTÁS VÉGE" registry-írás rész a fix kontraktus, azt hagyd meg).
3. Kapcsold be mindkét taskot (dashboard → Ütemezés, vagy `task-config.json` → `"enabled": true`).

### Python API

A brief (vagy bármely más fogyasztó) importálhatja is:

```python
import sys; sys.path.insert(0, "scripts")
from intel_db import get_active_registry, get_watchlist, get_active_focus
```

*Kapcsolódó: [Ütemezett feladatok](scheduled-tasks.md), [Heartbeat + autonómia](heartbeat-autonomy.md), [Dream-engine](dream-engine.md)*
