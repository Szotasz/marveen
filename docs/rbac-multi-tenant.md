# RBAC és Multi-tenant izoláció

Ez a dokumentum a dashboard hozzáférés-kezelési rendszerét írja le: ki mit láthat, hogyan
működnek a tokenek, és hogyan kerülnek egymástól elkülönítve az egyes tenantok adatai.

---

## Állapot (2026-08-24)

**Élesben, ma működik:**

- Szerepkör-modell definiálva (admin / agent / read_only / viewer) és betöltve
- `tenant_id` oszlop minden core táblán (`memories`, `kanban_cards`, `agent_messages`,
  `import_memories`); meglévő sorok automatikusan `"default"` tenanthoz kerültek
- Token-kezelés API teljes: létrehozás, rotálás, visszavonás, listázás
  (`/api/v1/admin/tokens`)
- Jogosultság-ellenőrzés **naplózó (shadow) módban** fut -- minden kérés átmegy, de a
  rendszer naplózza, mit utasítana el éles enforce esetén; blokkolás még nem történik

**Tervezett, következő fázisokban:**

- Tenant-enforcement bekapcsolása (RBAC_MODE=enforce): a lekérdezések ténylegesen
  tenant-hatókörre szűrnek, cross-tenant hozzáférés blokkolva lesz
- Tenant-kezelés API és `tenants` tábla (`/api/v1/admin/tenants`)
- Felhasználói role-kezelés (`dashboard_users` role+tenant_id migráció, first-user-wins
  bootstrap, `/api/v1/admin/users`)
- Token lejárat jelzése az admin felületen

A 3. és 4. szekció a tervezett végállapotot írja le; ahol a funkcionalitás még nem éles,
azt *[tervezett]* jelölés mutatja.

---

## 1. Szerepkörök és jogosultságok

A rendszer négy hozzáférési szintet különböztet meg.

### Admin

Teljes hozzáférés. Az admin minden tenant adatát látja és szerkesztheti, beléphet az
adminisztrációs felületre (`/api/v1/admin/*`), és kezelhet tokeneket, felhasználókat,
tenant-okat. A futó fleet-ügynökök (Jarvis, Zack stb.) bearer tokenje admin jogosultsággal
fut -- ez biztosítja, hogy a flotta konfigurációváltozás nélkül tovább működik.

### Agent

Egy tenant adataihoz teljes olvasási és írási hozzáférés: memóriák, kanban, ügynök-üzenetek,
blackboard. Nincs hozzáférés más tenantok adataihoz és az admin felülethez. B2B partnerek
alapértelmezett jogköre.

### Read-only

Csak olvasás: memóriák, kanban, ágensek és blackboard listázása. Sem létrehozás, sem törlés.
Alkalmas auditálási célú hozzáféréshez.

### Viewer

Dashboard megtekintés: memóriák, kanban és ágensek olvasása -- blackboard nélkül. Ez az
alapértelmezet, amikor egy új felhasználó regisztrál.

### Összefoglaló

| Funkció | admin | agent | read_only | viewer |
|---------|:-----:|:-----:|:---------:|:------:|
| Memóriák olvasása | X | X | X | X |
| Memóriák írása/törlése | X | X | | |
| Kanban olvasása | X | X | X | X |
| Kanban írása/törlése | X | X | | |
| Ágensek listázása | X | X | X | X |
| Üzenet küldése ágensnek | X | X | | |
| Jóváhagyások olvasása | X | X | | |
| Jóváhagyások írása | X | | | |
| Blackboard olvasása | X | X | X | |
| Blackboard írása | X | X | | |
| Admin felület | X | | | |

A jogosultsági modell részletes döntési háttere: [ADR-002](adr-002-rbac-permission-model.md).

---

## 2. Token-kezelés

### A jelenlegi bearer token

A rendszer telepítésekor a `store/.dashboard-token` fájl tartalmaz egy véletlenszerűen
generált bearer tokent. Ez a token admin szerepkörrel és globális (minden tenant feletti)
hozzáféréssel rendelkezik. A fleet-ügynökök ezt a tokent használják -- ez változatlan marad.

### API tokenek

Az admin a `/api/v1/admin/tokens` végponton kezelhet további tokeneket. Minden tokennek van:

- **neve** -- emberi olvashatóságú azonosító (pl. "acme-corp read-only")
- **szerepköre** -- admin / agent / read_only / viewer
- **tenant-hatóköre** -- melyik tenant adataihoz fér hozzá (globális admin esetén üres)
- **lejárati ideje** -- opcionális; ha nincs beállítva, a token nem jár le
- **visszavonási állapota** -- visszavont token azonnal érvénytelen, az adatok nem törlődnek

### Token létrehozása

```
POST /api/v1/admin/tokens
{
  "name": "acme-corp-agent",
  "role": "agent",
  "tenant_id": "acme-corp",
  "expires_at": "2027-02-24T00:00:00Z"   // opcionális
}
```

A válasz tartalmazza a token nyers értékét -- ez az egyetlen alkalom, amikor látható.
Mentsd biztonságos helyre; a szerver csak a hash-t tárolja.

### Token rotálása

```
POST /api/v1/admin/tokens/{id}/rotate
```

Új tokent generál, a régit azonnal visszavonja. A régi token azonnal érvénytelen lesz --
a beépítőnek az átállás előtt frissítenie kell a konfigurációját.

### Token visszavonása

```
PATCH /api/v1/admin/tokens/{id}
{ "revoked": true }
```

Azonnali hatályú. A visszavont tokennel érkező kérés 401-es hibát kap.

### Lejárati idő és monitoring

A lejárt token automatikusan érvénytelen; nincs szükség explicit visszavonásra.
A közelgő lejáratú tokenek dashboard admin felületen való jelzése *[tervezett].*

---

## 3. Tenant-izoláció modellje

*Ez a szekció a tervezett végállapotot írja le. A tenant-enforcement jelenleg shadow módban fut (csak naplóz, nem blokkol). Az éles kikényszerítés a következő fejlesztési fázisban kapcsolódik be.*

### Mi a tenant?

Egy tenant egy önálló adatszigetet jelent a rendszerben. Minden tárolt adat -- memóriák,
kanban kártyák, ügynök-üzenetek, import-forrásokból betöltött tartalmak -- egy konkrét
tenanthoz tartozik. Más tenant tokenjével ezek az adatok nem láthatók és nem módosíthatók.

### Hogyan fog működni az izoláció? *[tervezett]*

Minden core adattáblán (`memories`, `kanban_cards`, `agent_messages`, `import_memories`) van
egy `tenant_id` oszlop (ez már megvan). Az enforce fázis bekapcsolása után a rendszer minden
lekérdezésbe automatikusan beleszűr a hitelesítő token tenant-hatóköre alapján. Egy agent
szerepkörű token, amelynek tenant-hatóköre `"acme-corp"`, fizikailag nem tud más tenant sorát
visszaadni -- a szűrés az adatbázis-rétegben történik, nem az alkalmazás logikájában.

### Mit garantál az izoláció (enforce módban)? *[tervezett]*

- Egy tenant tokennel érkező lekérdezés csak az adott tenant adatait adja vissza.
- Más tenant adataira irányuló írási kísérlet 403-as hibát kap.
- Ha egy tenant le van tiltva, tokenjeivel minden kérés 403-as hibát kap -- az adatok
  nem törlődnek, csak a hozzáférés szűnik meg.
- Az admin szerepkör kivétel: a globális admin (tenant_id=NULL) minden tenant adatát látja.

### A meglévő adatok

A rendszer bevezetésekor minden meglévő sor a `"default"` tenanthoz kerül. A futó flotta
(Jarvis, Zack és a többi ágens) a `"default"` tenantot olvassa és írja -- ez változatlan marad.

### Mi nem izolált (tudatosan)

- Az ügynök-lista (`/api/v1/agents`) tenant-független -- minden hitelesített felhasználó
  látja, mely ágensek futnak. Ez szándékos: a fleet-státusz nem számít érzékeny adatnak.
- A blackboard szintén tenant-független olvasással rendelkezik agent és admin szerepkörök
  számára -- a fleet-koordináció megköveteli, hogy az ágensek lássák egymás állapotát.

---

## 4. B2B pilot bevezetési checklist

*Ez a checklist a tervezett végállapothoz készült. A tenant-kezelés API (`/api/v1/admin/tenants`) és a felhasználói role-kezelés (`/api/v1/admin/users`) jelenleg még nem éles -- az alábbi lépések az enforce fázis bekapcsolása után válnak elvégezhetővé.*

Egy új ügyfél-tenant felvétele előtt végezd el az alábbi lépéseket sorban.

### Előkészítés

- [ ] **Tenant-azonosító meghatározása.** Válassz egy egyedi, URL-biztos slug-ot
  (pl. `acme-corp`). Ez lesz a rendszerben a tenant belső azonosítója -- later nem
  módosítható (adatintegritás miatt).
- [ ] **Tenant létrehozása.**
  ```
  POST /api/v1/admin/tenants
  { "id": "acme-corp", "display_name": "Acme Corp" }
  ```
- [ ] **Agent token generálása a partnernek.**
  ```
  POST /api/v1/admin/tokens
  { "name": "acme-corp-agent", "role": "agent", "tenant_id": "acme-corp",
    "expires_at": "<90 nappal a mai dátumtól>" }
  ```
  A tokent biztonságos csatornán add át a partnernek (nem emailben nyílt szövegként).

### Ellenőrzés

- [ ] **Izolációs teszt.** Az új tokennel próbálj lekérdezni egy `"default"` tenant
  memóriát -- a válasznak üres listát kell adnia (nem 403-at, nem a default tenant adatait).
- [ ] **Írási teszt.** Az új tokennel hozz létre egy teszt kanban kártyát, ellenőrizd,
  hogy csak az `"acme-corp"` tenantban jelenik meg.
- [ ] **Lejárat ellenőrzése.** Győződj meg, hogy a token lejárati ideje be van állítva,
  és az admin felületen megjelenik.

### Dokumentáció és kommunikáció

- [ ] **Rotációs folyamat egyeztetése.** A partnernek tudnia kell, hogyan kérjen új tokent
  lejárat előtt (legalább 2 héttel). A rotáció API-n történik, az átállásra nincs kiesési ablak
  ha a partner a régi tokent a visszavonásig párhuzamosan használhatja.
- [ ] **SLA és adatmegőrzési feltételek rögzítése.** Mikor és hogyan törlődnek a tenant
  adatai szerződés megszűnésekor? A rendszer alapértelmezetten soft-delete-et alkalmaz
  (adatok megmaradnak, hozzáférés szűnik meg) -- a hard-delete külön, explicit kérelemre
  történik.
- [ ] **Audit log ellenőrzése.** Néhány teszt kérés után ellenőrizd az audit log-ban
  (`agent_audit_log`), hogy a `tenant_id` mezők helyesen töltődnek.

### Tenant letiltása (ha szükséges)

Ha egy B2B partner hozzáférését megszüntetni, a tokent vonsd vissza és a tenantot
tiltsd le:

```
PATCH /api/v1/admin/tokens/{id}        // token visszavonása
{ "revoked": true }

PATCH /api/v1/admin/tenants/acme-corp  // tenant letiltása
{ "disabled": true }
```

A partner adatai a rendszerben maradnak. Ha az adatok végleges törlése szükséges,
explicit törlési kérelem szükséges az admin felületen.

---

*Kapcsolódó dokumentumok:*
- [ADR-002 -- RBAC jogosultsági modell döntési háttere](adr-002-rbac-permission-model.md)
- [API deprecation policy](api-deprecation-policy.md)
