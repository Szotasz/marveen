# Marveen

![Marveen Banner](banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5+Vector-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Anthropic-D97757?logo=anthropic&logoColor=white)](https://claude.ai/code)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed-000000?logo=ollama&logoColor=white)](https://ollama.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Slack](https://img.shields.io/badge/Slack-Socket_Mode-4A154B?logo=slack&logoColor=white)](https://api.slack.com/)
[![GitHub stars](https://img.shields.io/github/stars/cett/marveen?style=social)](https://github.com/Szotasz/marveen)

> AI csapatod, ami fut amíg te alszol.

> **Fork.** Ez a repó a [Szotasz/marveen](https://github.com/Szotasz/marveen) önálló forkja, amely `fork-point` (2026-07-26, baseline: upstream `55ecbc6`) óta függetlenül fejlődik. Az upstream javításokat szelektíven vesszük át (`git fetch upstream` + cherry-pick). Hozzájárulásokat ehhez a forkhoz várunk PR-ként. Az AI által generált monolitikus kódot felhagyva, modularizált verzió alkotása a célom, amelyben nagyságrendekkel kisebb tokenhasználatot emészt fel magának a keretrendszernek a használata.

## A cett hozzájárulásai az eredeti Marveen repóhoz

A [Szotasz/marveen](https://github.com/Szotasz/marveen) upstream repóba Jónás Gergő (cett) 56 commitot küldött be. Az alábbiakban funkcionális csoportosításban:

- **Elosztott nyomkövetés** -- OpenTelemetry trace-waterfall az inter-agent üzenetekhez: teljes kérés-lánc követhetővé válik a dashboardon (#705)
- **Prompt-injection védelem** -- quarantine sub-ágens, egress-gate, from-auth azonosítás, content-nonce; a fleet automatikusan elkülöníti az ismeretlen forrásból érkező utasításokat (#633)
- **HITL (human-in-the-loop) jóváhagyás** -- jóváhagyási primitív autonóm műveletekhez (#644), autonómia-szint beállítások per-kategória (#627)
- **Skills rendszer** -- Skills-oldal újratervezés, ágens-lokális skillek megjelenítése, `skill_usage` követési tábla PostToolUse hook-kal, per-ágens merged skill-index (#604, #649, #607, #643)
- **Dashboard -- Agents & Team** -- Agents és Team képernyők egyesítése egyetlen nézetté view toggle-lal (#669); központi Beállítások-felület v2 config-registry + override API-val (#393, #398); Napló/audit-log oldal konfig-változások, idea-státusz, eseménynapló (#400); HU/EN nyelvváltó teljes UI-lokalizációval (#419)
- **Kanban bővítések** -- Gantt/timeline nézet határidős kártyákhoz (#497); címkék és szűrők (#392); archivált kártyák dedikált nézet visszaállítással (#406); swimlane-nézet (#389); oszloponkénti WIP-limit badge (#388); card-aging vizuális jelzés (#386); alfeladat-beágyazás (#381)
- **Ideabox** -- comment-threadek, impact/effort pontozás, státuszszűrő, életciklus (audit, stale, reversal, definition-of-done) (#397)
- **Token- és költségmonitor** -- per-modell pontos költség, MCP-szerver/eszköz oszlopok, model-backfill upsert (#573)
- **Fleet-infrastruktúra** -- `/.well-known/fleetq` capability manifest Bearer auth-tal (#569); fleet-roster scaffold automatikus generálása a CLAUDE.md-be (#584); `DASHBOARD_PUBLIC_URL` elosztott ágensekhez (#600); dual worker sessions (#602)
- **Ütemezés és megbízhatóság** -- scheduled-task fire-timeout (#665); heartbeat-precheck (#482); per-tool kimenő HTTP-határidő (#561); watchdog restart-flapping javítás (#483)
- **Tool-call audit metadata** (#667); plugin-id centralizálás (#673); telepítő: Go + bumblebee auto-install (#432); frontend smoke-test + syntax-gate CI (#423)

## Miben tér el ez a fork az eredeti Marveen aktuális állapotától

*Állapot: upstream `b56c73d` vs fork `fcd6058`, 2026-07-27*


Változások, amelyek a forkban megvannak, az upstreamben nincsenek:
- **Device-key SSH revocation gap** -- `DELETE /api/auth/device-keys/:id` korábban csak az adatbázis-rekordot és a Bearer-credentialt törölte, az SSH `authorized_keys` bejegyzés érintetlen maradt (a Bridge `bridge-enroll.ts` törlésével eltűnt a `removeBridgeSshAccess` hívás). Javítás: `0003_device_key_install_id` migráció hozzáadja az `install_id` oszlopot a `device_keys` táblához; `remote-enroll-core.ts` megkapja a `removeAuthorizedKey` (pure) függvényt; `remote-enroll-fs.ts` megkapja a `removeEnrolledKey` (lockedread-modify-write) és `removeBridgeSshAccess` függvényeket; `auth-device-keys.ts` tárolja az `installId`-t mintegésnél és `getDeviceKey` hívással visszaadja revocationkor; az auth.ts DELETE handler mindkét oldalt egyszerre vonja vissza (SSH-oldal hiba esetén nem állítja vissza a már törölt DB-rekordot)
- **Dashboard overview-redesign** -- 5-zónás layout, KPI-konsistencia-fix
- **Repo governance** -- .github/CODEOWNERS (@cett default reviewer), dupla copyright a LICENSE-ben, README fork-jelölés és modularizációs indoklás, SECURITY.md valódi security policy-ként újraírva
- **CI/CD pipeline** -- GitHub Actions workflow (build + typecheck + test); CI-safe teszt-env (dist/** kizárás vitest-ből, claude/tmux stub-ok); Node.js 22 (deprecation-warning elhárítás)
- **Dependabot** -- automatikus függőség-frissítés + számos már bemergelve: TypeScript 7, vitest 4, pino 10, @types/node 26, hono, postcss, body-parser, fast-uri, pyasn1
- **Claude-agent-sdk 0.3 session_id fix** -- snake_case/camelCase dual-olvasás, teszttel bizonyítva
- **Kód-refaktor** -- legacy Telegram-route takarítás (matchChannelRoute és a két standalone DELETE-handler legacyMatch-e törölve); OAuth-segéd konszolidálás (readClaudeCodeOauthJson privát másolata eltávolítva heartbeat.ts-ből, a megosztott claude-credentials.ts implementáció importálva); 6 eddig hardkódolt env-kulcs a Beállítások-registrybe vezetve: OWNER_NAME, BOT_NAME, HEARTBEAT_INTERVAL_MS, KANBAN_LABEL_COLORS, ALERT_THRESHOLD_MS, DEFAULT_REVERT_AFTER_MINUTES
- **DB séma-verziózás** -- src/migrations/0001_baseline.sql teljes séma-snapshot (34 tábla, végső oszlopkészlettel); src/db-migrations.ts migration runner (applyMigrations, per-migrációs tranzakció, checksum-ellenőrzés, otel_spans sentinel bootstrap meglévő telepítéseknél); initDatabase() refaktorálva: 830 sornyi inline DDL kiváltva egyetlen applyMigrations(db) hívással
- **Frontend modularizáció** -- a monolitikus web/app.js (13000+ sor) szétbontva: 1299 sornyi váz (boot + routing + közös utilok) + 24 önálló ES-modul a web/modules/ alatt; a web/index.html type="module" betöltéssel, a statikus szerver (src/web/routes/static.ts) path-traversal-guardolt /modules/*.js kiszolgálóval; oldalanként/funkciónként darabolva, minden lépés külön autentikált headless-smoke-kal verifikálva. Token-hatékonyság (becslés): egy tipikus frontend-módosításhoz az ágensnek betöltendő kód a korábbi ~723 KB-os monolit (~180 ezer token) helyett már csak a váz + az érintett modul (~90 KB, ~23 ezer token), azaz hozzávetőleg 85-90%-kal kevesebb token; még a legnagyobb modul (agents.js) szerkesztésekor is ~70%+ a megtakarítás
- **Backend route-modularizáció** -- a monolitikus src/web/routes/agents.ts (1921 sor) szétbontva 5 önálló route-modulra: agents-helpers.ts (közös segédfüggvények, cache-ek), agents-models.ts (modell-kezelés), agents-channels.ts (csatorna setup/hozzáférés, managed settings), agents-process.ts (start/stop/restart/auto-restart/context-guard), agents-crud.ts (list, activity, model-suggest, create, avatar, security, team, export/import, voice-config, master CRUD); agents.ts maga 17 soros delegáló shell lett. A src/web.ts 42-elemű if (await tryHandle*) return lánca RouteDispatcher osztállyá (src/web/routes/dispatcher.ts) refaktorálva: rendezett Handler-tömb, uniform closure-interfész, az auth-gate a dispatcher előtt marad. Minden lépés: tsc --noEmit + teljes vitest (2897/2897) + contract/guard tesztfájlok + curl-smoke, menetenkénti commit
- **Kanban 3-szintu subtask** -- a kanban_cards.parent_id adjacency melle depth oszlop (0002_kanban_depth migracio, rekurziv-pontos backfill a mar meglevo faakhoz); subtask a subtask alatt (max 3 szint: depth 0/1/2), letrehozas/reparent melyseg-korlattal (backend 400 + UI-tiltas a 3. szint alatt); a tablan mind a 3 szint beagyazva renderel osszecsukhato agakkal; cross-parent DnD melyseg-biztos drop-guarddal (a huzott reszfa nem lephet a 3 szint ala); auto statusz-propagacio (minden kozvetlen gyerek done -> szulo done, visszavaltassal); torleskor a gyerekek a nagyszulohoz kerulnek
- **Coverage-riporting** -- @vitest/coverage-v8 provider konfigurálva a vitest.config.ts-ben (src/**/*.ts include, __tests__/** kizárva, text/html/json-summary riportok); coverage threshold gate a jelenlegi measured baseline-on (stmts 46%, branches 47%, functions 51%, lines 47%); package.json "coverage" script; coverage/ gitignore; CI workflow Coverage step + 30 napos artifact upload; testTimeout 15 000 ms-re emelve a párhuzamos suite DB-versenyhelyzet-flakiness ellen
- **Frontend util-konszolidáció** -- az escapeHtml függvény 19 modulban volt külön-külön definiálva (+ mainAgentId 7x, escapeAttr 2x); kiemelve a web/modules/util.js-be (DOM-mentes, pure-string implementáció -- közvetlenül unit-tesztelhető jsdom nélkül); mind a 19 modul lokális definíciója import-ra cserélve; mellé 33 tesztes frontend-util.test.ts (8 unit + 4 struktura-kontrakt + 21 regressziós). Mellékesen két bug is javítva: settings.js/connectors.js-ben /\'\'/g regex két egymás utáni idézőjelet keresett egy helyett; updates.js külön nevet (escapeHtmlUpdates) használt.
- **Backend unit/contract tesztek** -- unit tesztek az alacsony coverage-u backend fájlokhoz; coverage gate ratcheted: stmts 48%, branches 48%, functions 53%, lines 49%
- **Dead code cleanup + helper extraction** -- pino-pretty áthelyezve devDependencies-be (csak NODE_ENV !== 'production' ágban kell); knip.json létrehozva (web/ ignore browser-JS false positive-ok miatt, tsx/@playwright/test ignoreDependencies); assertAgentExists(name, res): boolean helper kiemelve agents-helpers.ts-be -- 15 szétszórt if (!existsSync(agentDir(name))) { json(res,{error:'Agent not found'},404); return true } blokkot vált ki agents-crud.ts, agents-process.ts, agents-channels.ts-ben; readJsonBody(req) helper kiemelve http-helpers.ts-be -- 5 const body = await readBody(req); JSON.parse(body.toString()) párt vált ki ugyanazokban a fájlokban; main-agent-detail-guards.test.ts frissítve (assertAgentExists-re hivatkozik a korábbi existsSync helyett)
- **Coverage-emelés 65%-ra** -- ~695 új teszt a business-logikára; a coverage-gate küszöb az elért szintre ratchet-elve: statements 48→65%, branches 48→63%, functions 53→66%, lines 49→66%. A lefedetlen ~35% szándékosan process-lifecycle/infrastruktúra kód (marveen.ts, telegram.ts, tmux/process-mgmt, keychain, külső API), ami értelmesen csak integration-suite-tal fedhető.
- **Upstream port #729 #738 #739 #740 #741 #742 #743 #744 #746 #747 + #748 (#32)** -- 10 upstream PR szelektív portja egyetlen branch+PR-ben: Bridge-párosítás a dashboardról (POST /api/security/bridge-enroll, per-device kulcs); context-guard restart-vihar javítás (1M-es modellek, paneBusy deferral, highwater); archivált kártyák Kanban-fejlécbe; DEFAULT_AGENT_MODEL konfigurálható; 5 összecsukható oldalsáv-csoport; napló RENDSZER-csoportba; scheduled task chat_id:0 sentinel javítva; docs-link rögzítve az oldalsáv aljára; token-usage ágens-regex bővítve (kötőjel+szám)

<!-- ONGOING: Minden jövőbeli fork-PR leadásakor (Zack -> Jarvis) frissítsd ezt a szakaszt
     a friss git log alapján:
       git fetch upstream && git fetch origin
       git log upstream/develop..origin/develop --oneline   # fork többlet
     Az "Állapot:" sorban frissítsd az SHA-kat és a dátumot. -->

Marveen egy AI asszisztens keretrendszer, ami Claude Code-ra épül. Saját AI csapatot építhetsz, akik Telegramon vagy Slacken kommunikálnak veled, önállóan dolgoznak, és egymással is együttműködnek.

## Funkciók

- **AI Csapat**: Több ágens, mindegyik saját csatornával (Telegram vagy Slack), személyiséggel és memóriával
- **Mission Control**: Web dashboard (http://localhost:3420) a csapat kezeléséhez
- **Inter-agent kommunikáció**: Az ágensek delegálhatnak egymásnak feladatokat
- **Ütemezések**: Cron-alapú feladatok automatikus futtatása
- **Kanban**: Feladattábla AI auto-bontással; Jira-szerű nézetek — swimlane (csoportosítás felelős vagy prioritás szerint), oszloponkénti WIP-limit, beakadt-kártya jelzés (card-aging), alfeladat-beágyazás és kártya-szerkesztő
- **Heartbeat**: Csendes háttér-monitorozás, csak fontosnál szól (naptár, email, kanban)
- **Memória**: Hot/Warm/Cold tier rendszer, hibrid kereséssel (FTS5 + vektor) és gráf nézettel
- **MCP Connectorok**: Gmail, Calendar, Drive, Notion, Slack és más szolgáltatások
- **Skillek**: Újrahasználható képességek az ágenseknek
- **Öntanulás**: Az ágensek automatikusan tanulnak a munkájukból és skill-eket hoznak létre

## 📚 Dokumentáció

Részletes, funkciónkénti leírások a [`docs/`](docs/README.md) mappában — mindegyik lap két szemszögből: 🎯 *mit tud / miért érdekes* + 🛠 *hogyan működik*.

| Funkció | Lap |
|---------|-----|
| Heartbeat + fokozatos autonómia | [docs/heartbeat-autonomy.md](docs/heartbeat-autonomy.md) |
| Memória-rendszer (FTS5 + vektor + RRF) | [docs/memory-system.md](docs/memory-system.md) |
| Kanban (auto-breakdown, swimlane, WIP-limit, card-aging) | [docs/kanban.md](docs/kanban.md) |
| Ügynök-flotta + inter-agent | [docs/agent-fleet.md](docs/agent-fleet.md) |
| Föderáció (több példány összekötése, dashboard-menüvel) | [docs/federation.md](docs/federation.md) |
| Skill-factory (öntanulás) | [docs/skill-factory.md](docs/skill-factory.md) |
| Channels (Telegram / Slack) | [docs/channels.md](docs/channels.md) |
| Printing-press CLI-k | [docs/printing-press-cli.md](docs/printing-press-cli.md) |
| Skool CLI | [docs/skool-cli.md](docs/skool-cli.md) |
| connectors.hu | [docs/connectors-hu.md](docs/connectors-hu.md) |
| Vault & titkosítás | [docs/vault.md](docs/vault.md) |
| Dream-engine | [docs/dream-engine.md](docs/dream-engine.md) |
| Háttér-feladatok | [docs/background-tasks.md](docs/background-tasks.md) |
| Ütemezett feladatok | [docs/scheduled-tasks.md](docs/scheduled-tasks.md) |
| Költöztetés (másik gépre) | [docs/MIGRATION.md](docs/MIGRATION.md) |
| Beszélgetés-folytonosság | [docs/conversation-continuity.md](docs/conversation-continuity.md) |
| Channel reply-guard | [docs/channel-reply-guard.md](docs/channel-reply-guard.md) |
| Telegram haladásjelző | [docs/telegram-progress-indicator.md](docs/telegram-progress-indicator.md) |
| Új asszisztens onboarding | [docs/onboarding-uj-asszisztens.md](docs/onboarding-uj-asszisztens.md) |

## Öntanulás & Seed-ek

Az ágensek automatikusan tanulnak a munkájukból: komplex feladat vagy hiba-recovery után újrahasznosítható skill-t (recept) írnak maguknak, a meglévőket pedig célzottan patch-elik. A skill-ek token-hatékonyan, 3 szinten töltődnek (progressive disclosure). A flotta-szintű skill-ek és ütemezett feladatok a `seed-skills/` és `seed-scheduled-tasks/` mappából terjednek minden telepítésre (idempotens: a meglévő testreszabást nem írja felül).

→ **Részletek:** [docs/skill-factory.md](docs/skill-factory.md)

## Memória rendszer

Minden ágens saját, réteges memóriával rendelkezik (hot / warm / cold / shared), SQLite-ban tárolva. A keresés hibrid: FTS5 full-text + szemantikus vektor (Ollama `nomic-embed-text`), RRF-fel fúzionálva. A memóriák salience decay-en mennek át (a régi, nem használt tételek halványulnak, de sosem törlődnek), és minden este napi napló készül. A `PreCompact` hook a kontextus-tömörítés előtt automatikusan elmenti a fontos döntéseket. A dashboardon gráf-nézet is van.

→ **Részletek:** [docs/memory-system.md](docs/memory-system.md)

## Telepítés

### macOS / Linux

```bash
git clone --branch main https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

Alapértelmezés szerint a dashboard a 3420-as porton indul (`http://localhost:3420`). Egyedi port beállításához:

```bash
./install-linux.sh --port 3421   # vagy: WEB_PORT=3421 ./install-linux.sh
```

### Windows (WSL)

```powershell
irm https://raw.githubusercontent.com/Szotasz/marveen/main/install-windows.ps1 | iex
```

Vagy manuálisan:
```powershell
git clone --branch main https://github.com/Szotasz/marveen.git
cd marveen
.\install-windows.ps1
```

A Windows telepítő automatikusan beállítja a WSL-t (Windows Subsystem for Linux) és azon belül telepíti a Marveen-t.

> **Ha a PowerShell ablak bezárul / a telepítő nem jut túl a WSL+Ubuntu lépésen:** nyisd meg az Ubuntu-t (Start menü → Ubuntu), majd a WSL Ubuntu shellben futtasd közvetlenül a Linux-telepítőt (a PowerShell wrapper megkerülése):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh -o install.sh && bash install.sh
> ```
> Ez a megbízható út, ha a `wsl.exe`/Windows-claude környezet összeakad.

A telepítő végigvezet a beállításokon:
1. Függőségek ellenőrzése és telepítése
2. Claude Code bejelentkezés
3. Telegram bot létrehozása
4. Személyes beállítások (a bot neve és a termék/márka neve)
5. Szolgáltatások indítása

### Branding (saját márkanév)

A platform szabadon márkázható telepítéskor. Két, egymástól **független** beállítás:

| Beállítás | Mi ez | Default |
|-----------|-------|---------|
| `BOT_NAME` | A fő ágens megjelenített neve (pl. `MyAssistant`) | `Marveen` |
| `BRAND_NAME` | A termék / rendszer neve a dashboard fejlécében (böngésző-cím, oldalsáv, mobil topbar) | `BOT_NAME` |

A telepítő mindkettőt megkérdezi. Ha csak Entert nyomsz, minden marad `Marveen` (a viselkedés változatlan a meglévő telepítésekhez képest). Ha külön márkanevet adsz meg, a teljes felület és az OS szolgáltatás-azonosítók is azzal jönnek létre:

```bash
# Példa: az ágens neve "MyAssistant", a terméké "AcmeAI"
#   Mi legyen a botod neve? [Marveen]: MyAssistant
#   Mi a termék/márka neve? [MyAssistant]: AcmeAI
```

A `.env`-ben ezek a kulcsok jelennek meg (lásd `.env.example`):

```env
BOT_NAME=MyAssistant
BRAND_NAME=AcmeAI
MAIN_AGENT_ID=myassistant   # belső ágens-azonosító (a BOT_NAME ASCII slug-ja)
SERVICE_ID=acmeai           # OS szolgáltatás-azonosító (a BRAND_NAME ASCII slug-ja)
```

A `MAIN_AGENT_ID` és `SERVICE_ID` értékeket a telepítő automatikusan származtatja; ritkán kell kézzel szerkeszteni. Ha a `BRAND_NAME` megegyezik a `BOT_NAME`-mel (a default), a `SERVICE_ID` megegyezik a `MAIN_AGENT_ID`-vel, így a launchd/systemd unit-nevek byte-azonosak a márkázatlan telepítéssel: a helyben történő frissítés nem törik el.

## Használat

### Dashboard
Nyisd meg: http://localhost:3420

### Csatorna (Telegram vagy Slack)

A telepítés során választhatsz csatorna providert. Az alapértelmezett a Telegram.

#### Telegram (alapértelmezett)
Írj a botodnak Telegramon -- Marveen válaszol.

#### Slack (alternatív)

Slack használatához a telepítő automatikusan végigvezet, de manuálisan is beállíthatod:

1. Hozz létre egy Slack App-ot a [Slack API](https://api.slack.com/apps) oldalon
2. Engedélyezd a Socket Mode-ot (Settings > Socket Mode > Enable)
3. Generálj egy App-Level Token-t (`xapp-...`) a `connections:write` scope-pal
4. Add hozzá a Bot Token Scopes-okat (OAuth & Permissions): `chat:write`, `channels:read`, `files:write`, `files:read`
5. Installáld az App-ot a workspace-edbe -- megkapod a Bot User OAuth Token-t (`xoxb-...`)
6. Hívd meg a botot a kívánt csatornába (`/invite @BotNev`)
7. A `.env` fájlban állítsd be:
   ```
   CHANNEL_PROVIDER=slack
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL_ID=C01234ABCDE
   ```
8. A Slack channel plugin automatikusan települ: `slack@jeremylongshore/claude-code-slack-channel`

A csatorna váltáshoz futtasd újra a `./install.sh`-t vagy szerkeszd a `.env` fájlt manuálisan.

### Ágensek
A Csapat oldalon hozz létre új ágenseket. Mindegyik:
- Saját Telegram bot
- Saját személyiség (SOUL.md)
- Saját utasítások (CLAUDE.md)
- Saját memória és skillek

### Telegram bot profilkép

A telepítő automatikusan generál egy pixel-art avatart és Telegramon elküldi neked a beállítási utasításokkal. Ha egyedi képet szeretnél:

1. Tedd a fájlt `agents/<AGENT_NEVE>/avatar.png` alá (png/jpg/jpeg/webp)
2. Indítsd újra a szolgáltatást (`./scripts/stop.sh && ./scripts/start.sh`)
3. Az install-flow újra elküldi az avatart a Telegram chatbe

**Beállítás a Telegram botodra:**
1. Nyisd meg a [@BotFather](https://t.me/BotFather) chatet
2. Küld a `/setuserpic` parancsot
3. Válaszd ki a botodat a listából
4. Küldd be a kapott képet

A dashboardon (Csapat oldal) is cserélhetsz avatart: kattints a bot kártyájára, válassz a galériából vagy tölts fel sajátot -- a rendszer automatikusan elküldi a Telegram chatbe.

### Ütemezések
Időzített feladatok és heartbeat monitorok beállítása:
- Lista, napi idővonal és heti nézet
- Feladat: mindig szól az eredménnyel
- Heartbeat: csendes ellenőrzés, csak fontosnál értesít

### Vault & Titkosítás

Az MCP szerverek API kulcsait, tokenjeit és jelszavait egy titkosított Vault kezeli (AES-256-GCM), a master key macOS-en a Keychain-ben (Linuxon fájl-alapú fallback). A `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak — a plaintext kulcsok nem hevernek olvashatóan. A dashboard Vault-oldalán kezelheted a titkokat, a Scan & Import megtalálja a meglévő plaintext kulcsokat.

→ **Részletek:** [docs/vault.md](docs/vault.md)

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

### Remote access key enrollment

A helper that lets an operator enroll a single device's SSH public key with a tightly restricted `authorized_keys` entry, then hands back a copyable connection bundle. Each device carries its own revocation id (`marveen-remote:<uuid>`) so access can be replaced or removed per device.

Run it with the public key line as a single quoted argument:

```bash
npm run remote-enroll -- "ssh-ed25519 <base64 key> marveen-remote:<uuid>"
# optional flags:
npm run remote-enroll -- --host 203.0.113.10 --port 2222 "ssh-ed25519 <base64 key> marveen-remote:<uuid>"
```

The public key line must be exactly three fields (type, key, comment) with no `authorized_keys` options and no extra fields. Only `ssh-ed25519` keys are accepted, and the comment must be `marveen-remote:<uuid>` (uuid v4).

It appends (or replaces, when the same id is re-enrolled) this restricted line to the invoking user's `~/.ssh/authorized_keys`:

```
restrict,port-forwarding,permitopen="127.0.0.1:3420",command="/bin/false" ssh-ed25519 <base64 key> marveen-remote:<uuid>
```

`restrict` disables pty, agent, and X11 forwarding; the forced command is `/bin/false`; and the only endpoint the key may open is `127.0.0.1:3420`. The write is atomic (temp file plus rename) and guarded by an `authorized_keys.lock` file so concurrent runs cannot corrupt the list. `~/.ssh` is created 0700 and `authorized_keys` 0600 when missing; if either already exists with looser permissions the tool warns instead of changing them silently.

After enrolling, it prints a base64 connection bundle between clearly marked delimiters. The bundle carries the host, SSH port and user, the fixed remote port (3420), the device id, the machine's `ssh-ed25519` host key, and -- by default -- the dashboard bearer token (`DASHBOARD_TOKEN` env or `store/.dashboard-token`), so the connecting app can authenticate against the dashboard without a separate step. A token-bearing bundle is a SECRET: hand it over on a private channel only, never by email or shared chat. Pass `--no-dashboard-token` to emit a token-free bundle (the device user must then obtain the dashboard access URL out of band). If no token can be found the tool warns and emits a token-free bundle. The host key is looked up in the known public-key locations (`/etc/ssh`, `/private/etc/ssh`, Homebrew and `/usr/local` prefixes) and, when none of those files exist -- as on stock macOS -- read from the running SSH server itself via `ssh-keyscan` on loopback. The connecting side requires the host key, so if it cannot be obtained from any source the tool exits with an error instead of printing an unusable bundle; start the SSH server (macOS: System Settings > General > Sharing > Remote Login) and re-run. When `--host` is not given, the tool prints a hint to verify the resolved address is the one the device will reach.

To revoke a device, delete the line whose comment matches its id (`marveen-remote:<uuid>`) from `~/.ssh/authorized_keys`.

### Frissítés
```bash
./update.sh
```

### Leállítás / Indítás
```bash
./scripts/stop.sh
./scripts/start.sh
```

### VPS / AWS EC2 telepítés (szerver)

Linux VPS-en (Ubuntu 22+, Debian 12+) az `./install.sh` automatikusan az `install-linux.sh`-t futtatja. Headless szerveren a bejelentkezéshez OAuth token kell, mert nincs böngésző.

```bash
# 1. A SAJÁT gépeden (ahol van böngésző):
claude setup-token
# Másold ki a generált tokent (sk-ant-oat01-...)

# 2. A VPS-en:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
git clone --branch main https://github.com/Szotasz/marveen.git
cd marveen
./install.sh    # automatikusan install-linux.sh-t futtat
```

A token 1 évig érvényes. Ne állíts be `ANTHROPIC_API_KEY`-t mellé.

**Fontos VPS-specifikus tudnivalók:**
- **RAM**: legalább 2 GB ajánlott (t3.small). 1 GB-os gépen az npm build swap nélkül elbukhat -- a telepítő figyelmeztet és felajánl swap-létrehozást.
- **claude.ai MCP-k**: ha a claude.ai fiókodban sok MCP connector van engedélyezve, a headless claude session megpróbálja betölteni mindet, ami instabilitást okozhat. Telepítés előtt tiltsd le a felesleges MCP-ket a claude.ai Settings oldalán.
- **Közvetlen futtatás**: `./install-linux.sh` (Linux) vagy `./install-macos.sh` (macOS) ha az OS-detekciót ki akarod hagyni.

## Követelmények

- macOS, Linux, vagy Windows 10/11 (WSL-lel)
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés szükséges)
- Telegram fiók vagy Slack workspace

## Közösség és támogatás

Kérdésed van? Csatlakozz az AI a mindennapokban közösséghez:

- **Skool közösség**: [skool.com/ai-a-mindennapokban](https://skool.com/ai-a-mindennapokban) -- oktatóanyagok, kérdések, tapasztalatcsere
- **YouTube**: [AI a mindennapokban](https://www.youtube.com/@aiamindennapokban) -- videók, tutorialok
- **Weboldal**: [aiamindennapokban.hu](https://aiamindennapokban.hu)

## Támogasd a projektet

Ha hasznos számodra a Marveen, támogasd a fejlesztést:

[![Támogatás](https://img.shields.io/badge/Támogatás-Donably-orange)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

## Köszönet

A Marveen több külső projektre és koncepcióra épít. A teljes felsorolás (forrás, szerző, licensz, hogyan használjuk) az [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) fájlban található. Köszönet a Perplexity AI-nek (Bumblebee), Artem Zhutovnak (handoff / retrospective / skill-management skill suite), Mike Van Hornnak (printing-press), Andrej Karpathynak (CLAUDE.md pattern), és Matt Pococknak (handoff design tippek) a munkájukért.

## Készítette

**Szota Szabolcs** -- AI konzultáns, az "AI a mindennapokban" csatorna készítője

[![GitHub](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)
