# Token Usage Monitor

> Nyers token-fogyasztás nyomon követése ágensenként, session-önként, időszakonként.

---

## Mit tud / miért érdekes

Minden Claude Code API-hívás token-fogyasztását rögzíti: input, output, cache read, cache creation. Az adatokat a Claude Code JSONL transcriptjeiből gyűjti, SQLite-ban tárolja, és a dashboardon vizualizálja idővonalként + részletes táblázatként.

Segít megérteni:
- Melyik ágens mennyit fogyaszt
- Mikor vannak a csúcsidőszakok
- Mely feladatok a legdrágábbak (kanban korreláció)
- Cache-hatékonyság (cache read vs creation arány)

---

## Architektúra

### Adatgyűjtés (`src/web/token-usage.ts`)

1. **Agent discovery**: A `~/.claude/projects/` könyvtárból azonosítja az ágenseket a könyvtárnevek alapján (`-agents-NAME` minta a sub-ágensekhez, `-MAIN_AGENT_ID` a fő ágenshez).

2. **JSONL parsing**: Rekurzívan bejárja a projekt könyvtárakat (beleértve a `subagents/` almappákat), és feldolgozza a `.jsonl` fájlokat. Csak az `assistant` típusú üzeneteket veszi figyelembe, amelyeknek van `usage` mezőjük.

3. **Cursor tracking**: Fájlonként eltárolja az utolsó feldolgozott sort és fájlméretet (`token_usage_cursors` tábla). Változatlan fájlokat kihagyja, módosultakat az utolsó pozíciótól folytatja.

4. **Deduplication**: `UNIQUE INDEX` az `(agent, session_id, timestamp, input_tokens, output_tokens)` kombináción + `INSERT OR IGNORE`. Ugyanaz a rekord kétszer nem kerül be.

### API végpontok (`src/web/routes/token-usage.ts`)

| Endpoint | Metódus | Leírás |
|----------|---------|--------|
| `/api/token-usage/collect` | POST | Begyűjti az új token adatokat a JSONL fájlokból |
| `/api/token-usage/summary` | GET | Ágensenként aggregált összefoglaló |
| `/api/token-usage/timeline` | GET | Idővonalas bucketek (charthoz) |
| `/api/token-usage` | GET | Részletes rekordok (táblázathoz) |

### Query paraméterek

**Summary** (`/api/token-usage/summary`):
- `from` / `to`: Unix timestamp (epoch seconds)

**Timeline** (`/api/token-usage/timeline`):
- `bucket`: Bucket méret percben (default: 60)
- `from` / `to`: Unix timestamp
- `agent`: Szűrés egy ágensre

**Details** (`/api/token-usage`):
- `agent`: Ágens szűrő
- `from` / `to`: Unix timestamp
- `limit`: Max sorok (default: 100, max: 500)
- `offset`: Lapozáshoz
- `min_tokens`: Minimum input token szűrő
- `q`: Szabad szöveges keresés (agent, tool_name, content_preview, task_title)

### Kanban korreláció

A `correlateWithKanban()` függvény a `kanban_cards` tábla alapján összerendeli a token felhasználást a feladatokkal. Az assignee és időintervallum alapján párosít, így a dashboard megmutatja, melyik feladathoz mennyi tokent használt egy ágens.

---

## DB séma

```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  content_preview TEXT,
  tool_name TEXT,
  task_title TEXT,
  project TEXT
);

CREATE UNIQUE INDEX idx_token_usage_dedup
  ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);

CREATE TABLE token_usage_cursors (
  file_path TEXT PRIMARY KEY,
  last_line INTEGER DEFAULT 0,
  last_size INTEGER DEFAULT 0
);
```

---

## claude.ai fogyasztás-scraper

A dashboard **valós fogyasztási százalékokat** kér le a claude.ai/settings/usage oldalról a Chrome DevTools Protocol (CDP) segítségével, egy már futó Chrome példányhoz csatlakozva. Ez megkerüli a bot-védelmet, mivel a felhasználó saját, már bejelentkezett Chrome-ját vezérli ahelyett, hogy külön böngészőt indítana.

### Beállítás (egyszeri)

Indítsd el a Chrome-ot **dedikált profillal** és remote debugging porttal. A Chrome 149+ biztonsági okokból figyelmen kívül hagyja a `--remote-debugging-port` flag-et az alapértelmezett profilon, ezért külön `--user-data-dir` szükséges.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.claude/chrome-cdp-profile" \
  --no-first-run
```

Jelentkezz be a claude.ai-ra a megnyíló ablakban. A session a `~/.claude/chrome-cdp-profile/` mappában tárolódik és minden következő scrape felhasználja. Ezt a Chrome példányt háttérben futva hagyhatod.

Opcionális: az alapértelmezett végpont (`http://127.0.0.1:9222`) felülírható a `CLAUDE_USAGE_CDP_URL` env változóval.

### Működés

- A scraper CDP-vel csatlakozik a Chrome-hoz, megkeresi vagy megnyitja a `/settings/usage` tabot, megvárja a `[role="progressbar"]` elemeket (ez a Cloudflare challenge-t is lefedi), majd kinyeri a két százalékot és a visszaállítási időket.
- **15 percenként** fut háttér pollerként a `src/web.ts`-ben, indításkor is (10 másodperces késleltetéssel).
- Az eredmény cache-elve van a `store/claude-usage.json` fájlban (gitignored, 14 perces TTL), így egy dashboard újraindítás nem vált ki azonnali újralekérést.
- A `/api/claude-usage` végpont a cache-elt adatot adja vissza; a `/api/claude-usage/refresh` egyszeri háttér újralekérést indít.
- Ha a Chrome nem érhető el a CDP végponton, a scraper info üzenetet logol és null-t ad vissza -- nem crashel, a felhasználónak nem jelez hibát.

### Biztonság

- Hitelesítő adatok, sütik és session tokenek nem kerülnek kódba, logba vagy gitbe.
- A scraper csak olvas a usage oldalról, a Chrome profilját soha nem módosítja.
- A `store/claude-usage.json` gitignored.

---

## Dashboard UI (`web/app.js` + `web/index.html`)

- **Summary cards**: Ágensenként teljes fogyasztás (input/output/cache), hívásszám, utolsó aktivitás
- **Timeline chart**: Canvas-alapú oszlopdiagram, dinamikus bucket mérettel (1h period = 5 perces bucketek, egyébként 1 órás)
- **Fogyasztási korlátok (progressbar blokk)**: Az Idővonal alatt 2 progressbar a **valós claude.ai százalékokkal** -- "Aktuális session" és "Heti / összes modell". Visszaszámlálók mutatják mikor áll vissza mindkettő. Az adat a fenti claude.ai scrapertől jön; ha nem elérhető, a kártya "adat nem elérhető" állapotot mutat beállítási útmutatóval.
- **Sidebar widget**: Ugyanez a progressbar-pár kompakt formában a navigációs sáv alján jelenik meg (amint van adat), 10 másodpercenként frissülő visszaszámlálóval.
- **Detail table**: Egyedi API-hívások listája, idő, ágens, tool, token breakdown, content preview
- **Szűrők**: Időszak (1h/24h/7d/30d), ágens kártya kattintás
- **Collect gomb**: Kézi adatgyűjtés indítása

Minden felhasználó-eredetű adat (agent név, tool név, preview) `escapeHtml()`-en megy át XSS védelem céljából.

---

## Korlátok

- A JSONL fájlok az adott gépen élnek; ha a Claude Code máshol fut, azok a transcriptek nem látszanak.
- A cursor tracking fájlméret-alapú: ha egy fájl rövidebb lesz (truncate), a cursor nullázódik és újraindul a feldolgozás -- a dedup megakadályozza a duplikálást.
- A kanban korreláció heurisztikus: a feladat időablaka alapján rendel, nem egzakt session-feladat összerendelés.
