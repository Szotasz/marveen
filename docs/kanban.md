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
### Sávos nézet (Swimlane)

A swimlane nézet vízszintes sávokra bontja a táblát, hogy egy nagy oszlop helyett azonnal lásd, kinél vagy milyen prioritású kártyák torlódnak.

**Mit látsz?**

Csoportosítás bekapcsolásakor a kártyák oszlopok helyett (vagy azokon belül) vízszintes sávokba rendeződnek. Minden sáv elején egy "ragadó" (a görgetésnél mindig látható) fejléc áll:

- a felelős avatarja és neve (ha felelős szerint csoportosítasz), vagy a prioritás címkéje (ha prioritás szerint),
- a sávban lévő kártyák száma,
- egy kis nyíl (chevron) ikon, amivel a sáv összecsukható.

**Csoportosítás váltása**

A tábla feletti vezérlőben választhatsz, mi szerint bontsa sávokra a rendszer a kártyákat:

- **Felelős szerint** -- minden felelőshöz egy sáv, így egy pillantással látod, kinél mennyi van folyamatban.
- **Prioritás szerint** -- a kártyák `low`/`normal`/`high`/`urgent` sávokba kerülnek, így a sürgős feladatok nem tűnnek el a tömegben.

A választás a böngésződben megmarad, nem kell minden megnyitásnál újra beállítani.

**Sáv összecsukása**

Ha egy sáv jelenleg nem érdekes (pl. egy felelős minden kártyája lezárva), kattints a fejléc chevronjára -- a sáv összecsukódik, csak a fejléc (létszámmal) marad látható. Ugyanígy nyitható vissza.

**Mire jó?**

Nagy, sok kártyás táblánál a sima oszlopnézet könnyen átláthatatlanná válik. A swimlane nézet azonnal megmutatja a terheléseloszlást -- ha egy felelősnél (vagy egy prioritási szinten) feltorlódnak a kártyák, az első pillantásra látszik, mielőtt bele kellene olvasni mindegyikbe.

### Swimlane-ek -- technikai részletek

A kanban-tábla opcionálisan vízszintes sávokra (swimlane) bontható, két csoportosító mező közül választva: felelős (assignee) vagy prioritás. Alapállapotban (nincs csoportosítás) a tábla a megszokott 4 oszlopos elrendezést használja, változás nélkül.

**Felépítés csoportosított nézetben:**

Minden swimlane egy teljes szélességű sáv, amely a tábla mind a 4 státusz-oszlopát (tervezett/folyamatban/várakozik/kész) tartalmazza, de csak az adott csoportba tartozó kártyákkal. A swimlane előtt egy 44px magas fejléc-sáv jelenik meg:

- **Bal oldal:** 28px kör alakú avatar (a felelős típusa szerinti szín + kezdőbetű, vagy prioritás-szín jelölő, szöveg nélkül), majd a félkövér név/prioritás-címke.
- **Jobb oldal:** kártyaszám-badge (a swimlane összes kártyájának száma, az összes státuszban összesítve), majd egy chevron gomb (▼/▶) a sáv összecsukásához.

A fejléc `position: sticky` (top és left egyaránt), így vízszintes és függőleges görgetésnél is a látható területen marad. A swimlane-ek között 2px szaggatott elválasztó vonal van.

**Csoportosítás kulcsa:**

- **Felelős szerint:** a kártya `assignee` mezője alapján, a `/api/kanban/assignees` listával egyezés (kis- és nagybetű-érzéketlen), nem egyező vagy hiányzó felelős esetén "Nincs hozzárendelve" gyűjtő-sáv.
- **Prioritás szerint:** a kártya `priority` mezője alapján (`urgent` > `high` > `normal` > `low` sorrendben).

Az üres (kártya nélküli) swimlane-ek nem jelennek meg.

**Perzisztencia:**

A csoportosítás-választás `localStorage`-ban (`marveen.kanbanGroupBy` kulcs) tárolódik, így a felhasználó utolsó választása böngészőnkénti újratöltés után is megmarad, és felülírja a `.env`-ben konfigurált alapértéket. A sáv-összecsukás állapota viszont csak a böngészőlap memóriájában él (oldal-frissítésnél törlődik), a táblafrissítések (pl. kártya mozgatás, 30 másodperces auto-refresh) azonban nem törlik.

**Drag & drop:**

A meglévő kártyamozgatás logika (státusz + sorrend) swimlane-nézetben is működik, oszloponként -- a kártya az adott swimlane adott státusz-oszlopába húzható. Más swimlane-be húzás nem módosítja a kártya felelősét/prioritását, csak a státuszát.

**Konfigurációs kulcsok (`.env`):**

```
KANBAN_SWIMLANE_DEFAULT_GROUP=none         # none (alapért.) | assignee | priority
KANBAN_SWIMLANE_SEPARATOR_COLOR=           # üres = CSS alapszín (var(--border))
```

Adatfolyam: `src/config.ts` → `/api/marveen` (`kanbanSwimlanes` kulcs) → `window._marveen.kanbanSwimlanes` (frontend). A frontend statikus, nincs build lépés -- szerver HUP elegendő a beállítások megváltoztatásához.

### Gyors-szűrők és címkék

A kártyák elláthatók színes címkékkel, amik egyrészt vizuálisan csoportosítják a táblát, másrészt egy kattintással szűrhetők.

**Címke hozzáadása/levétele**

Nyiss meg egy kártyát, és a részletező nézet "Címkék" szekciójában:

- a legördülő menüből válassz egy meglévő címkét a kártyához rendeléshez,
- vagy hozz létre új címkét (név + szín a felkínált palettából),
- a hozzárendelt címkék mellett egy gombbal bármelyik levehető a kártyáról.

**Mit jelentenek a kártyák alján a pillék?**

Minden kártya alján legfeljebb 3 hozzárendelt címke jelenik meg hideg-tónusú "pilleként" (`#cimke-nev` formában, a címke saját színével). Ha egy kártyához 3-nál több címke van rendelve, a maradékot egy "+N" jelvény jelzi. Egy pillére kattintva azonnal rá is szűrhetsz -- a kártya összes többi, ugyanazzal a címkével ellátott kártyája is megjelenik a szűrt nézetben.

**Szűrés a fejléc chip-sorával**

A tábla feletti vezérlősorban minden létező címkéhez megjelenik egy chip, a saját színével és egy darabszámmal (hány kártyára illik a címke a jelenleg aktív többi szűrő mellett). Kattintásra a chip aktívvá válik, és csak az adott címkével ellátott kártyák látszanak. Több chip is kiválasztható egyszerre -- ezek "VAGY" kapcsolatban kombinálódnak (bármelyik kiválasztott címkével ellátott kártya megjelenik). Az × ikon egy aktív chipen levonja az adott szűrést, a "Szűrők törlése" gomb az összes aktív címke-szűrőt egyszerre üríti.

**Hogyan kombinálódik a többi szűrővel?**

A címke-szűrő a projekt- és felelős-szűrővel "ÉS" kapcsolatban van: a látható kártyáknak egyszerre meg kell felelniük a projekt-szűrőnek, a felelős-szűrőnek, ÉS legalább egy aktív címke-szűrőnek (ha van ilyen). Swimlane-nézetben a sávok már a megszűrt kártyahalmazból épülnek fel, így a két funkció zökkenőmentesen együttműködik.

A választott címke-szűrők a böngésződben megmaradnak, nem kell minden megnyitásnál újra beállítani.

### Gyors-szűrők és címkék -- technikai részletek

**Adatmodell:**

A címkék külön regiszterben élnek (`labels` tábla: `id`, `name`, `color`, `created_at`), és egy join táblán (`kanban_card_labels`: `card_id`, `label_id`, `created_at`) keresztül kapcsolódnak a kártyákhoz. Ez lehetővé teszi, hogy ugyanaz a címke több kártyán is szerepeljen, és egy helyen átszínezhető/átnevezhető legyen. Kártya vagy címke törlésekor a kapcsoló sorok tranzakcióban törlődnek, így nem marad árva join-bejegyzés.

A címke színe nem szabad szöveg: a `KANBAN_LABEL_COLORS` konfigurációs paletta egyik eleme lehet csak (szerver-oldali validáció, érvénytelen vagy hiányzó érték esetén a paletta első színére esik vissza). Ez biztosítja, hogy a szín-hozzárendelés egyetlen konfigurálható forrásból ered, nem egy kódba ágyazott leképezésből.

**API végpontok:**

```
GET    /api/kanban/labels              -- összes címke
POST   /api/kanban/labels              -- új címke ({ name, color })
PUT    /api/kanban/labels/:id          -- címke átnevezése/átszínezése
DELETE /api/kanban/labels/:id          -- címke törlése (+ minden kártya-kapcsolat)
GET    /api/kanban/:id/labels          -- egy kártya címkéi
POST   /api/kanban/:id/labels          -- címke hozzáadása a kártyához ({ labelId })
DELETE /api/kanban/:id/labels/:labelId -- címke levétele a kártyáról
```

A tábla-listázó `GET /api/kanban` minden kártyához becsomagolja a `labels` tömböt is, egyetlen bulk JOIN lekérdezéssel (nem N+1 kártyánkénti hívással), így a footer-pillek egyetlen körútból megkapják az adatot.

**Kártya-szerkesztő (CRUD UI):**

A kártya-részletező nézet "Címkék" szekciójában a hozzárendelt címkék eltávolítható pillékként jelennek meg, egy legördülő menü meglévő címkét ad hozzá, egy beágyazott form pedig új címkét hoz létre (név + paletta-színválasztó). A létrehozott címke azonnal hozzá is rendelődik a megnyitott kártyához.

**Gyors-szűrő (címke) chip-sor:**

A tábla feletti vezérlősorban, a projekt-szűrő mellett jobbra igazítva egy pill jelenik meg minden definiált címkéhez (`/api/kanban/labels` listából), a címke saját színével. Kattintásra a chip aktívvá válik (kitöltött szín + × ikon), és VAGY-kapcsolatban kombinálódik a többi aktív címke-chippel (több is kiválasztható egyszerre) -- ugyanaz a `kanbanLabelFilter` halmaz, amit a kártyák footer-pilljei is vezérelnek, csak két belépési ponttal. Minden chip mellett egy darabszám látható: hány kártya felelne meg ennek a címkének a JELENLEG aktív projekt/felelős szűrők mellett -- ez a szám független attól, hogy a chip maga aktív-e, így mindig informatív marad.

**Címke footer-pillek (kártyán):**

Minden kártya lábsorában megjelenik legfeljebb 3 hozzárendelt címke hideg-tónusú pilleként (`#címke-név` formátumban, a címke saját színével), a maradékot egy "+N" jelvény jelzi (nem kattintható). Egy konkrét pillére kattintás hozzáadja/leveszi az adott címkét az aktív címke-szűrőhöz -- ugyanazt a halmazt módosítva, amit a fejléc gyors-szűrő chip-sora is használ.

**Szűrő-kombináció szemantikája:**

Az összes szűrési dimenzió ÉS-kapcsolatban kombinálódik:

```
látható = projekt-szűrő ÉS felelős-szűrő ÉS (címke1 VAGY címke2 VAGY ...)
```

Egy üres címke-szűrő (nincs aktív címke kiválasztva) nem szűkít -- minden kártya megfelel ennek a dimenziónak. A swimlane-csoportosítás a már megszűrt kártyahalmazból dolgozik, így a gyors-szűrő és a swimlane-nézet automatikusan együttműködnek, külön integrációs kód nélkül. A vezérlősorban megjelenő "Szűrők törlése" gomb (csak akkor látható, ha legalább egy címke-szűrő aktív) üríti a halmazt.

**Perzisztencia:**

A címke-szűrő `localStorage`-ban tárolódik (`marveen.kanbanLabelFilter` kulcs, JSON-tömbként), ugyanazzal a mintával mint a swimlane-csoportosítás választása -- böngészőnkénti újratöltés után is megmarad.

**Konfigurációs kulcsok (`.env`):**

```
KANBAN_LABEL_COLORS=#3b82f6,#0ea5e9,#10b981,#14b8a6,#8b5cf6,#64748b  # választható paletta (hideg tónusok)
```

Adatfolyam: `src/config.ts` → `/api/marveen` (`kanbanLabels.colors` kulcs) → `window._marveen.kanbanLabels` (frontend).
