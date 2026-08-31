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

> **Fork.** Ez a repó a [Szotasz/marveen](https://github.com/Szotasz/marveen) önálló forkja, amely `fork-point` (2026-07-26, baseline: upstream `55ecbc6`) óta függetlenül fejlődik. Az upstream javításokat szelektíven vesszük át (`git fetch upstream` + cherry-pick). Hozzájárulásokat ehhez a forkhoz várunk PR-ként. Az AI által generált monolitikus kódot felhagyva, modularizált verzió alkotása a célom, amelyben nagyságrendekkel kisebb tokenhasználatot emészt fel magának a keretrendszernek a használata és robosztusabb kialakítása révén hosszútávon stabilabb működést biztosít.
>
> Állapot: upstream `62ea642` vs fork `70cc14e`, 2026-08-31

## Jónás Gergő (cett) hozzájárulásai az eredeti Marveen repóhoz

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
- **Ütemezés és megbízhatóság** -- scheduled-task fire-timeout (#665); heartbeat-precheck (#482); per-tool kimenő HTTP-határidő (#561); watchdog restart-flapping javítás (#483); Dream Engine skill-flotta bucket a valós használati naplóból mér, nem becsül
- **Tool-call audit metadata** (#667); plugin-id centralizálás (#673); telepítő: Go + bumblebee auto-install (#432); frontend smoke-test + syntax-gate CI (#423)

## Változások/bővítések, amelyek a forkban megvannak, az upstreamben nincsenek:

**Biztonság és hozzáférés-szabályozás**

A modell-azonosítót és a webport-értéket a konfiguráció bevitelétől az indítási pontig regex-validáció védi, kizárva a command-injection lehetőségét. A memória-tartalom-szűrő (`SUSPICIOUS_PATTERNS`) kizárólag a négy prompt-injekciós mintát blokkolja (utasítás-felülírási kísérletek); a korábban tévesen szereplő technikai parancs-minták (`rm -rf`, `curl`, `bash -c`, `eval(`, `exec(`, `import subprocess`) eltávolításra kerültek, mivel tárolt szöveg ezekből nem tud önállóan végrehajtódni, viszont jogos üzemeltetési memóriákat zártak ki. Ha egy eszközkulcsot visszavonnak, az SSH `authorized_keys` bejegyzés is törlődik, nem csak az adatbázis-rekord -- a korábbi implementáció ezt az oldalt kihagyta. A dashboard alapértelmezés szerint loopbackre köt; minden beérkező kérés `Host` fejlécét érvényes originek allowlistjével veti össze, mielőtt az auth-logika lefutna, megelőzve a DNS-rebinding támadásokat.

A hozzáférés-szabályozás több rétegen fut: Zod-séma validálja az összes env-változót boot-időben (production alatt FATAL a hibás token vagy portformátum), a secret-resolver fájlrendszer-alapú secret-mountot is kezel (`/run/secrets/<KEY>`, Docker/k8s kompatibilis, `.env` felett prioritással), a partner-sender allowlist és a delivery-intent registry megakadályozza, hogy ismeretlen forrásból érkező szöveg a sub-ágens bemenetébe kerüljön. Az RBAC gate egyelőre shadow módban fut: naplóz, de nem tilt. A memória-visszakeresés és a vektoros keresés (hibrid FTS + ANN), az üzenet-szálak, az egységes visszahívás (recall memories-oldala) és a dashboard-áttekintő (memória-darabszámok, kategória-bontás, olvasatlan üzenetek, aktivitás-feed) nem-admin hívásoknál SQL-szintű tenant-határon szűrnek; az admin globális képet lát és ?tenant= paraméterrel szűkíthet; a flottaszintű számlálók (token-használat, jóváhagyások, hibaspanok) szándékosan szűretlenek maradnak. A jóváhagyások (`approvals`) szintén tenant-scopedak: az `approvals` tábla `tenant_id` oszlopot kapott (0025-ös migráció), a `listApprovals()` SQL-szintű tenant-szűréssel fut LIMIT előtt (cross-tenant IDOR megelőzve), a nem-admin session-user csak a saját tenantjának kéréseit látja és hagyhatja jóvá; a `viewer` és `read_only` szerepkörök `approvals:read` + `approvals:write` jogot kaptak, de a POST (kéréslétrehozás) route-szinten tiltott tenant-usernek -- azt kizárólag fleet-ágensek és admin generálhat. A `PATCH /api/approvals/:id` cross-tenant vagy nem-létező id esetén `404 not_found`-ot ad (anti-enumeration, összhangban a kanban és memories by-id végpontokkal); a `403 forbidden` kizárólag a session tenantId hiányára (`undefined`) marad, ami konfigurációs hiba. Tenant teljes törlése: `DELETE /api/admin/tenants/:id` (csak admin) FK-helyes kaszkáddal: pending approvals előbb elutasítva, api_tokens revoke-olva (tombstone), dashboard_users/partner_senders/device_keys/approvals/agent_messages/import_memories/kanban/memories törölve, a `default` tenant nem törölhető (403). A memories törlése vec0-biztonságos, soronkénti `syncVecMemoryDelete` hívással.

A B2B admin UI (dashboard "Felhasználók" oldal, csak globális adminoknak látható) háromfüles kezelőfelületet ad: tenantok listázása/letiltása, felhasználók létrehozása/letiltása tenant-szűrővel, eszközkulcsok tenant-hozzárendelése. Az ágensek elérhetőségét tenant-szinten deny-by-default elven lehet engedélyezni (`tenant_agent_availability` tábla, `GET/PUT /api/admin/agent-availability`); ha egy tenanthoz nincs engedélyező sor, az ágens alapértelmezés szerint letiltottnak számít.

A `workspace_docs` tábla (0027-es migráció) a fleet-ágensek munkadokumentumait tárolja: tervek, briefek, riportok, megjegyzések és bináris fájlok. UPSERT-et az `(agent_id, doc_key)` egyedi index biztosít, így egy ágens ugyanazt a terv-slugot újramentve mindig frissít, nem duplikál. `content_type` értékei: `text` (max 2 MB), `code` (max 4 MB), `binary` (max 16 MB, BLOB, API-n base64-kódoltan). Tenant-szintű izolálás: nem-admin hívók csak saját tenantjuk dokumentumait látják; írás kizárólag fleet-ágens token (`auth.kind = 'token'`) számára engedélyezett, session-felhasználók 403-at kapnak. Az alkalmazásszintű vektorszinkron (`vec_workspace_docs`, adatbázis-trigger nélkül) szöveges és kód típusú dokumentumokat indexel; bináris fájlok embedding nélkül tárolódnak. A TTL sweeper az `updated_at` alapján törli a lejárt, nem-bináris dokumentumokat, de megvédi azokat, amelyek nyitott kanban-kártyára mutatnak.

A bejelentkezett B2B felhasználónak önkiszolgáló profil-oldal áll rendelkezésre (dashboard "Profilom"): identity card (felhasználónév, megjelenített név, e-mail, szerepkör, tenant), jelszócsere modal (jelenlegi + új jelszó, 12 karakter minimum), és az összes munkamenet kiléptetése. A sidebar alján mindig látható felhasználó-blokk (avatar + név + szerepkör + tenant) navigál a profil-oldalra. Új végpontok: `GET /api/v1/me` (saját profil lekérése, session-token kötelező) és `PATCH /api/v1/me` (display_name / email módosítása, max 128 karakter, validált email formátum).

**Memória, keresés és adatkezelés**

Az embeddingtárolás JSON helyett bináris Float32 formátumra vált, egységnyi emlékenként ~80%-kal kisebb hellyel; a startup-migráció adatvesztés nélkül konvertálja a meglévő bejegyzéseket. Ha a `sqlite-vec` extension elérhető, a vektoros keresés HNSW közelítő szomszéd-kereséssel fut, különben automatikusan visszalép teljes-vizsgálatos koszinusz-keresőre. A `hybridSearch()` FTS és vektor találatait RRF-fúzióval kombinálja, majd cross-encoder reranker és recency boost finomítja a sorrendet; a `memory_links` irányított gráf 1-hop kiterjesztéssel vonja be a szemantikailag kapcsolódó szomszédokat.

A `span_reads` tábla rögzíti, ki és mikor olvasott egy emléket; a `memory_versions` minden tartalomváltozásnál snapshot-ot készít, az auto-resort 30 nap olvasatlan warm emléket cold-ba süllyeszt. A token-naplók 30 napra csökkentett ablakkal pruningolódnak, de a napi/havi összesítő táblák 1, illetve 3 évre megőrzik a számlázási adatokat -- az aggregálás idempotens. Az artifact store SQLite-ba menti az ágensek generált tartalmát (FTS5 + ANN kereshetőség, HMAC-tokenelt sandbox-megnyitás); a fájlrendszerről való import sha-256 hash alapú deduplikációval és secret-gate szűrővel fut.

**Üzemeltetési megbízhatóság**

Marveen-újraindítás vagy váratlan crash után az összes konfigurált ágens 60 másodpercen belül automatikusan visszaáll; a rendszer megkülönbözteti a szellem-sessionöket (shell él, Claude összeomlott) és azokat is újraindítja. Ha egy modell elérhetetlenné válik, konfigurálható visszalépési lánc lép életbe (pl. opus -> sonnet -> haiku), kétszeres pane-megerősítéssel, hogy egy chatben idézett hibaüzenet ne indítson felesleges váltást. Kontextustelítődésnél fail-closed `/clear` kapu véd: nem indul újraindítás, ha aktív gyermekfolyamat, kézbesítetlen kimenet vagy megválaszolatlan kérdés van; a compact monitor per-agent cooldown-nal és modell-specifikus limittel ütemez; a deferred-compact pending flag megakadályozza, hogy aktívan dolgozó ágensek kiessenek a tömörítési körből (a token_usage sor forduló-végén keletkezik, ezért a frissesség-kaput a pending flag bypass-olja; 95%+ kontextusnál értesítő üzenet kerül a pane-be); a monitor a főágens saját session-jén belüli futásakor a busy jelzést önokozottnak tekinti -- nem flaggeli pending-nek, így elkerüli a végtelen halasztási ciklust; a `buildMemoryContext()` és a mögöttes `recentMemories()` most tenant-szűrést is elfogad, megelőzve a cross-tenant szivárgást ha a függvényt egy jövőbeli chat-integrációs úton bekötik. A 4-utas provider-dispatch (Claude/Ollama/Deepseek/OpenRouter) háttér-workerbe kiemelve, így a kanban AI-bontás is futhat helyi Ollama-modellen; session végén az auto-skillify hook SKILL.md draftot generál, ha a session elérte az összetettségi küszöböt. A migráció-runner állandó `WARN` helyett `INFO`-t logol, ha a checksum-eltérés egy ismert, jóváhagyott fájlmódosításból (pl. privacy-scrub) ered -- így egy valódi, véletlen szerkesztés jövőben nem olvad bele a megszokott zajba.

**Fleet koordináció és láthatóság**

A `fleet_blackboard` tábla agensenként egy upsert-alapú sort tárol (status: active/done/blocked, max 500 char összefoglaló), amelyet az Overview widget 15 másodpercenként frissít; ha egy ágens aktív sor mellett inter-agent üzenetet küld, de a blackboard-sorát nem frissíti, stale signal (piros/narancs badge) jelzi az anomáliát. A `fleet_blackboard_history` minden állapotváltást append-only módon rögzít 30 napos retentionnel. A schedule runner a feladat-prompt injektálása előtt automatikusan aktív-nak jelöli magát a blackboardon, majd befejezéskor done-ra vált. A Skills oldalon a kártyák 30 napos használati badge-et és LRU-rendezési opciót mutatnak a `skill_usage` tábla alapján; a deferred-MCP integráció 3-lépcsős ToolSearch-laddert követ, mielőtt "tool nem elérhető" választ adna.

**API és integrációs szerződés**

A `docs/openapi.yaml` (OpenAPI 3.1, 70+ végpont) az egyetlen referencia az API-felületre: az `Error` séma tartalmazza a korábban dokumentálatlan `hint` és `field` opcionális mezőket, a végpontok három tier-be vannak sorolva (teljes séma, közepes részletesség, `x-internal`). A generált `src/generated/api.ts` CI-gate garantálja, hogy a kliens mindig szinkronban legyen a speccel; az `oasdiff` step megakadályozza, hogy inkompatibilis változás észrevétlenül bekerüljön. Az URL-verziózás kanonikus `/api/v1/*` útvonalakat vezet be; a korábbi `/api/*` aliasok `Deprecation` + `Sunset` (RFC 8594) headerekkel élnek tovább a minimum 6 hónapos deprecation-ablak lejártáig, amelyet a `docs/api-deprecation-policy.md` rögzít. Az OTEL JSON exporter a span-adatokat Grafana Tempo/Jaeger formátumban adja ki.

Az összes API-hibaválasz egységesített, gépi-olvasható szerződést követ: az `error` mező egy kanonikus snake_case tokent tartalmaz (`not_found`, `required`, `invalid_value`, `forbidden`, `unauthorized`, `conflict`, `limit_exceeded`, `internal_error`, `parse_error`, `not_supported`, `timeout`, `disabled`, `managed_settings_missing`), a human-readable magyarázat a `hint`-ben, a hibás mező neve a `field`-ben jelenik meg, a HTTP státuszkód a tokenhez igazodik. A magyar felhasználói üzenetek a `hint`-ben megőrzöttek. A normalizálás 16 fork-PR (#209-#224) alatt, az `openapi.yaml`-t és a `CHANGELOG.md`-t végigkísérve valósult meg; az upstream ezt a lépést nem tette meg. A `PUT /api/memories/:id` végpont korábban 500-at adott érvénytelen JSON body vagy hiányzó `content` mező esetén; most `400 parse_error`, illetve `400 required` választ ad, a katalógus szerinti `hint` és `field` mezőkkel.

**Fejlesztői alapinfrastruktúra**

A DB migration runner checksum-ellenőrzéssel és per-migrációs tranzakciókkal fut; a CI Node 22 + Python 3.12 kombinációban futtatja a teljes tesztkészletet. A monolitikus frontend (13 000+ sor) 24 ES-modulra darabolva becsülten 85-90%-kal kevesebb token-terheléssel egy-egy módosításhoz, a lazy-load ~444 KB parse-csökkentést hoz a nem-Overview oldalakon; az 5 backend route-modul és a RouteDispatcher ugyanezt a mintát követi szerver oldalon. A coverage-gate 65%-on ratchet-elve CI-ban fut; a nightly backup SHA-256 sidecarral és automatikus verify-restore-ral megy; a skill-fájlokban az ágens-azonosítók és a tulajdonos neve hordozható placeholder-ekre cseréltek (code-fence védelem: a migrációs eszköz prózában cserél, végrehajtható parancssorban nem, így a parancsok futtathatók maradnak); az SQLite pragma-csökkentés ~60 MB idle RSS-t takarít meg.

## A fork létrehozása óta átvett - cherry-pick - javítások:
#720, #727, #729, #738, #739, #740, #741, #742, #743, #744, #746, #747, #749, #751, #752, #753, #756, #757, #758, #763, #760, #765, #768, #769, #771, #772, #776, #777, #778, #779, #780, #781, #782, #783, #784, #785, #786, #789, #790, #791, #793, #795, #797, #799, #800, #801, #802, #803, #805, #821, #822, #826, #828, #829, #832, #838, #866, #833, #933, #934, #942, #943, #938, #854, #855, #871, #879, #888, #889, #906, #911, #926, #929, #940, #936, #973, #877, #964, #842, #857, #861, #885, #895, #896, #843, #876, #957, #1001, #1000, #982, #899, #939, #955, #992, #988, #985, #1007, #1010, #1013, #995, 

Állapot: upstream `62ea642` vs fork `70cc14e`, 2026-08-31

<!-- ONGOING: Minden jövőbeli fork-PR leadásakor (Zack -> Jarvis) frissítsd ezt a szakaszt
     a friss git log alapján:
       git fetch upstream && git fetch origin
       git log upstream/develop..origin/develop --oneline   # fork többlet
     Az "Állapot:" sorban frissítsd az SHA-kat és a dátumot. -->

## Minden másban - telepítés, használat - a fork megegyezik az eredetivel.
