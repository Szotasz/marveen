# Claude kulcs-rotáció -- terv (PR2/PR3 a claude-plans.ts PR1-je után)

Státusz: TERV, jóváhagyásra vár. Ne kezdj implementációt ez alapján jóváhagyás előtt.

## 1. Cél

Ha a flotta aktív Claude-előfizetése (amit a fő channels-agens és/vagy egy
sub-agent használ) kifogy a kvótájából, a rendszer automatikusan váltson egy
másik, regisztrált Claude-loginra -- Telegram-jelzéssel, akár beszélgetés
közepén is -- helyette hogy a csatorna némán leálljon.

Ez a `src/web/claude-plans.ts` tetején álló megjegyzés szerinti PR2/PR3:
a modul explicit "This module is the READ + VALIDATE half (PR1). It does NOT
wire the main agent (channels.sh) or do drift detection -- those are separate,
gated follow-ups." Ez a terv pontosan ez a follow-up.

## 2. Már eldöntött design (Kobza Attila jóváhagyta, NE nyisd újra)

- Automata váltás CSAK 2+ regisztrált plan esetén aktiválódik. 1 plannál marad
  a jelenlegi kézi `scripts/auth.sh` folyamat, változatlanul.
- A váltás azonnal megtörténhet, beszélgetés közepén is, de MINDIG megelőzi
  egy Telegram jelzés (c3po `reply` tool-lal).
- A rendszer SOSEM áll le amíg van legalább egy elérhető kvótás plan -- ez
  felülír minden más szabályt (proaktív küszöb, near-reset halasztás, stb.).
- Proaktív váltás az aktív plan 5 órás ablakának 90%-ánál, KIVÉVE ha a reset
  hamarabb jönne, mint amennyit a váltás megérne -- lásd 6.3.
- Kobza Attila megerősítette (2026-09-11): a proaktív 90%-os küszöb MELLETT
  egy REAKTÍV út is kell -- ha a keret ténylegesen elfogy (kvóta-kimerülésre
  utaló hiba az aktív munkamenetben), a váltás AZONNAL fusson, a következő
  heartbeat-ciklusra várás nélkül. Lásd 6.3 kiegészítés.
- Több elérhető plan esetén a legtöbb becsült szabad kvótájú plan-t választja.
- Becslés: utolsó ismert aktív időbélyeg + akkori % + ismert 5 órás/heti reset
  ciklus alapján extrapolálva -- NINCS élő próbahívás inaktív planek ellen.
- Tárolás: `store/claude-plans.json` (MÁR LÉTEZIK, PR1, üres). Bejegyzés: id,
  label, configDir, planType (personal/team), channelsAllowed.
- Dashboard Settings oldal kap egy kezelőfelületet. Jelenleg csak GET van --
  a write API + UI EBBEN a tervben készül.
- A Fable/Opus heti keret kijelzése KIFEJEZETTEN NEM ez a terv, azt a
  fő session párhuzamosan intézi (overview-sáv). Ez a terv nem nyúl a
  `src/web/quota.ts` / overview kódhoz.

## 3. Meglévő épületblokkok (ne építsd újra ezeket)

| Blokk | Fájl | Mit ad |
|---|---|---|
| Plan-regisztry (read+validate) | `src/web/claude-plans.ts` | `ClaudePlan` típus, `resolveClaudePlans`, `readClaudePlans`, `getClaudePlan`, `resolveAgentConfigDir` (per-agent, NEM a main agentre) |
| GET olvasó API | `src/web/routes/agents.ts:745` (`GET /api/claude-plans`) | Csak listázás, nincs write |
| Kvóta-pillanatkép (aktív identitás) | `scripts/usage-collect.py` -> `store/usage-latest.json` | `claude.windows.{five_hour,seven_day,seven_day_opus,seven_day_sonnet}.{used_percent,resets_at}`, `claude.source` (`authoritative`/`authoritative_cached`/`estimate`), `generated_at` |
| Pure gate-döntés (háttérmunka halasztás) | `src/quota-gate.ts` | `decideQuotaAction`, `QUOTA_GATE` küszöbök (deferAtPercent=85, nearResetPercent=70, nearResetMs=30min), `quotaPressure` -- **ugyanez a küszöb-stílus reprodukálandó a rotációs döntésnél**, ne találj ki új számokat innen eltérően indoklás nélkül |
| Snapshot-olvasó (TS oldal) | `src/quota-snapshot.ts` | `readQuotaSnapshot()` -- `usage-latest.json` -> `QuotaSnapshot` a gate számára |
| Fő-agent auth módjai | `scripts/channels.sh` (kb. 596-712. sor) + `src/web/agent-process.ts` (`ensureMainAgentIsolatedConfigDir`, `resolveMainAgentConfigDir`, `mainAgentConfigDirIfSeparate`) | A main agent HÁROM auth-módja: (a) shared `~/.claude` (default), (b) explicit `MAIN_AGENT_CONFIG_DIR` (operátor saját külön logon a botnak), (c) izolált `.channels-config` + flotta setup-token (`MAIN_AGENT_ISOLATED_CONFIG=1`). A rotáció a (c) izolált módra épül rá -- lásd 6.2 |
| Kézi egy-kulcsos setup | `scripts/auth.sh` | Marad változatlan, ez a "csak 1 plan" út |
| Beállítás-tár (dashboard toggle + .env, felülírás-sorrend) | `src/web/settings-store.ts` (`getEffectiveSettingValue`, `setOverride`) | Ide kerül minden új boolean/enum kapcsoló (pl. az automata rotáció be/ki) |
| Settings route | `src/web/routes/settings.ts` | GET/POST `/api/settings` -- ide illesztendő az új kapcsoló definíciója, NEM külön route |

## 4. Nem-célok

- Fable/Opus overview-sáv (külön szálon fut, lásd 2.).
- Sub-agentek egyedi plan-váltása -- ez a terv a FŐ (channels.sh) agent
  rotációjára fókuszál. Sub-agentek jelenleg statikusan egy plan-hez vannak
  kötve (`claudePlan` mező, `agent-config.ts`), ez marad; automata rotáció
  rájuk később, külön kérésre (lásd Nyitott kérdések #1).
- Drift-detection (`expectedOrgType`/`expectedEmail` mezők validálása egy
  planen belül) -- ezt a `claude-plans.ts` kommentje is külön, jövőbeli PR3-ként
  nevezi meg, ez a terv nem foglalkozik vele.
- Élő próbahívás egy inaktív plan kvótájának lekérdezésére -- explicit kizárva
  a döntött designban.

## 5. Adatmodell

### 5.1 `store/claude-plans.json` -- NEM bővül

Az operátor által szerkesztett config marad tiszta (id/label/configDir/
planType/channelsAllowed). Runtime telemetria NEM megy bele -- ha a dashboard
menti a fájlt, az nem írhatja felül véletlenül egy másik folyamat által frissen
írt kvóta-adatot, és fordítva.

### 5.2 ÚJ: `store/claude-plans-state.json` -- machine-managed side-car

```json
{
  "activePlanId": "personal-1",
  "plans": {
    "personal-1": {
      "observedAt": 1799999999000,
      "source": "authoritative",
      "windows": {
        "five_hour":  { "usedPercent": 42.0, "resetsAt": 1800001234 },
        "seven_day":  { "usedPercent": 18.0, "resetsAt": 1800500000 }
      }
    },
    "team-1": {
      "observedAt": 1799900000000,
      "source": "authoritative",
      "windows": { "...": "..." }
    }
  }
}
```

- `activePlanId`: melyik plan-t használja JELENLEG a main agent. Null, ha a
  main agent a shared `~/.claude` alól fut (rotáció nem alkalmazható -- lásd
  6.2).
- `plans.<id>`: az utoljára megfigyelt kvóta-pillanatkép AMÍG az a plan volt
  aktív. Egy inaktív plan bejegyzése NEM frissül, amíg vissza nem válik rá a
  rotáció -- ez pontosan a "utolsó ismert aktív időbélyeg" input a
  becsléshez.
- Atomikus tmp+rename írás, ugyanaz a minta mint `writeJsonAtomic` az
  `agent-process.ts`-ben.

Miért side-car és nem bővítés a `claude-plans.json`-ban: az utóbbi operátor-
szerkesztett, a dashboard "mentés" gombja a teljes fájlt felülírhatja egy
régebbi state-tel, ha a telemetria is ugyanott lakik -- két író, egy fájl,
race. Külön fájl = külön tulajdonos.

## 6. Komponensek

### 6.1 Új pure modul: `src/claude-plan-rotation.ts`

Mintázat: pontosan úgy pure, mint `quota-gate.ts` -- bemenetek objektumként,
semmi fs/network hívás idebent, hogy tesztelhető legyen fixture-ökkel.

```ts
export interface PlanQuotaEstimate {
  planId: string
  freeFivePct: number   // 0..100, MAGASABB = több szabad kvóta
  freeSevenDayPct: number
  estimatedAt: number   // nowMs, csak logolásra
}

export function estimateWindowFree(
  lastObserved: { usedPercent: number; resetsAt: number } | undefined,
  windowLenMs: number,
  nowMs: number,
): number {
  // Nincs adat -> optimista fail-open: 100% szabad (ugyanaz a FAIL OPEN elv
  // mint quota-gate.ts-ben -- a "nem tudjuk" nem lehet ok a lezárásra).
  if (!lastObserved) return 100
  const resetsAtMs = lastObserved.resetsAt * 1000
  if (nowMs >= resetsAtMs) {
    // Legalább egy reset-határ átment mióta inaktív -- a determinisztikus,
    // usage-független rolling ablak (5h) vagy fix ciklusú (7d) window ekkor
    // garantáltan 0%-ra ürül. Nem kell hányszor-jár-le számolni, elég a
    // tény hogy legalább egyszer lejárt: usedPercent = 0.
    return 100
  }
  // Még nem járt le -- inaktív plan-en semmi nem fogyasztja a kvótát, a %
  // FROZEN az utolsó megfigyelt értéken.
  return 100 - lastObserved.usedPercent
}

export function pickRotationTarget(
  candidates: Array<{ planId: string; freeFivePct: number }>,
  excludePlanId: string,
): string | null {
  const pool = candidates.filter(c => c.planId !== excludePlanId)
  if (pool.length === 0) return null
  return pool.reduce((best, c) => (c.freeFivePct > best.freeFivePct ? c : best)).planId
}
```

`windowLenMs` a hívó oldalán jön (5h vagy 7d, ugyanaz a konstans-tábla mint
`usage-collect.py` `CLAUDE_WINDOW_SECONDS`-ja, TS oldalon új konstansként,
NEM importálva Pythonból -- két nyelv, duplikált konstans, kommentben
keresztre hivatkozva mindkét oldalon).

Megjegyzés az "extrapolate" szóhoz a döntött designban: a fenti modell NEM
fuzzy becslés, hanem DETERMINISZTIKUS -- egy inaktív plan kvótája csak akkor
változik, ha egy reset-határ átmegy (usage-független, rolling ablak), különben
usage-független módon FROZEN marad az utolsó megfigyelt %-on, mert semmi nem
fogyasztja amíg nem aktív. Ha ez a feltételezés téves (pl. az operátor egy
plant kézzel is használ Claude Code CLI-ből közben), a becslés optimista lesz
-- ez tudatos kockázat, dokumentáld a kódban is.

### 6.2 Rotáció csak izolált configon értelmezhető

A main agent auth-módjai (3. táblázat): shared `~/.claude`, explicit
`MAIN_AGENT_CONFIG_DIR`, izolált `.channels-config` + flotta token. A
rotáció KIZÁRÓLAG az izolált módban működik, mert:

- shared `~/.claude` esetén nincs "plan" fogalom -- az az operátor saját,
  kézi bejelentkezése, a rendszer nem válthat rajta.
- explicit `MAIN_AGENT_CONFIG_DIR` egy KÜLÖN, saját identitás -- szándékosan
  nem a flotta poolja, a rotáció nem nyúlhat hozzá.
- izolált mód (`MAIN_AGENT_ISOLATED_CONFIG=1`, flotta setup-token) az EGYETLEN
  eset ahol a `CLAUDE_CONFIG_DIR` + a hozzá tartozó token egy, a rendszer által
  kezelt párosítás -- pontosan ez cserélhető ki egy MÁSIK plan `configDir`-jára
  + tokenjére.

Előfeltétel a rotáció aktiválásához: `MAIN_AGENT_ISOLATED_CONFIG=1` ÉS 2+
regisztrált plan a `claude-plans.json`-ban. Ha ez nem áll, a rotációs logika
`no-op`-ként fusson (loggolva, Telegram-zaj nélkül) -- ugyanaz a "strict
no-op meglévő installokra" elv, mint az `ensureMainAgentIsolatedConfigDir`
kommentjében.

Nyitott kérdés, hogy ez így elég szűk-e a jelen flottának -- lásd Nyitott
kérdések #2.

### 6.3 Döntési logika (mikor váltunk)

Heartbeat-szerű ellenőrzés (lásd 6.5 az ütemezésről), minden ciklusban:

```
snapshot = readQuotaSnapshot()  // usage-latest.json, az AKTÍV plan windowjai
if snapshot.source not in (authoritative, authoritative_cached): return  // fail open, ne dönts bizonytalanból
five_hour = snapshot.windows.five_hour
if five_hour is null: return

usedPct = five_hour.used_percent
untilResetMs = five_hour.resets_at*1000 - now

if usedPct < 90: return  // nincs nyomás

// "kivéve ha a reset hamarabb jönne" -- near-reset halasztás, quota-gate.ts
// nearResetMs mintájára (30 perc): ha a reset ennél közelebb van, egyszerűbb
// kivárni, mint egy váltást (Telegram-zaj + session-megszakítás) csinálni
// percekre.
if untilResetMs <= NEAR_RESET_MS (30 min): return  // hagyd resetelni magától

candidates = other plans' estimateWindowFree() a state fájlból
target = pickRotationTarget(candidates, activePlanId)

if target is null:
  // NINCS másik elérhető plan -- a "sosem áll le amíg van kvótás kulcs" itt
  // nem tud teljesülni jobban mint a jelenlegi plan-en maradni. NE állj le,
  // NE válts semmire, csak jelezz (lásd 6.4, "nincs hova váltani" eset).
  alertNoAlternative()
  return

performRotation(target)
```

A `usedPct < 90` és a `NEAR_RESET_MS` a `quota-gate.ts` `QUOTA_GATE` objektum
mintájára egy exportált, elnevezett konstans-blokkban legyen (`ROTATION_GATE`),
NE inline szám -- így egy jövőbeli hangolás egy helyen történik és a teszt is
a névre hivatkozhat, nem a nyers számra.

Kiegészítés -- reaktív út (Kobza Attila, 2026-09-11): a fenti a PROAKTÍV,
heartbeat-ciklusú út (6.6, ~10 percenként fut). Emellett kell egy REAKTÍV út
is: ha az aktív munkamenetben ténylegesen egy kvóta-kimerülésre utaló hiba
(429 / "quota exceeded" a Claude API-tól) érkezik, az AZONNAL indítsa a
`performRotation(target)`-et, a heartbeat következő futására várás nélkül.
Ez zárja le azt a rést, ahol a keret a két heartbeat-ellenőrzés KÖZÖTT fut ki
-- a proaktív 90%-os küszöb ezt nem kapja el időben, csak a következő
ciklusban. A hibafelismerés pontos helye (hol figyeljük a 429-et a
channels.sh / a `claude` process kimenetén) implementációs kérdés, de maga a
követelmény (reaktív, azonnali trigger a proaktív mellett) explicit és
eldöntött, nem nyitott kérdés.

### 6.4 Telegram-jelzés

A c3po `reply` tool-lal, MIELŐTT a váltás megtörténik (a döntött design
szerint MINDIG megelőzi). Két eset:

1. Sikeres váltás előtt:
   > Az aktív Claude-kulcs ([current label]) kifutott (5 órás ablak: [X]%
   > használt, reset [rel idő]). Váltok a [target label] kulcsra, ez pár
   > másodpercig tarthat -- a beszélgetés folytatódik utána.

2. Nincs hova váltani (minden plan nyomás alatt vagy nincs másik):
   > Az aktív Claude-kulcs ([current label]) 90% fölött, de nincs másik
   > elérhető kulcs -- marad ez, amíg a reset megjön ([rel idő]).

A pontos szöveg finomhangolása implementáció közben rendben van, de a KÉT eset
(sikeres váltás / nincs alternatíva) mindkettő KÖTELEZŐ, mert a "sosem áll le
némán" elv mindkettőre vonatkozik.

### 6.5 A váltás mechanikája -- ÉS A LEGNAGYOBB KOCKÁZAT

A `CLAUDE_CONFIG_DIR` + a hozzá tartozó OAuth-token launch-time env var
(`channels.sh`, exportálva a tmux session indítása ELŐTT). Egy plan-váltás
tehát:

1. `store/claude-plans-state.json` `activePlanId` frissítése az új plan id-re.
2. A main agent tmux session-jének KONTROLLÁLT újraindítása ÚJ
   `CLAUDE_CONFIG_DIR`-ral (a target plan `configDir`-ja) és a hozzá tartozó
   tokennel -- ehhez a `channels.sh` izolált-config ágát kell paraméterezni
   ("melyik configDir-t provisionáljam", jelenleg csak a flotta egyetlen
   `.channels-config`-ját tudja).
3. A tmux session újraindítása = ÚJ `claude` process = ÚJ Claude Code
   session/transzkript. A FOLYAMATBAN LÉVŐ BESZÉLGETÉS KONTEXTUSA (a modell
   context window-ja) ELVESZIK ezen a ponton -- ez NEM ugyanaz mint a meglévő
   `context-restart-gate-runner.ts` (az csak `/clear`-t küld VAGY kontextus-
   telítettség miatt kemény restartot csinál, de UGYANAZON identitáson/
   configDir-on belül marad, tehát a transzkript-gyökér nem változik).

   A döntött design ("a váltás akár beszélgetés közepén is megtörténhet")
   ELFOGADJA ezt a veszteséget, de a pontos UX-nek tisztáznia kell: a
   Telegram-jelzés (6.4/1) UTÁN a felhasználó a következő üzenetére egy
   FRISS, előzmény nélküli main-agent sessiont kap. Ha ez nem elfogadható
   (pl. Kobza egy hosszú, kontextus-függő feladat közepén van), ez egy
   Nyitott kérdés (lásd #3) -- érdemes megkérdezni MIELŐTT ez a rész
   implementálásra kerül, mert a válasz architektúrát befolyásol (pl.
   szükség lehet egy handoff-jegyzet automatikus beírására, mint a `handoff`
   skill csinálja kézi handoffnál).

4. A `.channels-config` provisioning ÚJRAFELHASZNÁLHATÓ-e plan-onként, vagy
   minden plan-nak saját, TARTÓS izolált configDir kell (nem egy megosztott,
   minden váltásnál felülírt `.channels-config`)? Javaslat: minden
   `ClaudePlan.configDir` MAGA egy tartós, planhez kötött könyvtár (az
   operátor ezt a mezőt már ma is közvetlenül egy meglévő, bejelentkezett
   configDir-ra mutatja a `claude-plans.ts` docstringje szerint -- "A `label`
   plusz a CLAUDE_CONFIG_DIR" -- tehát NEM az `ensureMainAgentIsolatedConfigDir`
   auto-provisionált, credential-mentes `.channels-config`-ja, hanem egy már
   VALÓDI, saját tokent hordozó dir). Ez konzisztens a sub-agent oldali
   `resolveAgentConfigDir`-ral, ami is direktben a plan `configDir`-jára
   mutat. **Következmény**: a main-agent rotáció ÚJ ágat igényel a
   `channels.sh`-ban ami nem az `ensureMainAgentIsolatedConfigDir` izolált
   (credential-less + flotta token) útját használja, hanem a
   `resolveMainAgentConfigDir`-hoz (explicit configDir) hasonlót, csak
   DINAMIKUSAN, `claude-plans-state.json.activePlanId` alapján -- ÚJ
   függvény kell, `resolveMainAgentConfigDir` mellé, ami a state fájlt
   olvassa. EZ a legfontosabb architekturális döntés amit implementáció
   előtt meg kell erősíteni (Nyitott kérdés #4).

5. A session-restart mechanikája (tmux kill + relaunch) a `channels.sh`
   struktúráján belül -- vagy egy ÚJ, dedikált script/route triggereli
   (`POST /api/claude-plans/rotate` a dashboardról ÉS a heartbeat-ből is
   hívható), vagy közvetlenül a `agent-process.ts`-ben lévő restart-logika
   bővül. Javasolt: dashboard API endpoint (`POST /api/claude-plans/rotate`,
   body: `{ targetPlanId }`), amit MIND a kézi dashboard-gomb, MIND a
   automata döntési logika (6.3) hív -- egy kódút, két hívó, nincs
   duplikáció.

### 6.6 Ütemezés

A döntési logika (6.3) futtatásának módja -- NE új launchd/cron mechanizmus
(a projektben nincs ilyen, lásd a Fable-kvóta terv másik szálának
megállapítását), hanem a MEGLÉVŐ scheduled-task / heartbeat infrastruktúra:
egy `heartbeat` típusú scheduled task (`POST /api/schedules`, lásd a fő
CLAUDE.md "Ütemezett feladatok" szekció), pl. 10 percenként, ami:

1. Lefuttatja `python3 scripts/usage-collect.py --json` -t.
2. A kimenetet átadja a `claude-plan-rotation.ts` döntési logikájának (ez
   egy kis TS/node script-belépési pont kell hozzá, mert a heartbeat
   promptból egy shell-parancsot hívunk, ami node-ot futtat -- NEM importál
   ide semmit közvetlenül a Claude-session promptjából).
3. Frissíti a `claude-plans-state.json`-t az aktív plan bejegyzésével.
4. Ha a döntés `rotate`, hívja a `POST /api/claude-plans/rotate` endpointot
   és küldi a Telegram-jelzést.

Ugyanaz a heartbeat akár egybe is vonható a Fable-kvóta szál
`usage-collect.py` ütemezésével (mindkettő ugyanazt a scriptet futtatja) --
ez összehangolási pont a két párhuzamos szál között, NEM ezen terv dönti el
egyedül. Jelöld a PR leírásban, hogy koordinálni kell a másik (overview)
szállal, nehogy két külön heartbeat fusson feleslegesen ugyanarra a scriptre.

## 7. Dashboard Settings UI

Backend: bővítsd a `GET /api/claude-plans`-t (`src/web/routes/agents.ts:745`)
egy `POST`/`PUT`/`DELETE /api/claude-plans`-szal (CRUD a `claude-plans.json`-
on, ugyanazzal a validációval mint `resolveClaudePlans`/`validatePlan`, hogy
a write oldal SOHA ne tudjon érvénytelen bejegyzést menteni). Plusz:

- `GET /api/claude-plans/state` -- a `claude-plans-state.json` kiolvasása
  (aktív plan + minden plan utolsó megfigyelt %-a), a dashboard kártyáknak.
- `POST /api/claude-plans/rotate` -- lásd 6.5/5.
- Új settings-kapcsoló a `settings-store.ts` definíciós listájában:
  `CLAUDE_ROTATION_ENABLED` (bool, default '0'), ugyanaz a felülírás-sorrend
  mint a többinél (override > .env > default).

Frontend: a jelenlegi dashboard szerver-oldali renderelt HTML-mintát követve
(`src/web/dashboard-settings.ts`), egy új szekció a Settings oldalon:
plan-lista (label, típus, aktív-e, utolsó ismert %), "+ Új plan" form
(label, configDir path, personal/team), és egy be/ki kapcsoló "Automata
rotáció" címkével -- ami a `CLAUDE_ROTATION_ENABLED` settingre ír. A pontos
CSS/layout illesztést az implementáló nézze meg élőben a Settings oldalon
mielőtt kódot ír (ne találja ki a meglévő stílust).

## 8. Tesztelési terv

Pure-function egységtesztek (a `quota-gate.test.ts` / `quota-gate-wiring.test.ts`
mintájára, NEM fs/network mock-kal, hanem tiszta bemenet/kimenet):

- `estimateWindowFree`:
  - nincs korábbi megfigyelés -> 100 (fail open)
  - reset még nem jött el -> `100 - usedPercent`, pontos határeset
    (`now === resetsAtMs - 1`)
  - reset PONT most jött el (`now === resetsAtMs`) -> 100 (a
    `readWindow`/`expired` mintát követve a `src/web/quota.ts`-ből: `<=`,
    NE `<`, hogy a határeset konzisztens legyen a meglévő kóddal)
  - reset már régen elmúlt (több ablak is lezajlott inaktívan) -> 100
- `pickRotationTarget`:
  - üres candidate lista -> null
  - egyetlen candidate (maga az aktív, kizárva) -> null
  - két candidate, egyértelmű győztes
  - döntetlen (két azonos `freeFivePct`) -> determinisztikus, dokumentált
    tie-break (pl. plan id ábécésorrend), NE `Array.reduce` véletlenszerű
    forrás-sorrend-függése
- Döntési logika (6.3) mint egy `decideRotationAction`-szerű pure export,
  a `quota-gate.test.ts` stílusában: minden ág (nincs nyomás / near-reset
  halasztás / nincs alternatíva / sikeres cél) külön eset, boundary értékekkel
  (90.0% pontosan, 89.99%, near-reset határ pontosan 30 percnél).
- `claude-plans-state.json` írás/olvasás: atomikus write teszt (konkurens
  írás nem csonkíthatja a fájlt) -- mintázat: keresd meg hogyan teszteli ezt
  a `writeJsonAtomic`-hoz tartozó meglévő teszt, ha van, és kövesd.
- Integrációs/wiring teszt (mint `quota-gate-wiring.test.ts`): a heartbeat
  script tényleg meghívja a döntési logikát ÉS a `usage-collect.py --json`
  kimenetét helyesen parse-olja (fixture JSON-nal, nem élő hívással).
- A `POST /api/claude-plans/rotate` route: happy path + "nincs ilyen
  targetPlanId" + "rotáció letiltva" (400/409-szerű elutasítás) esetek.

NEM kell (és NE írj) tesztet ami tényleges tmux session-t indít/állít le --
azt kézzel kell staging-en kipróbálni, a meglévő `scripts/__tests__/
channels-mcp-unlock.test.sh` stílusú shell-tesztek CSAK a pure parsing/
classifier részeket fedik, a live restartot nem.

## 9. Javasolt PR-bontás

- **PR2a**: `claude-plan-rotation.ts` (pure logika) + tesztek. Semmi wiring,
  semmi UI. Review-olható önmagában.
- **PR2b**: write API (`POST/PUT/DELETE /api/claude-plans`, `GET .../state`)
  + dashboard UI. Rotáció még mindig NEM automatikus, csak kézi
  szerkesztés/megtekintés.
- **PR2c**: `POST /api/claude-plans/rotate` + a `channels.sh` dinamikus
  configDir-ág (6.5/4) + heartbeat wiring + Telegram-jelzés. Ez a
  legkockázatosabb rész (élő session-restart), staging-en alaposan
  kipróbálandó mielőtt a `CLAUDE_ROTATION_ENABLED` bárhol '1'-re kerül.
- **PR3** (később, nem ez a terv): drift-detection (`expectedOrgType`/
  `expectedEmail`).

## 10. Nyitott kérdések -- MIND ELDÖNTVE (Kobza Attila, 2026-09-12)

1. **Sub-agentek is rotálnak, nem csak a fő-agent.** Indoklás (Attila): "hisz
   minden leáll" -- egy sub-agent, aminek elfogy a saját plan-je, ugyanúgy
   némán leállna, mint a fő-agent. Következmény: `store/claude-plans-state.json`
   `activePlanId` mezője AGENSENKÉNT kell, nem egy globális érték (lásd 5.2
   frissítés lentebb). A pure `claude-plan-rotation.ts` (PR2a) modult ez nem
   érinti, mert az már eleve agent-agnosztikus (plan-szintű bemeneteket kap).
   A wiring (PR2c) fut le agentenként, nem egyszer a flottának.
2. **Igen, be van kapcsolva.** Leellenőrizve (2026-09-12): `MAIN_AGENT_ISOLATED_CONFIG=1`
   szerepel a `.env`-ben ezen a gépen. Viszont `store/claude-plans.json` MÉG
   NEM létezik -- 0 regisztrált plan. Attila vállalta, hogy ő regisztrálja a
   planeket (kézzel, `claude setup-token`-nel bejelentkezett configDir-okkal),
   ez nem blokkolja a PR2a/PR2b kódolását.
3. **Elfogadva, MEGOLDVA más szálon.** A session-kontextus nem vész el: a
   folyamatban lévő, sub-agenteknél már működő "continue-respawn" mechanizmus
   (model-fallback-runner.ts) a fő/channels session-re is ki lesz terjesztve
   (döntés 2026-09-11 este, külön szál, lásd project memory
   `project_key_rotation_main_session_continuity`). A 6.5/3 pontban leírt
   "FRISS, előzmény nélküli session" kockázat emiatt NEM áll fenn -- ezt a
   6.5 szekció frissítése tükrözi majd, amikor a wiring (PR2c) készül.
4. **Manuális, tartós per-plan configDir -- NINCS auto-provisionálás.**
   Minden plan-t Attila saját maga vesz fel `claude setup-token`-nel egy
   külön, már bejelentkezett configDir-ba (a `claude-plans.ts` docstringje
   szerinti út). A rendszer sosem provisionál automatikusan új configDir-t
   plan-hez.
5. **Eligibility = amit Attila felvett.** Nincs külön team/personal szűrés a
   `pickRotationTarget` candidate-listáján túl azon, hogy `channelsAllowed`
   valóban be van-e állítva a regisztrált plan-en (ez a mező marad a
   guardrail, ahogy a `claude-plans.ts` docstringje is írja). Attila
   válasza ("amiket felvettem claude setup-token-el") azt jelenti: minden,
   amit ő regisztrál, eleve szándékosan rotáció-célpont -- nincs plusz,
   rejtett szűrési szabály amit ki kellene találni.

Implementáció ELINDULT 2026-09-12: PR2a (`src/claude-plan-rotation.ts` +
`src/__tests__/claude-plan-rotation.test.ts`) kész, tesztek zöldek,
`tsc --noEmit` tiszta. PR2b/PR2c (write API, UI, wiring, agentenkénti state)
még nincs elkezdve.
