# Marveen

![Marveen Banner](banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5+Vector-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Anthropic-D97757?logo=anthropic&logoColor=white)](https://claude.ai/code)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed-000000?logo=ollama&logoColor=white)](https://ollama.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![GitHub stars](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)

> AI csapatod, ami fut amíg te alszol.

Marveen egy AI asszisztens keretrendszer, ami Claude Code-ra épül. Saját AI csapatot építhetsz, akik Telegramon kommunikálnak veled, önállóan dolgoznak, és egymással is együttműködnek.

## Funkciók

- **AI Csapat**: Több ágens, mindegyik saját Telegram bottal, személyiséggel és memóriával
- **Mission Control**: Web dashboard (http://localhost:3420) a csapat kezeléséhez
- **Inter-agent kommunikáció**: Az ágensek delegálhatnak egymásnak feladatokat
- **Ütemezések**: Cron-alapú feladatok automatikus futtatása
- **Heartbeat**: Csendes háttér-monitorozás, csak fontosnál szól (naptár, email, kanban)
- **Memória**: Hot/Warm/Cold tier rendszer, hibrid kereséssel (FTS5 + vektor) és gráf nézettel
- **MCP Connectorok**: Gmail, Calendar, Drive, Notion, Slack és más szolgáltatások
- **Skillek**: Újrahasználható képességek az ágenseknek
- **Öntanulás**: Az ágensek automatikusan tanulnak a munkájukból és skill-eket hoznak létre

## Öntanulás (Self-Learning)

A Marveen ágensek automatikusan tanulnak a munkájukból -- a Hermes Agent rendszeréből inspirálódva.

### Hogyan működik?

Az öntanulás 5 összekapcsolt mechanizmusra épül:

#### 1. Nudge rendszer (reflexiós trigger)
- A `PreCompact` hook minden kontextus-tömörítés előtt megkérdezi az ágenst: "Volt-e újrafelhasználható minta a munkádban?"
- A 30 perces memória heartbeat szintén tartalmaz skill reflexiót
- Az ágens saját ítélete alapján dönt, hogy mit ment el

#### 2. Automatikus skill generálás
Komplex feladatok után az ágensek automatikusan SKILL.md fájlokat hoznak létre. Triggerek:
- 5+ tool hívás egy feladatban
- Hiba utáni sikeres recovery
- Felhasználói korrekció
- Nem triviális, többlépéses workflow

A generált skill-ek a `~/.claude/skills/` mappába kerülnek és azonnal elérhetőek.

#### 3. Skill patch (runtime javítás)
Ha egy ágens meglévő skill használata közben jobb megoldást talál:
- Célzottan javítja a skill-t (nem írja újra az egészet)
- A javítás okát dokumentálja a "Buktatók" szekcióban
- A következő használatnál már a javított verzió fut

#### 4. Progressive disclosure (token-hatékony betöltés)
A skill-ek 3 szinten töltődnek be:
- **Level 0**: Csak név + leírás (~100 szó) -- mindig elérhető a skill indexben
- **Level 1**: Teljes SKILL.md tartalom -- csak ha az ágens relevánsnak ítéli
- **Level 2**: Segédfájlok (scripts/, references/) -- csak specifikus szükséglet esetén

A `scripts/skill-index.sh` automatikusan generálja a Level 0 indexet.

#### 5. Skill Factory (meta-skill)
Beépített meta-skill ami bármilyen bemutatott workflow-ból SKILL.md-t generál:
- "Csinálj ebből skill-t" / "Tanítsd meg magad"
- 6 lépéses eljárás: extract → generalize → write → supporting files → index → validate

### Skill struktúra

```
~/.claude/skills/
├── .skill-index.md          # Level 0 index (auto-generált)
├── skill-factory/
│   └── SKILL.md             # Meta-skill: workflow → skill konverzió
├── youtube-video-seo/
│   └── SKILL.md             # Példa: automatikusan generált skill
└── my-custom-skill/
    ├── SKILL.md             # Fő utasítások (<500 sor)
    ├── scripts/             # Futtatható scriptek
    └── references/          # Háttérdokumentáció
```

### Konfiguráció

Az öntanulás a `settings.json` `PreCompact` hookján keresztül működik. A `templates/settings.json.template` tartalmazza az alapértelmezett konfigurációt, ami minden új ágensnél automatikusan beállítódik.

## Memória rendszer

Minden ágens saját memóriával rendelkezik, amit egy hibrid keresőrendszer tesz hatékonnyá. A memóriák SQLite adatbázisban élnek, három keresési réteggel.

### Tier-ek (Hot / Warm / Cold)

A memória 4 szintre tagolódik, a tartalom jellegétől függően:

| Tier | Mikor használjuk | Példa |
|------|------------------|-------|
| **hot** | Aktív feladatok, pending döntések | "Szabi kérte a piackutatást, folyamatban" |
| **warm** | Stabil konfig, preferenciák, projekt kontextus | "Szabi tömör válaszokat szeret, nem kér bevezetőt" |
| **cold** | Hosszútávú tanulságok, történeti döntések | "A Redis cache TTL 5 percre optimális volt az /api/users-nél" |
| **shared** | Más ágenseknek is releváns információk | "Az aiamindennapokban.hu API kulcs a .env-ben van" |

Az ágensek automatikusan döntik el, hogy egy információ melyik tierbe kerüljön:
- Feladat kész → törlés hot-ból, napi naplóba írás
- User preferencia → warm
- Tanulság, döntés → cold
- Több ágensnek is kell → shared

### Hibrid keresés (FTS5 + Vektor + RRF)

A memória keresés két párhuzamos csatornán fut, majd az eredményeket fúzionálja:

```
Keresési lekérdezés
    ├── FTS5 Full-Text Search (kulcsszó alapú, SQLite natív)
    │   └── Pontos szóegyezés, gyors, megbízható
    │
    ├── Vektor keresés (szemantikus, Ollama + nomic-embed-text)
    │   └── 768 dimenziós embedding, cosine similarity
    │   └── Megérti a jelentést, nem csak a szavakat
    │
    └── Reciprocal Rank Fusion (RRF, k=60)
        └── A két lista összefésülése egy relevancia score-ral
```

**FTS5** (Full-Text Search): SQLite beépített full-text keresője. Gyors, pontos szóegyezésen alapul. Jól működik ha a felhasználó pontosan tudja mit keres.

**Vektor keresés**: Minden memória mentéskor automatikusan kap egy 768 dimenziós embedding-et az Ollama `nomic-embed-text` modelljétől. A keresés cosine similarity-vel rangsorol. Megtalálja a szemantikailag hasonló tartalmakat akkor is, ha más szavakat használ.

**RRF (Reciprocal Rank Fusion)**: A két keresési eredménylista összefésülése. Képlet: `score(d) = Σ 1/(k + rank)` ahol k=60. Az RRF előnye, hogy nem kell a két rendszer pontszámait normalizálni -- csak a rangsor számít.

### Salience Decay (relevancia csökkenés)

A memóriák frissessége idővel csökken:
- **Első 7 nap**: nincs decay, a memória teljes relevanciával bír
- **7 nap után**: 0.5%/nap csökkenés (`salience * 0.995`)
- **Minimum**: 0.01 -- a memória soha nem törlődik, csak háttérbe kerül
- **Hozzáféréskor**: +0.1 salience boost (max 5.0) -- amit gyakran keresnek, az releváns marad

Ez a "gentle decay" megközelítés biztosítja, hogy a régi memóriák ne zavarják a keresést, de szükség esetén mindig visszakereshetőek legyenek.

### Napi napló (Daily Log)

Minden ágens append-only napi naplót vezet:
- Automatikus bejegyzések a nap folyamán (feladat befejezés, döntések)
- 23:00-kor automatikus napi összefoglaló generálás
- A napló nem törlődik és nem módosul -- kronológiai archívum

### Memória API

Az ágensek REST API-n keresztül kezelik a memóriáikat:

```bash
# Mentés
curl -s -X POST http://localhost:3420/api/memories \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"marveen","content":"...","tier":"warm","keywords":"kulcsszó1, kulcsszó2"}'

# Keresés (kulcsszó)
curl -s "http://localhost:3420/api/memories?agent=marveen&q=KULCSSZO&tier=warm"

# Hibrid keresés (FTS5 + vektor)
curl -s "http://localhost:3420/api/memories/search?agent=marveen&q=KERDES&hybrid=true"

# Napi napló
curl -s -X POST http://localhost:3420/api/daily-log \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"marveen","content":"## 14:30 -- Téma\nMi történt"}'
```

### PreCompact Hook (automatikus mentés)

Mielőtt a Claude Code kontextusablaka tömörítődik, a `PreCompact` hook automatikusan:
1. Átnézi az eddigi beszélgetést
2. Kiemeli a fontos döntéseket, preferenciákat, tanulságokat
3. Elmenti a megfelelő tierbe
4. Napi napló bejegyzést ír

Ez biztosítja, hogy a kontextus-tömörítés során semmi fontos ne vesszen el.

### Gráf nézet

A dashboard memória oldalán Obsidian-stílusú gráf vizualizáció érhető el:
- Force-directed layout HTML5 Canvas-szal
- Zoom/pan, keresés highlight
- Kattintásra kibontható memória panel
- A gráf a kulcsszó kapcsolatokat jeleníti meg ágensek között

### Embedding backfill

Régi memóriák (amik még embedding nélkül lettek mentve) automatikusan kapnak vektort:

```bash
# Manuális backfill (induláskor is automatikusan fut)
curl -s -X POST http://localhost:3420/api/memories/backfill
```

### Konfiguráció

A memória rendszer zero-config: az SQLite adatbázis automatikusan létrejön, az Ollama embedding automatikusan generálódik mentéskor. Az egyetlen opcionális függőség az Ollama + `nomic-embed-text` modell a szemantikus kereséshez -- enélkül is működik, csak FTS5-tel.

## Telepítés

### macOS / Linux

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

### Windows (WSL)

```powershell
irm https://raw.githubusercontent.com/Szotasz/marveen/main/install-windows.ps1 | iex
```

Vagy manuálisan:
```powershell
git clone https://github.com/Szotasz/marveen.git
cd marveen
.\install-windows.ps1
```

A Windows telepítő automatikusan beállítja a WSL-t (Windows Subsystem for Linux) és azon belül telepíti a Marveen-t.

A telepítő végigvezet a beállításokon:
1. Függőségek ellenőrzése és telepítése
2. Claude Code bejelentkezés
3. Telegram bot létrehozása
4. Személyes beállítások
5. Szolgáltatások indítása

## Használat

### Dashboard
Nyisd meg: http://localhost:3420

### Telegram
Írj a botodnak Telegramon -- Marveen válaszol.

### Ágensek
A Csapat oldalon hozz létre új ágenseket. Mindegyik:
- Saját Telegram bot
- Saját személyiség (SOUL.md)
- Saját utasítások (CLAUDE.md)
- Saját memória és skillek

### Ütemezések
Időzített feladatok és heartbeat monitorok beállítása:
- Lista, napi idővonal és heti nézet
- Feladat: mindig szól az eredménnyel
- Heartbeat: csendes ellenőrzés, csak fontosnál értesít

### Vault & Titkosítás

Az MCP szerverek API kulcsait, tokenjeit és jelszavait a Vault kezeli. A titkok AES-256-GCM titkosítással vannak tárolva, a master key macOS-en a Keychain-ben él (egyéb platformon fájl-alapú fallback).

**Miért Vault?** A Claude Code `.mcp.json` fájljai alapértelmezetten plaintext-ben tárolják az API kulcsokat és tokeneket. Ez biztonsági kockázat: a fájlok olvashatóak bármely process által, prompt injection támadással kiolvashatóak, és git-be is véletlenül bekerülhetnek. A Vault ezt úgy oldja meg, hogy a `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak, a tényleges értékek titkosítva vannak, és csak induláskor, memóriában oldódnak fel.

**Master key tárolás:**
- **macOS**: A vault master key a macOS Keychain-ben van tárolva (`com.marveen.vault` service). A Keychain az operációs rendszer titkosított kulcstárolója -- a disk encryption részeként védett, és a felhasználói bejelentkezéshez kötött. Nem kér külön jelszót, transzparens. Ha korábban fájl-alapú kulcs volt használatban (`.vault-key`), az első induláskor automatikusan migrálódik a Keychain-be.
- **Linux**: A Keychain nem elérhető, ezért a master key fájl-alapú (`store/.vault-key`, `chmod 600`). A titkosítás továbbra is AES-256-GCM, de a master key védelme az OS fájljogosultságokra és disk encryption-re hárul. Éles környezetben érdemes LUKS vagy hasonló disk-level titkosítást használni.

**Működés:**
- A dashboard Vault oldalán hozhatod létre és kezelheted a titkokat
- A **Scan & Import** gomb megkeresi a `.mcp.json` fájlokban lévő plaintext titkokat és felajánlja az importálást
- Importálás után a `.mcp.json`-ben `vault:SECRET_ID` referencia áll a plaintext helyett
- Az MCP szerver parancs automatikusan becsomagolódik a `vault-env-wrapper.sh` scripttel, ami induláskor feloldja a referenciákat

**Mit érzékel a scanner:**
- Csak a `.mcp.json` fájlok `env` szekciójában lévő érzékeny kulcsokat (`_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PASS`, `PASSWORD`, `CREDENTIAL`, `ACCESS_KEY`, `API_*`, `AUTH_*`, `OAUTH_*`)
- Az `args`-ban átadott titkokat (pl. `--api-key`) nem érzékeli -- ezeket manuálisan kell env var-ra átállítani

**Vault struktúra:**
```
store/vault.json          # Titkosított titkok (AES-256-GCM)
store/vault-bindings.json # Titok ↔ MCP szerver hozzárendelések
scripts/vault-env-wrapper.sh  # Runtime feloldó wrapper
scripts/vault-resolve.mjs     # Secret ID → plaintext feloldás
```

### Ágens monitorozás

A `monitor_agents.sh` script összefogja az összes futó ágens tmux session-jét egyetlen `monitor` session-be, iTerm2 Control Mode-dal (`-CC`) minden ágens külön iTerm tab-ként jelenik meg.

```bash
# Lokálisan (a gépen ahol az ágensek futnak):
./scripts/monitor_agents.sh

# Távolról (laptopról SSH-n, iTerm2-vel):
ssh macmini -t "~/marveen/scripts/monitor_agents.sh"

# Ha új ágens indult és nem látod a monitorban -- kill + újraindítás:
ssh macmini "/opt/homebrew/bin/tmux kill-session -t monitor" && \
  ssh macmini -t "~/marveen/scripts/monitor_agents.sh"
```

A script automatikusan felderíti a futó `agent-*` és `marveen-channels` session-öket. A monitor session törlése nem érinti az ágens session-öket -- csak a linked-window referenciákat szünteti meg.

### Frissítés
```bash
./update.sh
```

### Leállítás / Indítás
```bash
./scripts/stop.sh
./scripts/start.sh
```

### VPS telepítés (szerver)

Linux VPS-en (Ubuntu/Debian) az `install.sh` változtatás nélkül fut. Az egyetlen különbség: a bejelentkezéshez token kell, mert nincs böngésző.

```bash
# 1. A SAJÁT gépeden (ahol van böngésző):
claude setup-token
# Másold ki a generált tokent (sk-ant-oat01-...)

# 2. A VPS-en:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

A token 1 évig érvényes. Ne állíts be `ANTHROPIC_API_KEY`-t mellé.

## Követelmények

- macOS, Linux, vagy Windows 10/11 (WSL-lel)
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés szükséges)
- Telegram fiók

## Közösség és támogatás

Kérdésed van? Csatlakozz az AI a mindennapokban közösséghez:

- **Skool közösség**: [skool.com/ai-a-mindennapokban](https://skool.com/ai-a-mindennapokban) -- oktatóanyagok, kérdések, tapasztalatcsere
- **YouTube**: [AI a mindennapokban](https://www.youtube.com/@aiamindennapokban) -- videók, tutorialok
- **Weboldal**: [aiamindennapokban.hu](https://aiamindennapokban.hu)

## Támogasd a projektet

Ha hasznos számodra a Marveen, támogasd a fejlesztést:

[![Támogatás](https://img.shields.io/badge/Támogatás-Donably-orange)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

## Készítette

**Szota Szabolcs** -- AI konzultáns, az "AI a mindennapokban" csatorna készítője

[![GitHub](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)
