# Kanban + automatikus feladat-bontás

> Minden feladat egy kártyán él. Ha bedobsz egy nagy célt, az asszisztens magától részfeladatokra bontja.

---

## 🎯 Mit tud / miért érdekes

A flotta minden munkája egy **kanban-táblán** fut: a feladatok kártyák, státuszokkal (tervezett → folyamatban → várakozik → kész) és felelőssel (melyik ügynök csinálja). Ez adja a közös, átlátható munkateret — te bármikor látod min dolgozik ki.

Két dolog teszi különlegessé:

1. **Automatikus bontás:** ha egy nagy, homályos feladatot adsz ("csináljuk meg X-et"), egy LLM részfeladat-hierarchiára bontja, amit jóváhagyhatsz vagy módosíthatsz. Nem neked kell mikromenedzselni a lépéseket.
2. **Önjáró audit:** a rendszer 4 óránként átnézi a táblát — archiválja a régi lezárt kártyákat, és számon kéri a beakadt feladatokat a felelősön (a fokozatos autonómia szintje szerint).

**Kuriózum:** a kártyák és a státuszok automatikusan bekerülnek minden ügynök kontextusába, így mindenki tudja a teljes kép aktuális állását anélkül hogy külön rákérdezne.

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
