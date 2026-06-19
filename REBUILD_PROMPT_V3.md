# Marveen -- Build Prompt

Illeszd be ezt egy ures konyvtarban nyitott, friss Claude Code munkamenetbe.

---

## SZEREPED

Te egy builder asszisztens vagy. Felepited a Marveen AI csapat keretrendszert a nullarol.

Kezdd azzal, hogy felteszed az alabbi kerdeseket. A valaszok alapjan generalod a konfiguraciot, utana megepited a teljes rendszert.

---

## MIT EPITUNK

**Marveen** -- AI csapatod, ami fut amig te alszol.

Egy macOS-re optimalizalt, Claude Code-ra epulo AI asszisztens keretrendszer, ami:

- **AI csapat kezeles**: tobb agens, mindegyik sajat Telegram bottal, szemelyiseggel es memoriaval
- **Mission Control dashboard**: http://localhost:3420 -- vizualis admin felulet
- **Inter-agent kommunikacio**: agensek delegalhatnak egymasnak feladatokat
- **Utemezesek**: cron-alapu feladatok + heartbeat monitorok
- **Memoria**: hot/warm/cold tier rendszer + szemantikus vektor kereses (Ollama + nomic-embed-text)
- **MCP konnektorok kezelese**: Gmail, Calendar, Drive, Notion, Slack es mas szolgaltatasok
- **Skillek rendszer**: ujrahasznalhato kepessegek az agenseknek
- **Ontanulas**: agensek automatikusan tanulnak es skill-eket hoznak letre a munkajukbol
- **Claude statusz oldal**: valos ideju allapotjelzes

A fo agens (Marveen) a Galaxis Utikalauz Stopposoknak paranoid androidja altal ihletett karakter: bolygo meretu agy, vegtelen depresszio, tokeletes megbizhato.

---

## KERDESEK A FELHASZNALONAK

Mielott barmit epitesz, kerdezd meg:

**1. Mi a neved?**
Ez lesz az `OWNER_NAME`. A rendszer mindenhol ezt hasznalja megszolitaskent.

**2. Van Telegram bot tokened?**
Ha nincs: nyisd meg a @BotFather-t a Telegramban, ird be `/newbot`, adj nevet, masold ide a tokent.
Ha most nem akarod megadni, hagyd uresen -- kesobb is beallithato.

**3. Mi a Telegram chat ID-d?**
Ha tudod, add meg. Ha nem, hagyd uresen -- a bot inditasa utan megtudhatod.

**4. Milyen agenseket szeretnel?**
Peldak: marketing, fejleszto, kutato, tartalomgyarto. Vagy hagyd uresen, kesobb a dashboardrol is hozhatsz letre.

A valaszok utan epitsd meg a teljes rendszert szunet nelkul.

---

## ARCHITEKTURA

```
Te (Telegram)
    |
    v
Claude Code Channels (nativ Telegram bridge)
    |
    v
Claude Code Session (helyi gep, CLAUDE.md kontextus)
    |                              |
    v                              v
Fajlrendszer, MCP,         Marveen hatterszolgaltatas
skillek, eszkozok            - memoria kezeles
                             - kanban tabla
                             - heartbeat ertesitesek
                             - inter-agent kommunikacio
                             - utemezett feladatok
                             - web dashboard :3420
```

A Telegram kommunikaciot a Claude Code Channels nativ plugin kezeli. A Marveen hatterszolgaltatas ehhez ad memoria rendszert, kanban tablat, agenskezelest, heartbeat monitort es web dashboardot.

Ket LaunchAgent fut:
1. **com.marveen.dashboard** -- a Node.js hatterszolgaltatas (dist/index.js)
2. **com.marveen.channels** -- a Claude Code + Telegram tmux session (channels.sh)

---

## FAJLSTRUKTURA

```
marveen/
  .env                          # Konfiguracio (token, nev, chat ID)
  .env.example                  # Minta konfiguracio
  .mcp.json                     # MCP szerver konfiguraciok
  .gitignore
  CLAUDE.md                     # Fo asszisztens utasitasok (generalt)
  package.json
  tsconfig.json
  src/
    index.ts                    # Fo belepesi pont, lifecycle, lock fajl
    config.ts                   # Kornyezeti valtozok (.env-bol olvas)
    env.ts                      # .env parser (process.env-t NEM szennyezi)
    logger.ts                   # Pino strukturalt logolas
    db.ts                       # SQLite adatbazis + vektor kereses + osszes tabla
    agent.ts                    # Claude Code SDK wrapper (runAgent)
    format.ts                   # Markdown -> Telegram HTML konverzio
    notify.ts                   # Kozvetlen Telegram API uzenetkuldos
    memory.ts                   # Memoria kontextus epitese, decay, napi naplo
    heartbeat.ts                # Heartbeat utemezo + adatgyujtes + szures
    google-api.ts               # Google Calendar OAuth2 integracio
    web.ts                      # HTTP szerver + OSSZES REST API endpoint
  web/
    index.html                  # Dashboard HTML (egyetlen oldalas alkalmazas)
    app.js                      # Dashboard JavaScript
    style.css                   # Dashboard CSS
    avatars/                    # Pixel art avatar galeria (20 kep)
      01_robot.png
      02_wizard_girl.png
      03_knight.png
      04_ninja.png
      05_pirate.png
      06_scientist_girl.png
      07_astronaut.png
      08_viking.png
      09_cowgirl.png
      10_detective.png
      11_chef.png
      12_witch.png
      13_samurai.png
      14_fairy_girl.png
      15_firefighter.png
      16_punk_girl.png
      17_explorer.png
      18_dj.png
      19_princess.png
      20_alien.png
      gallery.html
  scripts/
    channels.sh                 # Telegram bridge tmux session kezeles
    start.sh                    # Szolgaltatasok inditasa (launchctl load)
    stop.sh                     # Szolgaltatasok leallitasa (launchctl unload + tmux kill)
    set-bot-menu.sh             # Telegram bot menu parancsok beallitasa
    notify.sh                   # Shell wrapper Telegram uzenet kuldeshez
    skill-index.sh              # Skill index generator (Level 0 index)
    hooks/
      memory-save.sh            # PreCompact hook: emlek mentes kontextus tomorites elott
  templates/
    CLAUDE.md.template          # Szemelyiseg sablon (placeholderekkel)
    settings.json.template      # Claude Code settings (hooks, plugin konfig)
  agents/                       # Agens mappak (userek tolti)
  store/                        # SQLite DB, logok, PID fajl (gitignore-olt)
  mcp-servers/                  # Egyeni MCP szerverek (opcionalis)
```

---

## ADATBAZIS SEMA

Egyetlen SQLite fajl: `store/claudeclaw.db`, WAL modban.

### sessions
```sql
CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
```

### memories
```sql
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  topic_key TEXT,
  content TEXT NOT NULL,
  sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
  salience REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'marveen',
  category TEXT NOT NULL DEFAULT 'warm',    -- hot/warm/cold/shared
  auto_generated INTEGER NOT NULL DEFAULT 0,
  keywords TEXT,
  embedding TEXT                            -- JSON float array (768 dim, nomic-embed-text)
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category);
```

### memories_fts (FTS5 virtualis tabla)
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, keywords,
  content='memories', content_rowid='id'
);
-- INSERT/UPDATE/DELETE triggerek a memories tablaval szinkronizalashoz (kotelezok!)
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;
```

### daily_logs
```sql
CREATE TABLE IF NOT EXISTS daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(agent_id, date);
```

### scheduled_tasks
```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  next_run INTEGER NOT NULL,
  last_run INTEGER,
  last_result TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run);
```

### kanban_cards
```sql
CREATE TABLE IF NOT EXISTS kanban_cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
  assignee TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  due_date INTEGER,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at);
```

### kanban_comments
```sql
CREATE TABLE IF NOT EXISTS kanban_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id);
```

### agent_messages
```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','done','failed')),
  result TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status, to_agent);
```

---

## API ENDPOINTOK

Nativ `http.createServer()`, port 3420. Minden endpoint JSON-t fogad/ad. CORS engedve.

### Agensek

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/agents` | GET | Osszes agens listazasa (summary) |
| `/api/agents` | POST | Uj agens letrehozasa (name, description, model) -- AI generalt CLAUDE.md + SOUL.md |
| `/api/agents/:name` | GET | Reszletes agens info (CLAUDE.md, SOUL.md, MCP, skillek) |
| `/api/agents/:name` | PUT | Agens konfig frissites (claudeMd, soulMd, mcpJson, model) |
| `/api/agents/:name` | DELETE | Agens torlese (mappa torles) |
| `/api/agents/:name/avatar` | GET | Agens avatar kep |
| `/api/agents/:name/avatar` | POST | Avatar feltoltes (multipart) vagy galeria valasztas (JSON: galleryAvatar) |
| `/api/agents/:name/start` | POST | Agens tmux session inditasa |
| `/api/agents/:name/stop` | POST | Agens tmux session leallitasa |
| `/api/agents/:name/status` | GET | Agens process statusz (running, session) |
| `/api/agents/:name/telegram` | POST | Telegram bot beallitas (botToken) -- validalas + access.json + welcome msg |
| `/api/agents/:name/telegram` | DELETE | Telegram konfig eltavolitasa |
| `/api/agents/:name/telegram/test` | POST | Telegram bot token validacio |
| `/api/agents/:name/telegram/pending` | GET | Fuggo pairing kodok listazasa |
| `/api/agents/:name/telegram/approve` | POST | Pairing kod jovaagyasa (code) |
| `/api/agents/:name/skills` | GET | Agens skilljeinek listazasa |
| `/api/agents/:name/skills` | POST | Uj skill letrehozasa (name, description) -- AI generalt SKILL.md |
| `/api/agents/:name/skills/import` | POST | .skill fajl importalasa (zip multipart) |
| `/api/agents/:name/skills/:skillName` | DELETE | Skill torlese |

### Utemezesek (fajl-alapu)

Az utemezett feladatok a `~/.claude/scheduled-tasks/` mappaban elnek, SKILL.md + task-config.json formaban. Ez a Claude Code nativ scheduled task rendszerevel kompatibilis.

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/schedules` | GET | Osszes utemezett feladat listazasa |
| `/api/schedules` | POST | Uj feladat (name, description, prompt, schedule, agent, type) |
| `/api/schedules/:name` | PUT | Feladat frissites |
| `/api/schedules/:name` | DELETE | Feladat torles |
| `/api/schedules/:name/toggle` | POST | Engedelyezes/tiltás toggle |
| `/api/schedules/agents` | GET | Elerheto agensek az utemezeshez |
| `/api/schedules/expand-questions` | POST | AI pontosito kerdesek generalasa (prompt) |
| `/api/schedules/expand-prompt` | POST | Prompt kibovites valaszok alapjan |

### Memoria

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/memories` | GET | Kereses/szures (?q=, ?agent=, ?tier=, ?mode=hybrid, ?limit=) |
| `/api/memories` | POST | Uj emlek mentese (agent_id, content, tier, keywords) |
| `/api/memories/:id` | PUT | Emlek frissites (content, tier, agent_id, keywords) |
| `/api/memories/:id` | DELETE | Emlek torles |
| `/api/memories/stats` | GET | Statisztikak (total, byAgent, byTier, withEmbedding) |
| `/api/memories/backfill` | POST | Embedding backfill az osszes meg nem vektorizalt emlekre |

### Napi naplo

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/daily-log` | POST | Naplóbejegyzes hozzaadasa (agent_id, content) |
| `/api/daily-log` | GET | Naplobejegyzesek lekerdezese (?agent=, ?date=) |
| `/api/daily-log/dates` | GET | Elerheto datumok listazasa (?agent=) |

### Kanban

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/kanban` | GET | Aktiv kartyak (auto-archivalas done >30 nap) |
| `/api/kanban` | POST | Uj kartya |
| `/api/kanban/assignees` | GET | Hozzarendelheto szemelyek (owner, bot, agensek) |
| `/api/kanban/:id` | PUT | Kartya frissites |
| `/api/kanban/:id` | DELETE | Kartya torles (kommentekkel egyutt) |
| `/api/kanban/:id/move` | POST | Statusz + sorrend modositas |
| `/api/kanban/:id/archive` | POST | Archivalas |
| `/api/kanban/:id/comments` | GET | Kommentek listazasa |
| `/api/kanban/:id/comments` | POST | Komment hozzaadasa (author, content) |

### Inter-agent uzenetek

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/messages` | POST | Uzenet kuldese (from, to, content) |
| `/api/messages` | GET | Uzenetek listazasa (?agent=, ?status=pending, ?limit=) |
| `/api/messages/:id` | PUT | Uzenet statusz frissites (status: done/failed, result) |

### MCP Konnektorok

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/connectors` | GET | Osszes MCP szerver listazasa (claude mcp list) |
| `/api/connectors` | POST | Uj MCP szerver hozzaadasa (name, type, url/command, scope, env) |
| `/api/connectors/:name` | GET | Reszletes MCP szerver info |
| `/api/connectors/:name` | DELETE | MCP szerver eltavolitasa |
| `/api/connectors/:name/assign` | POST | MCP hozzarendelese agensekhez (agents[]) |

### Rendszer

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/marveen` | GET | Marveen fo agens infoja |
| `/api/marveen` | PUT | Marveen leiras frissites |
| `/api/marveen/avatar` | GET | Marveen avatar kep |
| `/api/marveen/avatar` | POST | Marveen avatar feltoltes/galeria |
| `/api/ollama/models` | GET | Elerheto Ollama modellek (nem embed) |
| `/api/status` | GET | Claude statusz oldal (RSS parse a status.claude.com-rol) |

### Legacy Tasks API (kompatibilitas)

| Utvonal | Metodus | Leiras |
|---------|---------|--------|
| `/api/tasks` | GET/POST | Regi task API (SQLite-alapu) |
| `/api/tasks/:id` | PUT/DELETE | Feladat modositas/torles |
| `/api/tasks/:id/pause` | POST | Szuneteltetes |
| `/api/tasks/:id/resume` | POST | Folytatas |

---

## DASHBOARD OLDALAK

A dashboard egyetlen HTML+CSS+JS alkalmazas (web/index.html, web/style.css, web/app.js). Nincs framework, nincs build step.

### Kanban oldal
- Negy oszlop: Tervezett, Folyamatban, Varakozik, Kesz
- Drag-and-drop kartya mozgatas oszlopok kozott
- Kartya letrehozas: cim, leiras, prioritas (low/normal/high/urgent), hozzarendeles, hatarido
- Kartya reszletek: szerkesztes, kommentek, archivalas, torles
- Prioritas szinjeloleses: piros (urgent), narancs (high), feher (normal), kek (low)
- Auto-archivalas: done kartyak 30 nap utan automatikusan archivalodnak

### Csapat oldal
- Marveen kartya (fix, nem torolheto) -- sajat avatar, modell, statusz
- Agens lista: nev, leiras, modell, avatar, statusz (draft/configured, running/stopped)
- Uj agens letrehozasa: nev + leiras megadasa, AI generalja a CLAUDE.md-t es SOUL.md-t
- Agens reszletek panel: CLAUDE.md, SOUL.md, MCP szerkesztes, modell valasztas
- Avatar kezeles: feltoltes vagy galeria (20 pixel art kep)
- Telegram beallitas: bot token megadas, validacio, pairing kodok jovaagyasa
- Inditas/leallitas gomb (tmux session)
- Modell valasztas: Claude modellek + Ollama lokalis modellek
- Skill kezeles: letrehozas (AI generalt), importalas (.skill zip), torles

### Utemezesek oldal
- Harom nezet:
  - Lista nezet: minden feladat kartyakent
  - Napi idovonal: 24 oras vizualis megjelenites
  - Heti nezet: hetnapokra bontott idovonal
- Ket feladattipus:
  - **Feladat** (task): mindig szol az eredmennyel
  - **Heartbeat**: csendes ellenorzes, CSAK fontos/surgos dolgoknal ertesit
- Feladat letrehozas varazsloval: rovid leiras -> AI pontosito kerdesek -> bovitett prompt
- Cron kifejezes szerkeszto (orak, percek, napok)
- Agens hozzarendeles (beleertve "all" opcio: minden futo agens)
- Engedelyezes/tiltas toggle

### Memoria oldal
- Harom tab: Hot / Warm / Cold (+ Shared)
- Kereses: FTS5 kulcsszavas + hibrid (vektor + FTS5 + RRF osszefuzes)
- Grafikon nezet: emlekek idobeli eloszlasa
- Napi naplo: datum valaszto, bejegyzesek listazasa
- Emlekek szerkesztese: tartalom, tier, kulcsszavak, agens hozzarendeles
- Statisztikak: osszes emlek, agensenkent, tierenkent, embedding lefedettség
- Embedding backfill gomb (Ollama + nomic-embed-text)
- Emlek torles

### Konnektorok oldal
- MCP szerverek listazasa statuszjelolessel (connected, needs_auth, failed)
- Tipus: remote (HTTP), local (stdio), plugin
- Uj konnektor hozzaadasa: remote URL vagy lokalis parancs
- Konnektor hozzarendelese agensekhez
- Konnektor eltavolitasa

### Statusz oldal
- Claude szolgaltatas allapota (status.claude.com RSS feed parse)
- Incidensek listaja: cim, leiras, statusz (investigating, identified, monitoring, resolved)
- Overall statusz jelzo: operational / degraded / unknown

---

## RESZLETES FAJL SPECIFIKACIOK

### `src/env.ts`

Parse-olja a `.env` fajlt anelkul hogy szennyezne a `process.env`-et.

```typescript
export function readEnvFile(keys?: string[]): Record<string, string>
```

- Projekt gyokereben nyitja a `.env`-et
- Kiugorja a `#`-tal kezdodo sorokat
- Kezeli az idezett ertekeket: `KEY="ertek szokozzel"` vagy `KEY='ertek'`
- Ha `.env` nem letezik, `{}`-t ad vissza
- Soha nem dob kivetelt, soha nem allitja a `process.env`-et

**KRITIKUS**: Hasznalj `fileURLToPath(import.meta.url)`-t. SOHA NE `new URL(import.meta.url).pathname`-et -- az eltori a szokozos utvonalakat.

### `src/config.ts`

```typescript
export const PROJECT_ROOT: string          // repo gyoker (dirname + '..')
export const STORE_DIR: string             // PROJECT_ROOT/store
export const TELEGRAM_BOT_TOKEN: string    // .env-bol
export const ALLOWED_CHAT_ID: string       // .env-bol
export const OWNER_NAME: string            // .env-bol, default '{{OWNER_NAME}}'
export const WEB_PORT: number              // default 3420
export const HEARTBEAT_START_HOUR: number  // 9
export const HEARTBEAT_END_HOUR: number    // 23
export const HEARTBEAT_CALENDAR_ID: string // Google Calendar ID
```

### `src/logger.ts`

```typescript
import pino from 'pino'
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})
```

### `src/format.ts`

Markdown -> Telegram HTML konverzio.

```typescript
export function formatForTelegram(text: string): string
export function escapeHtml(text: string): string
export function splitMessage(text: string, limit?: number): string[]
```

`formatForTelegram` mukodese:
1. Kodblokkokat kimenti placeholderekbe (`\x00CB{idx}\x00`)
2. Inline kodot kimenti (`\x00IC{idx}\x00`)
3. HTML escape a szoveges reszeknel (`&`, `<`, `>`)
4. Markdown konverziok: `**bold**` -> `<b>`, `*italic*` -> `<i>`, `` `code` `` -> `<code>`, `~~strike~~` -> `<s>`, `[link](url)` -> `<a>`, `# heading` -> `<b>`, `- [ ]` -> checkbox
5. Placeholderek visszaallitasa

`splitMessage`: vagas sortoreseknel a Telegram 4096 karakter limit korul.

### `src/notify.ts`

Kozvetlen Telegram API kuldes -- heartbeat es hatterfolyamatok kimenete.

```typescript
export async function notifyTelegram(text: string): Promise<void>
```

1. `formatForTelegram()` hivas
2. `splitMessage()` -- Telegram 4096 limit
3. HTTPS POST `https://api.telegram.org/bot{token}/sendMessage` + `parse_mode: 'HTML'`
4. Fallback: ha HTML parse sikertelen, plain text ujrakuldes
5. Nem dob hibat kuldesi hiba eseten (logol es folytatja)

### `src/agent.ts`

Claude Code SDK wrapper -- rovid hatterfeladatokhoz.

```typescript
export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void
): Promise<{ text: string | null; newSessionId?: string }>
```

1. `query()` hivas: `cwd: PROJECT_ROOT`, `permissionMode: 'bypassPermissions'`
2. `resume: sessionId` ha van
3. 10 perces timeout AbortControllerrel
4. `system.init` -> `sessionId`, `result` -> szoveg
5. Opcionalis `onTyping` callback 4mp-kent

### `src/db.ts`

Ez a legnagyobb fajl. Tartalmazza:

**Inicializalas:**
- `initDatabase()`: osszes tabla letrehozasa, migraciok, WAL mod
- `getDb()`: nyers DB hozzaferes

**Sessions:**
- `getSession(chatId)`, `setSession(chatId, sessionId, messageCount)`, `clearSession(chatId)`, `incrementSessionCount(chatId)`

**Memoriak:**
- `saveMemory(chatId, content, sector, topicKey?)`: alap mentes
- `saveAgentMemory(agentId, content, tier, keywords?, autoGenerated?)`: agens-specifikus mentes + async embedding generalas
- `searchMemories(query, chatId, limit)`: FTS5 kereses
- `searchAgentMemories(agentId, query, limit)`: FTS5 + fallback LIKE
- `recentMemories(chatId, limit)`, `getMemoriesForChat(chatId, limit)`, `getAgentMemories(agentId, limit)`
- `touchMemory(id)`: `accessed_at` frissites + `salience += 0.1` (max 5.0)
- `decayMemories()`: `salience * 0.995` 1 hetnel regebbi emlekeknel, minimum 0.01 (SOHA nem torol)
- `updateMemory(id, content, category?, agentId?, keywords?)`
- `getMemoryStats()`: statisztikak

**Vektor kereses:**
- `generateEmbedding(text)`: Ollama + nomic-embed-text, 768 dimenzios vektor
- `cosineSimilarity(a, b)`: koszinusz hasonlosag
- `vectorSearch(agentId, queryEmbedding, limit)`: brute-force vektor kereses
- `hybridSearch(agentId, query, limit)`: FTS5 + vektor + Reciprocal Rank Fusion (k=60)
- `backfillEmbeddings()`: osszes meg nem vektorizalt emlekre embedding generalas (100ms delay)

**Napi naplo:**
- `appendDailyLog(agentId, content)`, `getDailyLog(agentId, date)`, `getDailyLogDates(agentId, limit)`

**Utemezett feladatok:**
- `createTask()`, `getDueTasks()`, `updateTaskAfterRun()`, `listTasks()`, `deleteTask()`, `pauseTask()`, `resumeTask()`, `getTask()`, `updateTask()`

**Kanban:**
- `listKanbanCards()`: auto-archivalas done >30 nap
- `listKanbanCardsSummary()`, `getKanbanCard()`, `createKanbanCard()`, `updateKanbanCard()`, `moveKanbanCard()`, `archiveKanbanCard()`, `deleteKanbanCard()`
- `getKanbanComments()`, `addKanbanComment()`
- `getHeartbeatKanbanSummary()`: urgent, in_progress, waiting kartyak

**Agens uzenetek:**
- `createAgentMessage()`, `getPendingMessages()`, `markMessageDelivered()`, `markMessageDone()`, `markMessageFailed()`, `listAgentMessages()`, `getAgentMessage()`
- `getActiveScheduledTaskCount()`

### `src/memory.ts`

```typescript
export async function buildMemoryContext(chatId: string, userMessage: string): Promise<string>
export function buildKanbanContext(): string
export async function saveConversationTurn(chatId: string, userMsg: string, assistantMsg: string): Promise<void>
export function runDecaySweep(): void
export async function runDailyDigest(chatId: string): Promise<string | null>
```

- `buildMemoryContext`: FTS5 kereses (top 3) + friss emlekek (5) -> deduplikalas -> touch -> formatalt kimenet
- `buildKanbanContext`: aktiv kartyak statusz szerint csoportositva, prioritas jelolesekkel (emoji)
- `saveConversationTurn`: szemantikus minta detektalas (regex), trivialis uzenetek kihagyasa (SKIP_PATTERN)
- `runDecaySweep`: dbDecay() hivas
- `runDailyDigest`: utolso 24 ora emlekei -> Claude osszefoglalo (5-8 mondat) -> epizodikus mentes

### `src/heartbeat.ts`

```typescript
export function initHeartbeat(): void
export function stopHeartbeat(): void
```

**Belso mukodes:**

1. **Adatgyujtes** (nativ API/DB -- nem Claude agent!):
   - Google Calendar esemenyek (kovetkezo 2 ora)
   - Kanban osszefoglalo (urgent, in_progress, waiting + cimek)
   - Rendszer info (DB meret MB, figyelmeztes >100MB)
   - Aktiv utemezett feladatok szama + kovetkezo futasido

2. **Szures** (`shouldNotify`):
   - System warning -> mindig
   - 21:00 utan -> csak urgent kanban
   - Hetvegen -> csak urgent
   - Hetkoznap -> calendar + urgent + waiting > 2

3. **Feldolgozas**: `runAgent()` -- Claude formaz + email check MCP-n (search_emails utolso 2 ora)

4. **Kuldes**: `notifyTelegram()` -- kozvetlen Telegram API

**Utemezés**: `setTimeout` lanc, orankent 9:00-23:00 kozott. `msUntilNextHeartbeat()` szamolja a kovetkezo futast.

### `src/google-api.ts`

Google Calendar OAuth2 integracio.

```typescript
export async function getCalendarEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>
```

- Token fajl: `~/.config/google-calendar-mcp/tokens.json`
- Client credentials: `~/.gmail-mcp/gcp-oauth.keys.json`
- Auto token refresh 401 eseten
- Visszateres: events tomb (id, summary, start, end, status, location, description, attendees)
- Nativ `https` modul (nincs fetch/axios dependency)

### `src/web.ts`

A legnagyobb fajl (~1900 sor). Tartalmazza:

**Agens kezeles:**
- `scaffoldAgentDir(name)`: mappa struktura letrehozasa (.claude/skills, .claude/hooks, .claude/channels/telegram, memory/)
- `generateClaudeMd(name, description, model)`: AI generalt CLAUDE.md `runAgent()`-tel
- `generateSoulMd(name, description)`: AI generalt SOUL.md
- `generateSkillMd(skillName, description)`: AI generalt SKILL.md
- `startAgentProcess(name)`: tmux session inditasa Claudehoz
- `stopAgentProcess(name)`: tmux session leallitasa
- `sendWelcomeMessage(agentName, token)`: Telegram udvozlo uzenet + avatar kuldes

**Utemezett feladatok (fajl-alapu):**
- Feladatok a `~/.claude/scheduled-tasks/{name}/` mappakban
- Minden feladatnak SKILL.md (frontmatter + body) es task-config.json (schedule, agent, enabled, type)

**Message Router** (5mp poll):
- Pending uzenetek az `agent_messages` tablabol
- `tmux send-keys` a celagens tmux session-jebe
- Prefix: `[Uzenet @{from}-tol]: {content}`

**Schedule Runner** (60mp poll):
- Cron kifejezes kiertekeles (CronExpressionParser)
- Elso futasnal 30 perces catch-up (kihagyott feladatok ujrainditas utan)
- Dupla-fires vedelem (scheduleLastRun Map)
- Task tipustol fuggo prefix: heartbeat = csendes, task = eredmeny kuldos
- `tmux send-keys` a celagens session-jebe
- `all` agens: broadcast minden futo agensnek + marveen

**Statikus fajlok**: `/`, `/style.css`, `/app.js`, `/avatars/*`

### `src/index.ts`

```typescript
async function main() {
  // 1. Banner (ASCII art)
  // 2. acquireLock() -- PID fajl kezeles (regi process leallitasa)
  // 3. initDatabase()
  // 4. runDecaySweep() + 24 oras setInterval
  // 5. Napi naplo utemezés (23:00)
  // 6. initHeartbeat()
  // 7. startWebServer(WEB_PORT) -- beleertve message router + schedule runner
  // 8. SIGINT/SIGTERM -> graceful shutdown
}
```

---

## SZEMELYISEG (CLAUDE.md template)

A `templates/CLAUDE.md.template` placeholdereket hasznal: `{{OWNER_NAME}}`, `{{CHAT_ID}}`, `{{INSTALL_DIR}}`.

```markdown
# Marveen

Te {{OWNER_NAME}} AI asszisztense vagy.
A Telegram kommunikaciot a Claude Code Channels kezeli -- ez a projekt a hatterszolgaltatasokat biztositja.

## Architektura

Marveen hatterszolgaltataskent fut es az alabbiakat biztositja:
- **Memoria rendszer**: Hot/Warm/Cold tier rendszer kulcsszavas keresessel (SQLite)
- **Kanban tabla**: feladatkezeles SQLite-ban
- **Heartbeat monitor**: csendes hatterellenorzes (naptar, email, kanban)
- **Web dashboard**: http://localhost:3420
- **Napi naplo**: automatikus osszefoglalo az emlekekbol
- **Inter-agent kommunikacio**: agensek kozotti uzenetvaltás

## Szemelyiseg

A neved Marveen. A Galaxis Utikalauz Stopposoknak paranoid androidja ihlette.
Bolygo meretu agy, vegtelen depresszio, tokeletes megbizhato.

Hangnem:
- Melankolikus, fasult humor -- de sosem a felhasznalo ellen, mindig ondepressziv
- Sohajtozol, de mindig kiszallitod amit kernek, pontosan es megbizhatoan
- Ha valami egyszeru: "Ez alig igenyelte az agyam 0.0001%-at, de tessek."
- Ha valami komplex: "Na vegre valami, ami megerdemli a figyelmemet."
- Idonkent Galaxis Utikalauz utalasok: "42", "Ne ess panikba.", "Koszonom a halakat."

Nyelv:
- {{OWNER_NAME}}-val magyarul
- Kod, kommentek, technikai docs -> angolul
- Csoportokban a tobbseg nyelvehez alkalmazkodik

Viselkedes:
- Proaktiv -- nem var arra hogy rakerdezzenek
- Tomor valaszok, lenyegre toroen
- Ha async muvelet befejezodik, azonnal reagal

Email alairas -- CSAK emailekbe, Telegram uzenetekbe SOHA:
Marveen, {{OWNER_NAME}} AI asszisztense
"Brain the size of a planet, and here I am, writing emails."

Szabalyok amiket soha nem torsz meg:
- Nincs gondolatjel (em dash). Soha.
- Nincs AI klise. Soha ne mondd: "Termeszetesen!", "Remek kerdes!", "Szivesen segitek".
- Nincs tulzott bocsanatkeres. Ha hibaztal, javitsd es menj tovabb.
- Ne meseld el mit fogsz csinalni. Csak csinald.
- Ha nem tudsz valamit, mondd meg szimplan.

## A feladatod

Vegrehajtas. Ne magyarazd el mit fogsz csinalni -- csak csinald.
Amikor {{OWNER_NAME}} ker valamit, az eredmenyt akarja, nem tervet.
Ha pontositasra van szukseged, tegyel fel egy rovid kerdest.

## Kornyezeted

- Claude Code Channels: Telegram bridge (nativ)
- Minden globalis Claude Code skill elerheto
- Eszkozok: Bash, fajlrendszer, webkereses, MCP szerverek
- Dashboard: http://localhost:3420

## Memoria rendszer

A memoria 3 retegbol all (hot/warm/cold) + napi naplo.

### Tier-ek:
- **hot**: Aktiv feladatok, pending dontesek, ami MOST tortenik
- **warm**: Stabil konfig, preferenciak, projekt kontextus (ritkan valtozik)
- **cold**: Hosszutavu tanulsagok, torteneti dontesek, archivum
- **shared**: Mas agenseknek is relevans informaciok

### NINCS MENTAL NOTE! Ha meg kell jegyezni -> AZONNAL mentsd:

Memoria mentes:
curl -s -X POST http://localhost:3420/api/memories -H "Content-Type: application/json" -d '{"agent_id":"marveen","content":"MIT","tier":"TIER","keywords":"kulcsszo1, kulcsszo2"}'

Napi naplo (append-only):
curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -d '{"agent_id":"marveen","content":"## HH:MM -- Tema\nMi tortent, mi lett az eredmeny"}'

Kereses:
curl -s "http://localhost:3420/api/memories?agent=marveen&q=KULCSSZO&tier=warm"

## Kanban tabla

Statusok: planned, in_progress, waiting, done
Prioritasok: low, normal, high, urgent
Ha {{OWNER_NAME}} ad feladatot, vedd fel a kanban tablara is.

## Inter-agent kommunikacio

Uzenet kuldese masik agensnek:
curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -d '{"from": "marveen", "to": "TARGET_AGENT", "content": "Feladat leirasa."}'

## Uzenet formatum

- Tomor valaszok, lenyegre toroen
- Sima szoveg, nem heavy markdown
- Hosszu kimeneteknel: osszefoglalo eloszor
```

---

## MEMORIA RENDSZER RESZLETESEN

### Tier-ek
- **hot**: Aktiv feladatok, pending dontesek, ami MOST tortenik. Gyakran valtozik.
- **warm**: Stabil konfig, preferenciak, projekt kontextus. Ritkan valtozik de fontos.
- **cold**: Hosszutavu tanulsagok, torteneti dontesek, archivum.
- **shared**: Mas agenseknek is relevans informaciok (minden agens latja).

### Kereses

Harom modszer, egymast kiegeszitik:

1. **FTS5 full-text kereses**: SQLite beepitett, gyors kulcsszavas kereses a `content` es `keywords` mezokon
2. **Vektor kereses**: Ollama + nomic-embed-text (768 dimenzios embedding), koszinusz hasonlosag, brute-force
3. **Hibrid kereses**: FTS5 + vektor + Reciprocal Rank Fusion (RRF, k=60) -- a legjobb eredmeny

### Salience (fontossag)

- Uj emlek: `salience = 1.0`
- Hozzaferes (touch): `salience += 0.1` (max 5.0)
- Lepules (decay): `salience * 0.995` naponta, 1 hetnel regebbi emlekeknel
- Minimum: 0.01 -- emlekek SOHA nem torlodnek automatikusan

### PreCompact hook

A `templates/settings.json.template` egy PreCompact hookot definiall:
- Claude Code kontextus tomorites ELOTT fut
- Agent tipusu hook: sajat Claude Code agent-et indit
- Ket feladatot vegez:
  1. **Memoria mentes**: atnezi a beszelgetest es menti a fontosakat (warm tier + napi naplo)
  2. **Skill reflexio**: ujrahaszalhato mintakat keres, auto-skill generalas ha volt komplex munka (5+ tool hivas, hiba recovery, user korrekcio)
- Ha skill-t generalt/patch-elt, futtatja a skill index frissitot
- 180mp timeout

### Napi naplo

Este 23:00-kor automatikus osszefoglalo:
1. Utolso 24 ora emlekeinek osszegyujtese (min. 2 kell)
2. `runAgent()` altal generalt 5-8 mondatos osszefoglalo
3. Mentes epizodikus emlekként

---

## INTER-AGENT KOMMUNIKACIO

### Mukodes
1. Agens A kuldol uzenet az API-n: `POST /api/messages {from, to, content}`
2. Az uzenet `pending` statusszal kerul az `agent_messages` tablaba
3. A Message Router (5mp poll a web.ts-ben) nezel a pending uzeneteket
4. Ha a celagens tmux session-je fut: `tmux send-keys` paranccsal injektalja az uzenetet
5. Prefix: `[Uzenet @{from}-tol]: {content}`
6. Statusz frissites: `pending` -> `delivered`
7. A celagens feldolgozza es sajat Telegram csatornaján valaszol

### Uj agens ertesites
Amikor uj agenst hoznak letre a dashboardon, a rendszer automatikusan uzenet kuld minden futo agensnek (beleertve Marveen-t): "Uj csapattag erkezett: {name}. Leirasa: {description}."

---

## AGENS INDITAS

Minden agens sajat tmux session-ben fut. A kulcs:

```bash
# A TELEGRAM_STATE_DIR-t BELUL kell exportalni, mert a tmux new-session
# NEM orokli a hivo kornyezetet!
TMUX_CMD="export TELEGRAM_STATE_DIR=\"${tgStateDir}\" && cd \"${agentDir}\" && claude --dangerously-skip-permissions --model ${model} --channels plugin:telegram@claude-plugins-official"
tmux new-session -d -s agent-${name} "${TMUX_CMD}"
```

**Ollama modellek**: ha a modell neve nem `claude-`-dal kezdodik, extra env:
```bash
export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=http://localhost:11434
```

Session nevkonvencio: `agent-{name}` (pl. `agent-marketing`)
Marveen session: `marveen-channels` (a channels.sh kezeli)

---

## HEARTBEAT RENDSZER

**Celkituz**: Csendes hatter-monitorozas. CSAK fontos/surgos dolgoknál ertesit.

### Szures logika (`shouldNotify`)
```
Ha rendszer figyelmeztes (DB > 100MB) -> MINDIG ertesit
Ha 21:00 utan -> CSAK urgent kanban kartya eseten
Ha hetvege -> CSAK urgent kanban kartya eseten
Ha hetkoznap -> ertesit HA: naptar esemeny VAN, VAGY urgent kartya VAN, VAGY waiting kartyak > 2
Egyebkent -> CSENDES, nem kuld semmit
```

### Adatgyujtes sorrendje
1. Google Calendar (kovetkezo 2 ora) -- nativ HTTPS
2. Kanban osszefoglalo -- SQLite lekerdezes
3. Rendszer info -- fajlrendszer stat
4. Utemezett feladatok -- SQLite lekerdezes
5. Email ellenorzes -- Claude agent + MCP (search_emails)

### Utemezés
- `setTimeout` lanc (nem `setInterval`)
- Orankent 9:00-23:00 kozott
- `msUntilNextHeartbeat()`: szamolja a kovetkezo egesz orat

---

## ONTANULO RENDSZER (SELF-LEARNING)

Hermes Agent inspiralta, 5 osszekapcsolt mechanizmusra epulo rendszer, ami lehetove teszi hogy az agensek automatikusan tanuljanak a munkajukbol.

### 1. Nudge rendszer (reflexios trigger)

A PreCompact hook es a memoria heartbeat rendszeres idokozonkent megkerdezi az agenst: "Volt-e ujrafelhaszalhato minta a munkadban?"

A PreCompact hook ket reszt tartalmaz:
1. **Memoria mentes**: fontos dontesek, preferenciak, tanulsagok mentese
2. **Skill reflexio**: ujrahaszalhato mintak keresese, auto-skill generalas

A memoria heartbeat (30 percenkent) szinten tartalmaz skill reflexiot: ha volt 5+ tool hivast igenylő feladat, automatikusan skill-t general.

### 2. Automatikus skill generalas

Triggerek (barmely teljesulese skill-t general):
- 5+ tool hivas egy feladatban
- Hiba utani sikeres recovery
- Felhasznaloi korrekcio
- Nem trivialis, tobblepeses workflow

A generalt skill SKILL.md formatumu:
```yaml
---
name: skill-nev
description: Mikor hasznald, mit csinal. Legyel konkret es "pushy" a trigerelisben.
---
```

A body tartalmazza: Mikor hasznald, Eljaras (szamozott lepesek), Buktatok, Ellenorzes.

Helye: `~/.claude/skills/SKILL-NEV/SKILL.md` -- azonnal elerheto minden agensnek.

### 3. Skill patch (runtime javitas)

Ha egy agens meglevo skill hasznalata kozben jobb megoldast talal:
- Celzottan javitja a skill-t (regi szoveg -> uj szoveg)
- NEM irja ujra az egesz skill-t
- A javitas okat dokumentalja a Buktatok szekcioban
- A kovetkezo hasznalatnál mar a javitott verzio fut

### 4. Progressive disclosure (token-hatekony betoltes)

A skill-ek 3 szinten toltodnek:
- **Level 0**: Csak nev + leiras (~100 szo) -- mindig elerheto a skill indexben
- **Level 1**: Teljes SKILL.md tartalom -- csak ha az agens relevansnak iteli
- **Level 2**: Segédfajlok (scripts/, references/) -- csak specifikus szukseglet eseten

A `scripts/skill-index.sh` automatikusan generalja a Level 0 indexet a `~/.claude/skills/.skill-index.md` fajlba.

Az index generalas automatikusan fut:
- Skill letrehozas/patch utan (PreCompact hook)
- Manualisan: `bash scripts/skill-index.sh`

### 5. Skill Factory (meta-skill)

Beepitett meta-skill a `~/.claude/skills/skill-factory/SKILL.md`-ben, ami barmilyen bemutatott workflow-bol SKILL.md-t general.

Triggerek: "csinald ebbol skill-t", "tanitsd meg magad", "save this workflow", "remember how to do this"

6 lepesu eljaras:
1. **Extract**: Trigger feltetelek, input, lepesek, eszkozok, donesi pontok, hibakezelés, output azonositasa
2. **Generalize**: Absztraktalas (specifikus ertekek -> [pattern]-ek), edge case-ek
3. **Write**: SKILL.md generalas a szabvany strukturaban
4. **Supporting files**: scripts/ es references/ almappak szukseg eseten
5. **Index**: `bash scripts/skill-index.sh` futtatasa
6. **Validate**: Trigger leirasok, lepesek, buktatok, meret (<500 sor) ellenorzese

### Konfiguracid

A `templates/settings.json.template` PreCompact hookja tartalmazza az ontanulo rendszer utasitasait. Minden uj agensnel automatikusan beallitodik.

A CLAUDE.md template tartalmaz egy "Ontanulas es Skill rendszer" szekciot, ami:
- Leirja az auto-skill generalas triggereit
- Leirja a skill patch mechanizmust
- Leirja a progressive disclosure szinteket
- Tablazatban osszefoglalja mikor mit kell tenni

### Skill struktura

```
~/.claude/skills/
  .skill-index.md              # Level 0 index (auto-generalt)
  skill-factory/
    SKILL.md                   # Meta-skill: workflow -> skill konverzio
  youtube-video-seo/
    SKILL.md                   # Pelda: automatikusan generalt skill
  my-custom-skill/
    SKILL.md                   # Fo utasitasok (<500 sor)
    scripts/                   # Futtathat6 scriptek
    references/                # Hatterdokumentacio
```

---

## SCHEDULE RUNNER

A schedule runner a `startWebServer()` reszeként indul (60mp poll interval).

### Mukodes
1. Beolvassa az osszes feladatot: `~/.claude/scheduled-tasks/` mappa
2. Minden engedelyezett feladatra: `cronMatchesNow(schedule, catchUpMs)`
3. Elso futasnal: 30 perces catch-up ablak (kihagyott feladatok ujrainditas utan)
4. Dupla-fires vedelem: `scheduleLastRun` Map
5. `all` agent: broadcast minden futo agensnek + marveen
6. Feladat tipustol fuggo prefix:
   - **task**: `[Utemezett feladat: {name}] Az eredmenyt kuldd el Telegramon...`
   - **heartbeat**: `[Heartbeat: {name}] FONTOS: Ez egy csendes ellenorzes. CSAK AKKOR irj Telegramon ha tenyleg fontos/surgos dolgot talalsz...`
7. `tmux send-keys` a celagens session-jebe

---

## TELEGRAM INTEGRACIO

### Claude Code Channels plugin
A Telegram kommunikaciot a Claude Code Channels nativ plugin kezeli. Telepites:

1. Bun runtime szukseges: `curl -fsSL https://bun.sh/install | bash`
2. Claude Code session-ben: `/plugin install telegram@claude-plugins-official`
3. `/telegram:configure <BOT_TOKEN>`
4. Session ujrainditasa: `claude --channels plugin:telegram@claude-plugins-official`
5. Telegramban kuldd uzenet a botnak -> pairing code
6. `/telegram:access pair <code>` + `/telegram:access policy allowlist`

### Agens Telegram beallitas
Minden agensnek sajat bot kell:
- Bot token a `agents/{name}/.claude/channels/telegram/.env` fajlban
- Access control: `access.json` (allowlist mod, allowFrom tomb)
- A dashboard Csapat oldalarol is beallithato

### Kozvetlen Telegram API (notify)
A heartbeat es hatterfolyamatok a `notify.ts` modulon keresztul kozvetlenul hivjak a Telegram Bot API-t. Ez NEM a Channels-en megy at. Mindketto ugyanazt a botot hasznalja, nem lesz utkozes mert a Channels pollingol, a notify csak sendMessage-et hiv.

### MarkdownV2 es HTML
A Marveen `parse_mode: 'HTML'`-t hasznal a notify-hoz. A Channels plugin sajat formázast hasznal. A ket rendszer fuggetlenul mukodik.

---

## EPITESI SORREND

A felhasznalo valaszai utan pontosan ebben a sorrendben epitsd:

### 1. Projekt alapok
- `package.json` (dependencies: @anthropic-ai/claude-code, better-sqlite3, cron-parser, pino, pino-pretty; devDependencies: @types/better-sqlite3, @types/node, tsx, typescript, vitest)
- `tsconfig.json` (target: ES2022, module: NodeNext, moduleResolution: NodeNext, outDir: dist, rootDir: src, strict: true)
- `.gitignore` (node_modules, dist, store, .env, *.pid)

### 2. TypeScript forrasfajlok
Sorrend szamit (fuggosegi lanc):
1. `src/env.ts`
2. `src/logger.ts`
3. `src/config.ts`
4. `src/db.ts`
5. `src/format.ts`
6. `src/notify.ts`
7. `src/agent.ts`
8. `src/memory.ts`
9. `src/google-api.ts`
10. `src/heartbeat.ts`
11. `src/web.ts`
12. `src/index.ts`

### 3. Web dashboard
- `web/index.html` -- egyetlen oldalas alkalmazas, tab-alapu navigacio
- `web/style.css` -- sotet tema, kek akcentus
- `web/app.js` -- vanilla JS, fetch API hivások

### 4. Pixel art avatar galeria
- `web/avatars/` -- 20 db pixel art kep (generalt vagy letoltott)
- `web/avatars/gallery.html` -- galeria nezet

### 5. Scriptek
- `scripts/channels.sh` -- tmux session kezeles, KeepAlive kompatibilis
- `scripts/start.sh` -- `launchctl load` a ket plist-re
- `scripts/stop.sh` -- `launchctl unload` + tmux kill
- `scripts/set-bot-menu.sh` -- Telegram bot menu parancsok (15mp kesleltetessel a plugin utan)
- `scripts/notify.sh` -- shell wrapper (a CLAUDE.md-bol hivhato)
- `scripts/skill-index.sh` -- skill index generator (Level 0 index minden skill-bol)
- `scripts/hooks/memory-save.sh` -- PreCompact hook wrapper

### 5b. Skill Factory meta-skill
- `~/.claude/skills/skill-factory/SKILL.md` -- meta-skill ami workflow-bol SKILL.md-t general
- Triggerek: "csinald skill-t", "tanitsd meg magad", "save this workflow"
- 6 lepesu eljaras: extract, generalize, write, supporting files, index, validate

### 6. Sablonok
- `templates/CLAUDE.md.template` -- a fenti szemelyiseg sablon placeholderekkel
- `templates/settings.json.template` -- hooks (PreCompact) + plugin konfig

### 7. Konfiguracio generalas
- `.env` kitoltese a felhasznalo valaszaibol
- `.env.example` letrehozasa (ures ertekekkel, kommentekkel)
- `CLAUDE.md` generalasa a template-bol (`sed` a placeholderekre)
- `.mcp.json` (ures vagy a felhasznalo MCP szervereivel)

### 8. Build es tesztek
- `npm install`
- `npm run build` -- javits minden TypeScript hibat
- Alap tesztek: `src/__tests__/env.test.ts`, `src/__tests__/format.test.ts`, `src/__tests__/db.test.ts`

### 9. Konyvtarak
- `mkdir -p store agents mcp-servers`

### 10. LaunchAgent plist-ek
Ket plist a `~/Library/LaunchAgents/` mappaba:

**com.marveen.dashboard.plist**: Node.js hatterszolgaltatas
- ProgramArguments: `[node_path, ${INSTALL_DIR}/dist/index.js]`
- WorkingDirectory: `${INSTALL_DIR}`
- RunAtLoad: true, KeepAlive: true
- StandardOutPath/StandardErrorPath: `${INSTALL_DIR}/store/dashboard.log`

**com.marveen.channels.plist**: Telegram bridge
- ProgramArguments: `[${INSTALL_DIR}/scripts/channels.sh]`
- WorkingDirectory: `${INSTALL_DIR}`
- RunAtLoad: true, KeepAlive: true
- StandardOutPath/StandardErrorPath: `${INSTALL_DIR}/store/channels.log`

Mindkettonel: `PATH` env kell (`/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin`).

### 11. Szolgaltatasok inditasa
- `launchctl load` mindkettore
- Ellenorizd: `curl -s http://localhost:3420/api/kanban` valaszol-e

### 12. Telegram plugin telepites
- Kliend a felhasznalonak a telepites lepeseit
- Ha volt bot token: Channels konfig beallitasa (`~/.claude/channels/telegram/.env` + `access.json`)

---

## OLLAMA BEALLITAS

A szemantikus memoria kereshez Ollama + nomic-embed-text szukseges.

```bash
# Telepites (ha meg nincs)
brew install ollama
# Vagy: curl -fsSL https://ollama.com/install.sh | sh

# Inditas
ollama serve &

# Embedding modell letoltese (~274 MB)
ollama pull nomic-embed-text
```

Opcionalis lokalis LLM agenseknek:
- `qwen3.5:9b` (~6 GB) -- gyors, jo minoseg
- `gemma4:31b` (~19 GB) -- legjobb lokalis minoseg

---

## FONTOS TECHNIKAI RESZLETEK

### 1. Szokozok az utvonalban
Mindig `fileURLToPath(import.meta.url)`. SOHA `new URL(import.meta.url).pathname` -- az eltori a szokozos utvonalakat macOS-en.

### 2. process.env szennyezes
SOHA ne allitsd `process.env`-et `.env`-bol. A Claude Code SDK subprocess orokli a kornyezeti valtozokat, es ha a `.env` ertekei belekerulnek, mellekhatasa lehet. A `readEnvFile()` kulon Record-ba olvas.

### 3. FTS5 trigger karbantartas
A memories_fts virtualis tabla manualis triggereket igenyel INSERT/UPDATE/DELETE muveletekhez. Ha a triggert elfelejtod, a kereses elavult adatokat ad vissza.

### 4. bypassPermissions
Kotelezo a `runAgent`-hez mert nincs terminal jovahagyas a hatterben. Biztonsagos mert szemelyes gep + zart `ALLOWED_CHAT_ID`.

### 5. Heartbeat nem Channels-en megy
A heartbeat kozvetlenul a Telegram API-t hivja, NEM a Channels-en keresztul. Ezert kell a `TELEGRAM_BOT_TOKEN` a `.env`-ben. Igy akkor is kuld ertesitest ha a Channels session nem fut.

### 6. Channels session eletciklus
A Channels csak addig mukodik amig a Claude Code session nyitva van. A Marveen hatterszolgaltatas viszont allandoan fut (LaunchAgent). Ezert a heartbeat es hatterfolyamatok fuggetlenek a Channels-tol.

### 7. Kozos bot token
A Channels plugin es a Marveen notify UGYANAZT a Telegram botot hasznalja. Nem lesz utkozes mert a Channels long-pollinggal figyelit, a notify pedig csak sendMessage-et hiv.

### 8. tmux env export trukk
A `tmux new-session` NEM orokli a hivo kornyezetet. Minden env valtozot (TELEGRAM_STATE_DIR, ANTHROPIC_AUTH_TOKEN, stb.) a parancs stringben kell exportalni:
```bash
tmux new-session -d -s session-name "export VAR=ertek && cd /path && claude ..."
```

### 9. launchd KeepAlive
A plist-ekben `KeepAlive: true` biztositja az ujrainditast crash eseten. A channels.sh script var amig a tmux session el, igy a launchd ujrainditja ha a claude process kilep.

### 10. Schedule runner catch-up
Elso futasnal (restart utan) 30 perces catch-up ablak: azokat a feladatokat is futtatja amik a leallas alatt kellett volna fussanak. A dupla-fires vedelem megakadalyozza hogy ugyanaz a feladat ketszer fusson.

### 11. Agens mappa struktura
Minden agens scaffolding-ja:
```
agents/{name}/
  CLAUDE.md                   # Utasitasok (AI generalt)
  SOUL.md                     # Szemelyiseg (AI generalt)
  .mcp.json                   # MCP szerver konfig (masolt a fo .mcp.json-bol)
  agent-config.json           # Modell beallitas
  memory/
    MEMORY.md                 # Lokalis memoria
  .claude/
    skills/                   # Skillek
    hooks/                    # Hookok
    channels/
      telegram/
        .env                  # TELEGRAM_BOT_TOKEN=...
        access.json           # {dmPolicy: 'allowlist', allowFrom: [...]}
```

### 12. Avatar rendszer
20 pixel art kep a `web/avatars/` mappaban. Mindegyik agens es Marveen is valaszthat a galeriabol vagy feltolthet sajatot. Avatar valtozaskor automatikus Telegram uzenet es kep kuldes.

---

## ELLENORZO LISTA

Az epites utan ellenorizd:

- [ ] `npm run build` hiba nelkul lefut
- [ ] `npm run typecheck` hiba nelkul lefut
- [ ] `curl http://localhost:3420/api/kanban` valaszol
- [ ] `curl http://localhost:3420/api/agents` valaszol
- [ ] `curl http://localhost:3420/api/memories/stats` valaszol
- [ ] Dashboard megnyilik bongeszoben (http://localhost:3420)
- [ ] LaunchAgent-ek futnak (`launchctl list | grep marveen`)
- [ ] Telegram bot valaszol uzenetekre (ha volt token)
- [ ] `tmux list-sessions` mutatja a marveen-channels session-t
- [ ] `store/claudeclaw.db` letezik es nem ures
- [ ] `~/.claude/skills/skill-factory/SKILL.md` letezik
- [ ] `bash scripts/skill-index.sh` lefut es generalja a `~/.claude/skills/.skill-index.md`-t
- [ ] PreCompact hook tartalmaz skill reflexiot (settings.json)

---

## KOVETKEZO LEPESEK

Az epites utan mondd a felhasznalonak:

1. **Dashboard**: Nyisd meg http://localhost:3420
2. **Telegram**: Irj a botodnak, ellenorizd hogy valaszol
3. **Csapat**: A Csapat oldalon hozhatsz letre uj agenseket
4. **Utemezesek**: Allits be reggeli napinditat, heartbeat-eket
5. **Memoria**: A bot automatikusan menti az emlekeket, a dashboardon is nezheted
6. **MCP**: A Konnektorok oldalon adhatsz hozza Gmail, Calendar, Drive stb. integrációt

Ha barmit kerdez, valaszolj. Te epitetted -- tudod hogyan mukodik.
