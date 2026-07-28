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

## Változások, amelyek a forkban megvannak, az upstreamben nincsenek:

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
- **Per-agent MCP capability scope (#35)** -- agent-config.json új `mcpScope` mezője ({szerver: [toolok] | "*" | null}, hiányzó = profil örököl); backend enforcer generál settings.json allow/deny listát (Rick, src/); mcp-catalog.json kiterjesztve `tools[]` tömbbel (id, label, dangerous) github/filesystem/brave-search szervereknél; dashboard: új "MCP hatáskör" tab az ágens-detail modalban, 3-állású preset (Teljes/Csak-olvasás/Egyéni), szerverenkénti tool-checkboxok veszélyes-jelöléssel (🔴), "Mind" szerver-toggle, fallback szabad szöveges input ismeretlen szervereknek; i18n: agents.mcp_scope.* kulcsok hu.js + en.js szimmetrikusan

<!-- ONGOING: Minden jövőbeli fork-PR leadásakor (Zack -> Jarvis) frissítsd ezt a szakaszt
     a friss git log alapján:
       git fetch upstream && git fetch origin
       git log upstream/develop..origin/develop --oneline   # fork többlet
     Az "Állapot:" sorban frissítsd az SHA-kat és a dátumot. -->

## Minden másban - telepítés, használat - a fork megegyezik az eredetivel.
