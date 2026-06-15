# Kanban + automatikus feladat-bontás

> Minden feladat egy kártyán él. Ha bedobsz egy nagy célt, az asszisztens magától részfeladatokra bontja.

---

## 🎯 Mit tud / miért érdekes

Nem kell mikromenedzselni a flottát — ez a kanban-rendszer lényege. Ha odadobsz egy nagy, homályos célt ("csináljuk meg X-et"), az ügynök magától részfeladat-hierarchiára bontja, kiosztja a megfelelő felelősnek, és nyomon követi. Te a végeredményt és a mérföldköveket látod, nem a belső lépéseket.

Két dolog teszi különlegessé:

1. **Automatikus bontás:** az LLM egy feladatból kártyák hierarchiáját csinálja (`parent_id`-vel összekötve), amit jóváhagyhatsz vagy finomíthatsz — nem kell fejből tartani a teendők sorát.
2. **Önjáró audit:** 4 óránként a rendszer maga átnézi a táblát — archiválja a régi lezárt kártyákat, és számon kéri a beakadt feladatokat a felelősön. Nem neked kell kopogtatni, hogy "na, hogy áll az a dolog?"

**Kuriózum:** a kártyák és státuszok automatikusan bekerülnek minden ügynök kontextusába. Nem kell külön tájékoztatni senkit arról, "hol tartunk" — mindenki látja a teljes képet, és ott folytatja, ahol a másik abbahagyta.

---

## 🛠 Hogyan működik

### Tárolás

SQLite (`store/`): `kanban_cards` (id, title, status, project, priority, assignee, sort_order, archived_at, időbélyegek) + `kanban_comments` (kártya-szintű napló).

- **Státuszok:** `planned`, `in_progress`, `waiting`, `done`
- **Prioritások:** `low`, `normal`, `high`, `urgent`

### Automatikus bontás

Új nagy feladatnál egy LLM-hívás (headless `claude -p` a meglévő előfizetésen át, nem külső API-kulcs) részfeladat-hierarchiát javasol `parent_id`-vel összekötött kártyákként. A felhasználó/orchestrator jóváhagyja, finomítja vagy elveti.

### 4 órás audit

Ütemezett feladat (8/12/16/20 órakor) egy állapot-fájlra (`last_audit_at`) támaszkodva:
1. 7+ napos lezárt kártyák archiválása.
2. Beakadt feladat = `in_progress`, ami az előző audit óta nem mozdult (`updated_at < last_audit_at`) → a felelős ügynöknek üzenet.
3. A viselkedést a [fokozatos autonómia](heartbeat-autonomy.md) szintje szabályozza (3: magától; 2: javasol; 1: csak jelez).

### Kanban-first munkamód

Minden projekt-feladat kártyán fut: az orchestrator kártyaként rögzíti, onnan delegálja a felelős ügynöknek (`assignee`), aki ott státuszol és kommentál vissza. A meta-feladatok (pl. maga az audit) nem kerülnek kártyára.

### Hozzáférés

Közvetlen SQLite, vagy a dashboard kanban-felülete. A kártya-állapot minden ügynök kontextusába automatikusan bekerül.

### WIP-limit (folyamatban lévő kártyák korlátja) -- technikai részletek

Minden kanban-oszlophoz beállítható egy maximális kártyaszám (Work In Progress limit). Ha a limit be van állítva, az oszlopfejlécben lévő kártyaszámláló `count/limit` formátumra vált, és a kihasználtság alapján változtatja a színét:

| Szint | Feltétel | Megjelenés |
|-------|---------|-----------|
| ok | < `WARN_PCT`% | sötétszürke, animáció nélkül |
| warn | >= `WARN_PCT`% (alapért. 80%) | sárga |
| full | pontosan 100% | narancs + enyhe pulzálás |
| over | > limit | piros + erős pulzálás + 10% méretnövekedés |

A badge az oszlopfejlécben lévő meglévő kártyaszámlálóba épül bele -- nincs külön HTML-elem.

**Konfigurációs kulcsok (`.env`):**

```
KANBAN_WIP_PLANNED=0        # 0 = korlát nélkül
KANBAN_WIP_IN_PROGRESS=0
KANBAN_WIP_WAITING=0
KANBAN_WIP_DONE=0
KANBAN_WIP_WARN_PCT=80      # %-os küszöb a sárga szinthez
KANBAN_WIP_OK_COLOR=#6b7280
KANBAN_WIP_WARN_COLOR=#c9a000
KANBAN_WIP_FULL_COLOR=#d46b00
KANBAN_WIP_OVER_COLOR=#c53030
```

Adatfolyam: `src/config.ts` → `/api/marveen` (`kanbanWip` kulcs) → `window._marveen.kanbanWip` (frontend). A frontend statikus, nincs build lépés -- szerver HUP elegendő a limitek megváltoztatásához.

### Dashboard kanban felület

A webes dashboard (`http://localhost:3420`) kártyaszerkesztőjének főbb viselkedései:

- **Komment-szerző default:** az új komment szerzőjeként az elsődleges humán felelős jelenik meg előre kiválasztva (az `owner` típusú assignee), nem a bot.
- **Alfeladat hozzáadás:** szülő-kártyánál (nem alfeladatnál) „Új alfeladat" form jelenik meg. Az új alfeladat a szülő aktuális státuszát örökli. `done` státuszú szülőhöz nem lehet alfeladatot hozzáadni.
- **Alfeladat törlés:** alfeladatok soránál Törlés gomb jelenik meg, megerősítő párbeszéddel. `done` státuszú szülőnél a gomb nem jelenik meg.
- **Szülő-feladat szerkesztése:** alfeladat részletező nézetében (`planned` és `waiting` státusznál) legördülő menüből a szülő-hozzárendelés módosítható vagy leválasztható. A menü a szülőt a kártya-tulajdonságok sorában mutatja, teljes szélességben.

### Beakadt kártyák vizuális jelzése

Minden nem lezárt kártyán automatikusan megjelenik, ha a kártya régóta nem mozdult:

**Bal oldali színes csík** -- az első ránézésre feltűnik:

| Szín | Mit jelent |
|------|-----------|
| Sárga | 1 napja nem változott -- érdemes szemmel tartani |
| Narancs | 3 napja nem változott -- hamarosan beavatkozást igényel |
| Piros (villog) | 1 hete nem változott -- beakadt, azonnali figyelem kell |

**Homokóra + napszámláló** (jobb felső sarok) -- pl. `⏳ 4d` = 4 napja nem mozdult. Hover-re megjelenik a pontos időpont, amikor utoljára változott.

A `done` státuszú kártyákon nem jelenik meg semmilyen jelzés -- csak az aktív feladatok öregszenek.

**Mire figyelj?** Ha a kanban táblán sok piros vagy narancs kártyát látsz, azokat érdemes sorban megnézni: vagy beakadt a feladat (az ügynök nem kapta meg, vagy elakadt), vagy le kell zárni, vagy törölni.

### Kártya-öregedés -- technikai részletek

A dashboard minden nem-lezárt (`done` kivételével) kártyán kiszámítja az öregedési szintet a `updated_at` unix timestamp alapján.

**Három szint, mindkettő egyszerre jelenik meg:**

| Szint | Default küszöb | Bal csík + jelvény |
|-------|---------------|-------------------|
| `warn` | 24 h | sárga |
| `caution` | 72 h | narancs |
| `critical` | 168 h (7 nap) | piros, pulzál |

**Megjelenítés:**
- Bal 3px csík (`border-left`) -- felülírja a prioritás-csíkot, `--card-aging-color` CSS custom property-vel.
- Jobb felső `⏳ Xd` / `⏳ Xh` jelvény -- hover tooltip pontosan mikor módosult.
- Kritikus szintnél enyhe CSS `animation: aging-pulse` a jelvényen.
- `done` kártyákon nem jelenik meg semmilyen jelző.

**Konfiguráció (`.env`):**

```
KANBAN_AGING_WARN_H=24
KANBAN_AGING_CAUTION_H=72
KANBAN_AGING_CRITICAL_H=168
KANBAN_AGING_WARN_COLOR=#c9a000
KANBAN_AGING_CAUTION_COLOR=#d46b00
KANBAN_AGING_CRITICAL_COLOR=#c53030
```

Értékek forrása: `src/config.ts` → `/api/marveen` (`kanbanAging` kulcs) → `window._marveen.kanbanAging` (frontend). A frontend statikus (`web/app.js`), nincs build lépés a küszöb-értékek frissítésekor -- szerver HUP elegendő.

### Oszloponkénti WIP-limit

A WIP-limit (Work In Progress limit) megmutatja, ha egy oszlop túlterhelt -- azaz több aktív feladat van benne, mint amennyit célszerű egyszerre kezelni.

**Mit látsz az oszlopfejlécben?**

Minden oszlop tetején egy kerek badge jelzi az aktuális állapotot, pl. `4/5` (4 kártya van, a limit 5). A badge színe a kihasználtság szerint változik:

| Badge | Mit jelent |
|-------|-----------|
| Szürke | Bőven van hely, minden rendben |
| Sárga | Közeledik a limit -- érdemes figyelni |
| Narancs | Egy lépésre a limittől -- új kártyát ne tegyél ide |
| Piros, villog | Túllépve -- az oszlop túlterhelt, oldj meg valamit mielőtt újat veszel fel |

**Mire figyelj?**

Ha egy oszlop piros badge-dzsel villog, ne vegyél fel oda új feladatot. Először zárj le vagy helyezz át egy meglévőt. A limit nem tiltja meg az új kártyák felvételét -- figyelmeztetés, nem zár.

**Hogyan állítható a limit?**

A WIP-limit oszloponként konfigurálható a `.env` fájlban (részletek a technikai dokumentációban). Ha az oszlopnak nincs beállított limitje, a badge nem jelenik meg.
