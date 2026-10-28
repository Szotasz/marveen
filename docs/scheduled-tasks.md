# Ütemezett feladatok (scheduled tasks)

> Cron-alapú, fájlrendszer-vezérelt automatizációk -- minden feladat egy mappa, a runner 15 másodpercenként nézi és kézbesíti az ágens tmux session-jébe.

---

## Hogyan működik

A schedule runner a dashboard folyamatának részeként fut. 15 másodpercenként végignézi a `~/.claude/scheduled-tasks/` mappában lévő összes feladatot, és amelyiknek a cron kifejezése illeszkedik az aktuális percre, azt kézbesíti a megadott ágens tmux session-jébe mint szöveges promptot.

Kézbesítés után az ágens normál Claude Code session-ként dolgozza fel -- ugyanúgy, mintha te gépelted volna be a promptot.

```
15s tick → cron illeszkedés? → session él? → prompt kézbesítés
                                    ↓ nem
                              auto-start + retry queue
```

---

## Kézbesítési mód: inline vagy hivatkozás (SCHEDPROMPTREF917)

A tmux-on átmenő szöveg mérete okozott sérülést (összecsúszó mondatok, levágott
fejléc) a nagyobb feladatoknál -- a hiba nem a közeli tüzelésen, hanem
kizárólag a méreten múlt. Ezért a runner a feladat végleges szövegét
(`SCHEDULED_TASK_INLINE_MAX_CHARS` = 1500 karakter felett) NEM közvetlenül
gépeli be, hanem egy fájlba menti (`store/scheduled-runs/`), és csak egy
rövid, ~800 karakteres hivatkozást küld a tmux-on, amit az ágens `Read`-del
olvas be. A kis feladatok (pl. `ledger-live-drain`) változatlanul inline
mennek. Inline megy a nagy feladat is, ha a cél-ágens távoli hoston fut (a
fájl a dashboard hostján van, a távoli ágens nem tudná beolvasni).

A hivatkozás csak a `store/scheduled-runs/` könyvtár közvetlen, abszolút
útvonallal megadott fájljára érvényes. Minden más útvonalat (`..` szegmens,
a könyvtáron kívüli abszolút út) a runner elutasít és naplóz
(`scheduled-run reference rejected`), a feladat ilyenkor inline megy; az
ágens preambuluma ugyanezt a szabályt írja elő.

A fájl **immutable** (`<YYYYMMDD-HHMMSS>-<feladatnév>-<rand4>.md`), tartalmazza
a tüzelés pillanatában érvényes teljes szöveget (pre-check + SKILL.md-törzs +
metrics-blokk), és a jelenlegi biztonsági tag-scrub ugyanúgy lefut rajta, mint
korábban a tmux-ra menő szövegen. Megőrzés: óránkénti takarítás, 7 nap után
törlődik, de feladatonként a legutóbbi 20 mindig megmarad
(`scheduled-run-snapshot.ts`). Nincs a mentésben (`scripts/backup.sh`):
regenerálódik minden tüzeléskor.

**Méret-őr.** A SKILL.md-törzs hosszát a runner minden tüzeléskor méri
(`SCHEDULED_TASK_BODY_WARN_CHARS` = 20 000 karakter felett figyelmeztetés,
`MAX_SCHEDULED_TASK_PROMPT_LEN` = 50 000 felett riasztás, feladatonként
naponta legfeljebb egyszer). Mindkét szint a fő ágensnek megy belső
üzenetként; a tulajdonosi csatornára a méret-őr nem küld, az az ügyfelet
vagy pénzt érintő riasztásoké. A kézbesítés
mindkét esetben megtörténik -- a hivatkozásos út miatt a méret már nem
kézbesítési kockázat, csak jelzés, hogy a SKILL.md tanulságai (`Buktatók`
szekció) érdemes lenne `references/` alá mozgatni.

---

## Agents on the worksource channel

An agent can opt into the worksource channel (`worksourceChannel: true` in its
`agent-config.json`). For such an agent the scheduler delivers the prompt
differently:

- **Queued, not typed.** The prompt goes into the agent's worksource queue
  directory as an item, and the channel reader hands it to the agent as a real
  turn. Nothing is typed into its tmux pane.
- **Same prompt text.** The queued content is byte for byte the prompt the
  typed path would send, including the preamble, the delivery instruction and
  the task block.
- **Item meta.** The item carries `from: scheduler`, `message_id` (the item id),
  `task` and `category: scheduled-task`.

**Item id rule.** The id is `sched-<slug>-<hash8>-<stamp>`, so the same
occurrence never lands twice. The slug is the task name with every character
outside `A-Za-z0-9._-` replaced by `-`, cut to 60 characters; `<hash8>` is the
first 8 hex digits of the full name's SHA-256, so two names with the same slug
still get different ids. For a cron occurrence the stamp is the UTC minute
of the scheduled occurrence, date included (one item per scheduled minute). A
pending-retry fire stamps the retry row's `first_attempt` -- the time of the
first busy hit, not the scheduled minute, and one row per task and agent -- so
every retry of that row maps to the same item; it dedupes in practice because
the row exists only when the cron path did not queue the item, and it is a
dedupe key, not an occurrence key. A manual "Run now" gets its own id with its
own timestamp.

**The sender-role gate keeps the typed path.** An agent configured with
`senderRoleGate` still gets its scheduled prompts typed into its pane, even
with `worksourceChannel: true`. A queued item reaches the agent inside a
`<channel source="worksource" ...>` envelope, which the gate's hook treats as
a non-owner sender and answers by denying the configured risky tools; a typed
prompt carries no envelope and is treated as the owner. The item's
`from: scheduler` meta is not an owner credential -- anything that can write
the queue directory can set it -- so it is deliberately not used to lift the
gate.

**What does not apply.** The typing-specific machinery is skipped: the idle
wait before typing, the post-send resubmit chain, the delivery-integrity check
and the lost re-injection. The queue's reader owns the delivery from here: the
agent acknowledges each item with `work_complete`, and the reader re-offers any
item left unacknowledged past its timeout or across a restart.

**What still applies.** Every gate before the send runs unchanged (restart in
flight, missing session and auto-start, readiness and busy checks, forceSend
rules, usage limit, MCP pre-check). The busy-timeout alert also still applies:
if the agent stays busy long past the threshold, the watchdog alerts as usual.

**No extra rights.** The reader treats a `from: scheduler` item exactly like
any other routed item: same verbatim delivery, same provenance stamp, same
acknowledgment contract. Being sent by the scheduler grants the content
nothing.

---

## Fájlstruktúra

Minden feladat egy önálló mappában él:

```
~/.claude/scheduled-tasks/
  reggeli-napindito/
    SKILL.md          ← a prompt (YAML frontmatter + törzs)
    task-config.json  ← ütemezés, ágens, viselkedési flagek
  memoria-heartbeat/
    SKILL.md
    task-config.json
  ...
```

### SKILL.md

```markdown
---
name: feladat-neve
description: Rövid leírás arról, mit csinál ez a feladat
---

Az ágens ide kapja a promptot. Lehet több bekezdés, lista, utasítások --
ugyanúgy, mintha te gépelted volna be a chat-be.
```

### task-config.json

```json
{
  "schedule": "30 7 * * *",
  "agent": "jarvis",
  "enabled": true,
  "type": "task",
  "skipIfBusy": false,
  "forceSend": false,
  "createdAt": 1776153060
}
```

---

## Mezők referencia

### task-config.json mezők

| Mező | Típus | Alapértelmezett | Leírás |
|------|-------|-----------------|--------|
| `schedule` | string | `"0 9 * * *"` | Cron kifejezés (perc óra nap hónap hétnapja) |
| `agent` | string | főágens | A célpont ágens neve (pl. `"jarvis"`, `"rick"`) |
| `enabled` | boolean | `true` | Ha `false`, a runner átugorja |
| `type` | string | `"task"` | Lásd Feladattípusok |
| `skipIfBusy` | boolean | `false` | Ha `true` és a session foglalt, elveti a tickt |
| `forceSend` | boolean | `false` | Ha `true`, átugorja a busy-ellenőrzést, mindig kézbesít |
| `createdAt` | number | — | Unix timestamp (másodperc), automatikusan töltődik |
| `description` | string | — | Opcionális leírás (ha nincs SKILL.md frontmatter) |
| `targetSession` | string | — | Egyedi tmux session név override (alapból: `agent-<name>`) |

`command` típusú feladatoknál extra mezők:

| Mező | Típus | Alapértelmezett | Leírás |
|------|-------|-----------------|--------|
| `command` | string | — | Raw shell parancs (`bash -lc` alatt fut) |
| `timeoutMs` | number | `10000` | Timeout milliszekundumban |
| `failThreshold` | number | `2` | Ennyi egymást követő hiba után küld Telegram alertet |

---

## Feladattípusok

| Típus | Viselkedés |
|-------|------------|
| `task` | Mindig értesít Telegramon az eredménnyel |
| `heartbeat` | Csendes -- csak akkor ír Telegramon, ha a tartalom fontos/sürgős |
| `command` | Raw shell parancs, nem LLM -- csak a hibákról értesít (ha `failThreshold` átlépve) |

**Mikor melyiket?**
- `task`: reggeli összefoglaló, riport, egyszer futó fontos dolog
- `heartbeat`: 15-30 perces memória-audit, kanban-ellenőrzés -- nem akarod minden ticknél olvasni
- `command`: shell-szintű ellenőrzés (pl. disk usage, service ping) anélkül, hogy LLM token-t költenél

---

## Cron kifejezések

```
perc  óra  nap  hónap  hétnapja
  30    7    *      *         *    → minden nap 7:30
   0    8    *      *       1-5   → hétköznap 8:00
*/15   *    *      *         *    → 15 percenként
   0  8,12,16,20  *  *      *    → naponta 4-szer
   7    2    *      *         *    → hajnali 2:07
   0    9    *      *         1   → hétfőnként 9:00
```

A runner az Europe/Budapest időzónát használja (a node lokális TZ alapján).

---

## skipIfBusy vs. forceSend

Ez a két flag a foglalt session kezelését szabályozza:

- **Alapértelmezett (mindkettő false)**: ha a session foglalt, a feladat retry queue-ba kerül (SQLite). A runner minden ticken újrapróbálja, amíg a session felszabadul. Ha 1 óra után sem sikerül, Telegram alertet küld.

- **skipIfBusy: true**: a tick csendes elvesztése. Csak sűrűn ismétlődő feladatoknál helyes (15-30 percenként), ahol a következő tick úgyis jön. Napi/heti feladatnál soha ne használd.

- **forceSend: true**: átugorja a busy-ellenőrzést, beleküldi a promptot a tmux session-be. A Claude feldolgozza, amint az aktuális feladat elkészül. Kritikus feladatokhoz (pl. reggeli összefoglaló), amelyek nem maradhatnak ki.

---

## Busy-session kezelés és retry queue

Ha a célpont session elfoglalt és `skipIfBusy` nincs beállítva, a feladat bekerül a `pending_task_retries` táblába (SQLite, a dashboardon is látható). A runner minden 15s ticken újrapróbálja. Ha 1 órán túl is pending marad, Telegram alertet küld.

Ha a session egyáltalán nem fut:
1. A runner megpróbálja auto-startolni az ágenst
2. A feladat retry queue-ba kerül
3. Amint a session elindul és Claude betöltött, kézbesíti

---

## Auto-start viselkedés

Ha egy ütemezett feladatnak kellene futnia, de a célpont session nem létezik (pl. az ágens le volt állítva), a runner automatikusan elindítja az ágenst, majd retry queue-n keresztül kézbesíti a promptot. Ez biztosítja, hogy egy napjában egyszer futó feladat (pl. `0 2 * * *`) ne maradjon ki, ha az ágens éppen nem volt fut közben.

---

## Biztonsági korlátok

A prompt injektálás előtt egy "untrusted" preamble kerül eléje, hogy az esetleg felhasználói adatból érkező tartalom ne hajtson végre kód-injekciót az ágens context-jében. A maximális prompt hossz 50 000 karakter (~12K token) -- ennél nagyobb kérelmet a backend elutasít 413-mal.

### Forrás-oldali védelem: csak regisztrált feladat fut

A runner egy feladatot CSAK akkor indít (cron, catch-up, pending retry, "Run now"), ha a fájljainak sha256-ja
egyezik a szerver saját nyilvántartásával (`scheduled_task_registry` tábla a `store/claudeclaw.db`-ben, NEM a
`~/.claude/scheduled-tasks/` alatt). A hash a `SKILL.md` + `task-config.json` bájtjaiból készül, plusz a
feladatkönyvtár MINDEN további fájljából, rekurzívan (relatív úttal címkézve, hossz-keretezve; symlinknél a cél
bájtjaiból, hurok nélkül; fifo/socket csak a nevével), plusz a
`preCheck` szkriptből, ha van: relatív útnál a feladatkönyvtárhoz képest, abszolút útnál bárhol (egy `/tmp` alatti
vagy ügynök-könyvtárbeli szkriptet sem az útja tesz megbízhatóvá). Kivétel a telepítés saját repó-szkriptje: ami az
útja szerint ÉS a symlinkek feloldása után is a `<telepítés>/scripts/` alatt van (akár `{{PROJECT_ROOT}}/` alakban, akár a
seeder által abszolútra írva), az a kóddal együtt frissül, ezért nincs a hashben; a runner futtatás előtt ezt újra ellenőrzi. A kulcs a könyvtárnév,
nem a frontmatter `name`. A hash-elt `preCheck`-et a runner a beolvasáskor ellenőrzött bájtokból futtatja
(`bash -c <szkript> <út>`: a `$0` az út, a `BASH_SOURCE` üres), így a beolvasás után kicserélt szkript nem fut le, a
feladat abban a körben kimarad.

Ki regisztrál:
- `POST /api/schedules`, `PUT /api/schedules/<name>`, `POST /api/schedules/<name>/toggle`: az írás után PONTOSAN a
  most kiírt bájtokat (ha közben más is írt a könyvtárba, a hash eltér, és nincs regisztráció: 500); a `POST` ezen
  felül csak akkor regisztrál, ha az új könyvtárban a `SKILL.md`-n és a `task-config.json`-on kívül nincs más fájl;
- a dashboard saját default-seedere (`ensureDefaultScheduledTasks`);
- a flotta-import, szintén csak az általa kiírt bájtokat: ha a célkönyvtárban maradt más fájl (régi `SKILL.md`,
  egy `preCheck` szkript, bármilyen más fájl), a feladat regisztrálatlan marad, átnézésre;
- a telepítők és az `update.sh` az általuk ÚJONNAN létrehozott (teljes egészében szállított) feladatkönyvtárakra (a CLI-n át);
- az `update.sh` seed-frissítése (ami fájlonként frissít, a helyben módosított fájlt megtartja) egy frissített
  feladatot CSAK akkor regisztrál újra, ha (a) a frissítés ELŐTT `ok` volt (`verify`), vagy (b) a frissítés után
  a könyvtár MINDEN fájlja (a `references/` alattiak is) a mostani szállított tartalommal egyezik. A
  `references/` fájl frissítése és a hiányzó pótlása (SEEDREFDIR1018) ugyanebben a keretben történik: az
  ellenőrzés az első írás ELŐTT, az újraregisztráció az utolsó UTÁN, mert a hash a teljes könyvtárra
  vonatkozik. Minden más esetben regisztrálatlan marad
  (a runner kihagyja), és az `update.sh` kiírja, hogy kézi átnézés kell (a futás végén egy összesítő sorban
  is). Ha a CLI nem futtatható (az első, registry-s buildre frissítés még a régi dist-en fut), az ítélet
  ISMERETLEN: ilyenkor a dashboard egyszeri backfillje fogja regisztrálni (és a runner futtatni), ezért ezt a
  feladatot MOST kell átnézni. A regisztráció az adott feladat frissítése után azonnal megtörténik, nem a
  futás végén;
- a `scripts/migrate-main-agent-id.sh` az `agent` mező átírása után CSAK azt a feladatot regisztrálja újra,
  amelyik az átírás ELŐTT `ok` volt; a többit (regisztrálatlan vagy eltérő hash) kiírja átnézésre;
- a szerver saját átírásai (`src/web/schedule-registry-rewrite.ts`): az egyszeri
  (`once`) feladat első sikeres futás utáni kikapcsolása (`server:once-disable`) és a Claude-plan rotációs
  heartbeat be-/kikapcsolása CSAK akkor regisztrál újra, ha a feladat az átírás ELŐTT `ok` volt; a szerver által
  a kódjából most LÉTREHOZOTT rotációs feladat (`server:rotation-heartbeat`) seedként regisztrálódik;
- a `DELETE /api/schedules/<name>` törli a bejegyzést.

Ha a fájl az API megkerülésével jött létre vagy változott (kézi szerkesztés, `cp`, ügynök Write-ja), a runner
NEM indítja, és ha az eltérés a következő tickben (15 mp) is fennáll, egyszer figyelmeztet a logban és egy `[scheduler]`
üzenetben a fő-ágensnek (csak a feladat nevével, a tartalma nélkül); a feladatot nem törli, nem kapcsolja ki, és a
függő újrapróbáját is megtartja, amíg a feladat a lemezen van és engedélyezett. A `PUT` és a `toggle` ilyen feladatra 409-et ad,
hogy ne "mossa tisztára" az idegen tartalmat.

Feloldás, ha a változás jogos: mentsd a dashboardon/API-n át, vagy nézd át a fájlokat és regisztráld:

```bash
node dist/web/schedule-registry-cli.js status              # minden feladat: ok / unregistered / hash-mismatch
node dist/web/schedule-registry-cli.js verify <nev> ...    # kilépési kód 0 csak ha mind ok
node dist/web/schedule-registry-cli.js register <nev> ...  # a MOSTANI fájlok elfogadása
node dist/web/schedule-registry-cli.js register --all      # minden feladat elfogadása (előbb: status)
node dist/web/schedule-registry-cli.js unregister <nev>
```

Frissítés (egyszeri backfill): az első dashboard-indítás, amelyik már tartalmazza ezt a védelmet, a
runner indulásakor regisztrál MINDEN akkor a lemezen lévő feladatot (egyszer; a jelölő a
`scheduled_task_registry_state` táblában `upgrade-backfill-v1`), és a logba WARN szinten kiírja a neveket.
Ez ugyanaz a bizalom, amit a runner a frissítés előtt is megadott; utána már csak a fenti utak regisztrálnak.
Ha a backfill előtt gyanús feladat került a könyvtárba, a frissítés előtt nézd át (`ls ~/.claude/scheduled-tasks`).

A backfill jelölője a DB-ben van: egy újra létrehozott (törölt, üresről induló) `store/claudeclaw.db` mellett az első
indulás ISMÉT mindent elfogad, ami a lemezen van. DB-csere vagy -visszaállítás előtt nézd át a feladatkönyvtárat.

Korlátok:
- a hash a feladat SAJÁT könyvtárát fedi (és a `preCheck` szkriptet, bárhová mutat, a repó `scripts/` kivételével).
  Ha egy `command` vagy egy prompt egy MÁSIK feladat könyvtárába, vagy a repó `scripts/`-én kívül bárhová mutat,
  azt a tartalmat a nyilvántartás nem látta, és a védelem nem fedi;
- mivel a könyvtár minden fájlja a hash része, egy kézzel odatett fájl (akár egy szerkesztő mentési másolata,
  `.bak`, `.swp`) is megállítja a feladatot, amíg át nem nézed és újra nem regisztrálod;
- 500 bejegyzés vagy 16 MiB tartalom fölötti feladatkönyvtárnak nincs hash-e: nem regisztrálható és nem fut
  (a log egyszer kiírja);
- a nyilvántartás ugyanannak a felhasználónak írható DB-ben van, tehát a védelem a CSAK-fájl alapú
  telepítést zárja ki; egy feladat becsempészéséhez mostantól célzott DB-írás vagy CLI-hívás kell
  (a CLI-t egy ügynök Bash-ból is meghívhatja: ezt a kliens-oldali hook-kapu zárhatja);
- a bizalom-ellenőrzés és a szerver saját írása közti pillanatban (PUT, toggle, once-kikapcsolás), valamint a
  seeder és az `update.sh` írása és regisztrációja között egy PÁRHUZAMOSAN író, azonos felhasználójú folyamat
  tartalma is elfogadódhat; a hatókör a fájl-alapú elhelyezés, nem a versenyző helyi folyamat.

---

## API referencia

A dashboard Bearer tokennel védett (token: `store/.dashboard-token`).

```bash
TOKEN=$(cat /Users/jonasgergo/Documents/marveen/store/.dashboard-token)
```

### Lista

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/schedules
```

### Létrehozás

```bash
curl -s -X POST http://localhost:3420/api/schedules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "feladat-neve",
    "description": "Rövid leírás",
    "prompt": "A részletes prompt szövege amit az ágens megkap",
    "schedule": "0 8 * * *",
    "agent": "jarvis",
    "type": "heartbeat",
    "skipIfBusy": true
  }'
```

### Frissítés

```bash
curl -s -X PUT http://localhost:3420/api/schedules/feladat-neve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"schedule": "0 9 * * *", "enabled": true}'
```

Csak a megadott mezők frissülnek -- a többi változatlan marad.

### Törlés

```bash
curl -s -X DELETE http://localhost:3420/api/schedules/feladat-neve \
  -H "Authorization: Bearer $TOKEN"
```

### Enable / disable

```bash
curl -s -X POST http://localhost:3420/api/schedules/feladat-neve/toggle \
  -H "Authorization: Bearer $TOKEN"
```

### Azonnali futtatás (Run Now)

```bash
curl -s -X POST http://localhost:3420/api/schedules/feladat-neve/run \
  -H "Authorization: Bearer $TOKEN"
```

### Pending retry lista és törlés

```bash
# lista
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/schedules/pending

# egy pending retry törlése (id a lista válaszából)
curl -s -X DELETE http://localhost:3420/api/schedules/pending/42 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Dashboard

Az ütemezett feladatok vizuálisan is kezelhetők a dashboardon: http://localhost:3420/#schedules

- Feladatok listája (név, ágens, cron, típus, enabled állapot)
- Enable/disable toggle
- Run Now gomb (azonnali futtatás teszteléshez)
- **Futtatási előzmények (ℹ gomb)**: az utolsó 10 futtatás adatai -- pontos időpont, állapot, és közelítő tokenfogyasztás
- Új feladat varázsló: rövid leírásból AI-val kibővített promptot generál, interaktív cron-szerkesztővel
- Pending retries panel: a retry queue-ban várakozó feladatok, manuális törlési lehetőséggel

### Futtatási állapotok

| Állapot | Jelentés |
|---------|----------|
| `fired` / Rendben | A prompt sikeresen kézbesült az ágens session-jébe |
| `error` / Hiba | Kivétel keletkezett a kézbesítés során |
| `skipped` / Kihagyva | `skipIfBusy=true` és a session foglalt volt -- a tick szándékosan kihagyva |

Az előzmények az utolsó 30 napot tartalmazzák; régebbi sorok automatikusan törlődnek.

Az állapotok lekérdezhetők az API-n is:

```bash
TOKEN=$(cat store/.dashboard-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/schedules/reggeli-napindito/runs" | jq .
```

A tokenszám közelítő: az ágens teljes tokenforgalmát összesíti a futtatás pillanatától a következő futtatás kezdetéig (max. 1 óra). Ha az ágens ebben az ablakban más feladatot is végzett, az is beleszámít.

---

## Meglévő feladatok

| Feladat | Ágens | Ütemezés | Típus | Leírás |
|---------|-------|----------|-------|--------|
| `reggeli-napindito` | jarvis | `30 7 * * *` | task | Napi reggeli összefoglaló (email, naptár, AI hírek) |
| `memoria-heartbeat` | jarvis | `*/15 * * * *` | heartbeat | Memória-audit és skill reflexió 15 percenként |
| `kanban-audit` | jarvis | `0 8,12,16,20 * * *` | heartbeat | Kanban-tábla ellenőrzése naponta 4-szer |
| `dream-engine` | jarvis | `7 2 * * *` | dream-engine | Éjszakai analízis és javaslatgenerálás |
| `bumblebee-hygiene-scan` | jarvis | `0 9 * * 1` | heartbeat | Heti higiénia-ellenőrzés hétfőnként |
| `folyamatos-ellenorzes` | jarvis | `*/30 * * * *` | heartbeat | Általános ellenőrzés (jelenleg disabled) |

---

## Kapcsolódó dokumentumok

- [Háttér-feladatok](background-tasks.md) -- egyszeri, hosszú futású feladatok (nem cron-alapú)
- [Memória rendszer](memory-system.md)
- [Kanban](kanban.md)
