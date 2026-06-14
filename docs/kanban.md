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

### Dashboard kanban felület

A webes dashboard (`http://localhost:3420`) kártyaszerkesztőjének főbb viselkedései:

- **Komment-szerző default:** az új komment szerzőjeként az elsődleges humán felelős jelenik meg előre kiválasztva (az `owner` típusú assignee), nem a bot.
- **Alfeladat hozzáadás:** szülő-kártyánál (nem alfeladatnál) „Új alfeladat" form jelenik meg. Az új alfeladat a szülő aktuális státuszát örökli. `done` státuszú szülőhöz nem lehet alfeladatot hozzáadni.
- **Alfeladat törlés:** alfeladatok soránál Törlés gomb jelenik meg, megerősítő párbeszéddel. `done` státuszú szülőnél a gomb nem jelenik meg.
- **Szülő-feladat szerkesztése:** alfeladat részletező nézetében (`planned` és `waiting` státusznál) legördülő menüből a szülő-hozzárendelés módosítható vagy leválasztható. A menü a szülőt a kártya-tulajdonságok sorában mutatja, teljes szélességben.
