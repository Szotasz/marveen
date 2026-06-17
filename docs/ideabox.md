# Ötletláda

Az ötletláda egy könnyű ötletgyűjtő és -priorizáló rendszer, amely a Marveen dashboardon él. Az ötletek kanban-kártyává válhatnak, AI-segítséggel alfeladatokra bonthatók, és impact×effort pontozással rangsorolhatók.

## Használat

### Státuszok és szűrés

Az ötletek négy állapot egyikében lehetnek: **new** (beérkezett), **reviewed** (értékelt, de még nem futó feladat), **kanban** (promótálva, már kanban-kártya), **rejected** (elutasítva). Az ötletláda alapértelmezetten az aktív nézetet mutatja (new + reviewed egyszerre). A szűrő-füllel válthatod a nézetet:

- **Aktív** -- new + reviewed, ezeken dolgozol
- **Kanbanon** -- promótált ötletek, ahol már fut a feladat
- **Elutasítva** -- nem tűnnek el; visszakeresheted, miért döntöttetek nemmel

### Komment-szál

Kattints az ötlet nevére a részlet nézet megnyitásához. Az oldal alján megjelenik a komment-szál, ahol megjegyzéseket, döntési indoklásokat fűzhetsz az ötlethez. A review-vita így az ötletnél marad, nem szóródik szét a chat-előzményekben.

### Impact×Effort pontozás

Az ötlet részlet nézetében két mezőt tölthetsz ki:

- **Impact** (1-5): mekkora értéket teremt az ötlet megvalósítása -- 5 a legnagyobb
- **Effort** (1-5): mennyi munkát igényel -- 5 a legtöbb

A **score** = Impact - Effort. Pozitív szám: nagy érték, kevés munkával. Az ötletkártyán megjelenik az `I{n}·E{n}` badge a score-ral. Ha nem töltöd ki, az ötlet pontozatlan marad és nem kerül be a napi javaslatba.

**Mire jó a pontozás?** A rendszer naponta összeállít egy top-3 javaslatot a nyitott feladatokból és ötletekből. Ha egy ötlet score-ja eléri a 2-t, bekerülhet ebbe a listába -- így az értékes, de még nem indított ötletek nem merülnek el a backlogban.

### AI-bontás és promóció

Ha egy ötlet elég konkrét, a "Lebont" gombbal AI-segítséggel alfeladatokra bonthatod. Az AI javaslatait szerkesztheted és jóváhagyhatod -- ezután egyetlen kattintással kanban-kártyák jönnek létre belőlük. Ha az ötlet annyira egyértelmű, hogy nincs szükség bontásra, a "Promótálás" gombbal közvetlenül kártyává alakítható.

**Siker-kritérium megadása:** AI-bontásnál a jóváhagyás előtt megadhatsz egy rövid siker-kritériumot ("mikor tekintjük késznek?"). Ez automatikusan bekerül a létrehozott szülő kanban-kártya leírásába, hogy a végrehajtás során mindenki tudja, mi a "kész" definíciója.

### Elavult ötletek

Ha egy ötlet sokáig (alapértelmezetten 7 napig) nem változott és még nincs értékelve, az ötletkártyán narancssárga bal szegély és "Elavult" felirat jelenik meg. Ez nem tilt semmit -- csak emlékeztet, hogy érdemes dönteni róla: értékelni, elutasítani, vagy ha már nem aktuális, törölni.

### Mi történik, ha egy promótált ötlet kártyája elhal?

Ha egy korábban promótált ötlet kanban-kártyáját törlik vagy archiválják, az ötlet automatikusan visszakerül "reviewed" státuszba -- mintha újra az értékelt, de még nem futó ötletek közé kerülne. Így az ötlet nem vész el: újra megfontolható más időpontban, más kontextusban. A visszavonás manuálisan is elvégezhető az ötlet részlet nézetéből.

### Státusz-előzmény

Az ötlet részlet nézetében megtekinthető az összes státuszváltás naplója: ki változtatta, mikor, és melyik állapotból melyikbe. Ha egy döntés indoklása kimaradt a komment-szálból, a napló legalább rögzíti, hogy mikor és ki változtatta az állapotot.

---

## Státusz-életciklus

```
new → reviewed → kanban
              ↘ rejected
```

- **new**: beérkezett, még nem értékelt
- **reviewed**: értékelt, de még nincs kanban-kártya
- **kanban**: promótálva lett, `kanban_id` tartalmazza a kártya azonosítóját
- **rejected**: elutasítva, nem kerül tovább

A dashboard szűrője alapértelmezetten az "aktív" nézetet mutatja (new + reviewed együtt).

## Impact×Effort pontozás

Minden ötlethöz 1-5 skálán megadható:

- **Impact**: mekkora értéket teremt (5 = legnagyobb érték)
- **Effort**: mennyi munkát igényel (5 = legtöbb munka)
- **Score** = impact - effort (pozitív = nagy érték, kis munkával)

A score-badge az ötletkártyán jelenik meg (`I{n}·E{n}` formátumban). A Dream Engine Bucket 3 a magas score-ú (≥2) ötleteket beemeli a napi top-3 javaslatba.

## Komment-szál

Minden ötlethez kommentek fűzhetők az ötlet-részlet nézetből (cím kattintásra nyílik). A kommentek az `idea_comments` táblában tárolódnak, és az ötlet `updated_at` mezőjét is frissítik.

## AI-lebontás (breakdown)

A "Lebont" gomb meghívja `POST /api/ideas/:id/breakdown`-t, amely AI-segítséggel 3-N alfeladatot generál (alapértelmezett N=10). A max. alfeladatok száma (2-20) konfigurálható:

```bash
# .env-be, vagy a launchd plist-be:
IDEA_BREAKDOWN_MAX_SUBTASKS=8
```

Ez a kulcs a dashboard **Beállítások** felületén (Ötletláda szekció) is szerkeszthető; a config-réteg élőben olvassa, így a módosítás újraindítás nélkül érvényesül.

Az ötlet-nézet jóváhagyás után `POST /api/ideas/:id/promote-breakdown` hív, amely létrehozza a szülő kanban-kártyát és az alfeladat-kártyákat.

## Elavult (stale) ötletek

Ha egy `new` státuszú ötlet `updated_at` mezője régebbi, mint `IDEA_STALE_DAYS` napja (alapértelmezett 7), az API `stale: true` jelzőt ad vissza, és az ötletkártyán narancssárga bal szegély + "Elavult" badge jelenik meg.

```bash
# .env-be, vagy a launchd plist-be:
IDEA_STALE_DAYS=14
```

Ez a kulcs a dashboard **Beállítások** felületén (Ötletláda szekció) is szerkeszthető; a config-réteg élőben olvassa, így a módosítás újraindítás nélkül érvényesül.

## Audit trail (státusz-napló)

Minden státuszváltás rögzítve van az `idea_status_log` táblában: ki változtatta (actor), mikor, milyen állapotból és mibe, és opcionálisan egy rövid megjegyzés. Az API-n keresztül lekérdezhető:

```bash
GET /api/ideas/:id/status-log
# Válasz: { log: [{ id, idea_id, from_status, to_status, actor, note, created_at }, ...] }
```

## Promóció-körfolyamat (visszaút)

Ha egy `kanban` státuszú ötlet kanban-kártyáját törölik vagy archiválják, a rendszer automatikusan visszaállítja az ötletet `reviewed` állapotba (`kanban_id` törlödik, a váltás naplózódik). Manuálisan is visszavonható:

```bash
POST /api/ideas/:id/revert
# Csak 'kanban' státuszú ötleten működik; visszaállítja 'reviewed'-re és törli a kanban_id-t.
```

## Definition of Done (siker-kritérium)

A breakdown promóciónál megadható egy opcionális siker-kritérium szöveg. Ez a szülő kanban-kártya leírásának végéhez kerül `## Siker-kritérium` fejléccel. API-n keresztül:

```bash
POST /api/ideas/:id/promote-breakdown
{
  "subtasks": [...],
  "success_criteria": "A funkció tesztelve, dokkumentálva, és a staging-en fut."
}
```

## API-végpontok

| Módszer | Útvonal | Leírás |
|---------|---------|--------|
| GET | `/api/ideas` | Ötletek listázása (`?status=`, `?category=` szűrők; `stale` mező is megjelenik) |
| POST | `/api/ideas` | Új ötlet létrehozása |
| PUT | `/api/ideas/:id` | Frissítés (title, description, category, status, impact, effort) |
| DELETE | `/api/ideas/:id` | Törlés |
| GET | `/api/ideas/:id/comments` | Kommentek listázása |
| POST | `/api/ideas/:id/comments` | Komment hozzáadása |
| GET | `/api/ideas/:id/status-log` | Státusz-napló lekérdezése |
| POST | `/api/ideas/:id/revert` | Kanban -> reviewed visszavonás |
| POST | `/api/ideas/:id/promote` | Promóció kanban-kártyává (phase: `detail` vagy `plan`) |
| POST | `/api/ideas/:id/breakdown` | AI-lebontás generálása |
| POST | `/api/ideas/:id/promote-breakdown` | Kanban-kártyák létrehozása; fogadja `success_criteria` mezőt |

### Impact/effort validáció

Az `impact` és `effort` mezők 1-5 közé eső egész számot fogadnak el, vagy `null`-t. Az API 400-as hibával utasítja vissza az érvénytelen értékeket.

## Adatbázis-séma

```sql
-- idea_box (meglévő tábla, bővítve)
id TEXT PRIMARY KEY
title TEXT NOT NULL
description TEXT
category TEXT NOT NULL DEFAULT 'Egyéb'
status TEXT NOT NULL DEFAULT 'new'   -- new|reviewed|kanban|rejected
source TEXT NOT NULL DEFAULT 'manual'
kanban_id TEXT                       -- kitöltött ha status='kanban'
impact INTEGER                       -- 1-5, lehet NULL
effort INTEGER                       -- 1-5, lehet NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL

-- idea_comments (Fázis 1)
id INTEGER PRIMARY KEY AUTOINCREMENT
idea_id TEXT NOT NULL
author TEXT NOT NULL
content TEXT NOT NULL
created_at INTEGER NOT NULL

-- idea_status_log (Fázis 2 -- audit trail)
id INTEGER PRIMARY KEY AUTOINCREMENT
idea_id TEXT NOT NULL
from_status TEXT              -- NULL ha ez a létrehozás
to_status TEXT NOT NULL
actor TEXT NOT NULL DEFAULT 'system'
note TEXT
created_at INTEGER NOT NULL
```

Az `impact` és `effort` oszlopok `ALTER TABLE ... ADD COLUMN` migrációval kerültek be; az upgrade meglévő adatbázison is biztonságos (az `ALTER` kivételt dob ha az oszlop már létezik, ezt a kód elnyeli).

## Dream Engine integráció

A Dream Engine Bucket 3 (napi top-3 javaslat) a kanban-kártyák mellett lekérdezi az ötletládát is:

```sql
SELECT id, title, category, impact, effort, (impact - effort) AS score
FROM idea_box
WHERE status IN ('new','reviewed')
  AND impact IS NOT NULL AND effort IS NOT NULL
ORDER BY score DESC, impact DESC
LIMIT 5
```

Ha van ≥2 score-ú ötlet, legfeljebb egy bekerül a top-3-ba `[Ötletláda]` prefixszel jelölve.
