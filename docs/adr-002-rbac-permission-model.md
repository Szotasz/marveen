# ADR-002: RBAC Permission Model

**Dátum:** 2026-08-24
**Állapot:** Elfogadott
**Scope:** az access-control (RBAC + multi-tenant) réteg első lépése, a szerepkör-modell.

---

## Kontextus

A dashboard jelenleg egyetlen bearer token-nel (store/.dashboard-token) kapuzza az összes
`/api/*` útvonalat. Nincs szerepkör, nincs adatizoláció. A B2B pilot checklist és az
auditálhatóság megkövetelik, hogy különböző hozzáférési szinteket lehessen kiosztani tokeneknek
és session-felhasználóknak anélkül, hogy a futó flotta konfigurációját meg kelljen változtatni.

## Döntés

### Szerepkörök (4 szint)

| Szerepkör | Leírás |
|-----------|--------|
| `admin`   | Teljes hozzáférés minden tenanton és az `/api/admin/*` adminisztrációs felületen. |
| `agent`   | Fleet-agent scope: saját tenant, írási engedéllyel memóriákra, kanbanra, üzenetekre. |
| `read_only` | Csak GET műveletek: memóriák, kanban, ágensek, blackboard olvasása. |
| `viewer`  | Dashboard olvasás: memóriák, kanban, ágensek -- blackboard nélkül. |

### Jogosultsági mátrix

| Végpont-csoport | admin | agent | read_only | viewer |
|-----------------|-------|-------|-----------|--------|
| GET /api/memories/* | X | X | X | X |
| POST/DELETE /api/memories/* | X | X | | |
| GET /api/kanban/* | X | X | X | X |
| POST/PATCH/DELETE /api/kanban/* | X | X | | |
| GET /api/agents/* | X | X | X | X |
| POST /api/messages | X | X | | |
| GET /api/approvals | X | X | | |
| POST/PUT /api/approvals | X | | | |
| GET /api/blackboard | X | X | X | |
| POST /api/blackboard | X | X | | |
| /api/admin/* | X | | | |
| GET /api/federation/* | X | X | | |
| POST /api/federation/* | X | X | | |

### Implementáció

A `src/web/rbac.ts` fájl tartalmazza:
- `Role` és `Permission` TypeScript union type-okat
- `ROLE_PERMISSIONS` permission-set map-et (Role -> Set<Permission>)
- `hasPermission(role, permission)` segédfüggvényt
- `ENDPOINT_PERMISSION_TABLE` lookup tömböt (method + path prefix -> Permission)
- `resolveRequiredPermission(method, path)` segédfüggvényt a middleware számára

Az authorization middleware a következő sorrendben fog dolgozni:
1. `resolveAuth()` -- meglévő logika, nincs változás
2. `resolveRole(authResult)` -- role meghatározása (api_tokens tábla után; jelenleg fallback: token=admin, device=agent, session=viewer, federation=agent, none=deny)
3. `resolveRequiredPermission(method, path)` -- szükséges jogosultság
4. `hasPermission(role, permission)` -- engedélyezés vagy 401/403/503

## Backward-compat garancia

- A meglévő store/.dashboard-token bearer token az `admin` szerepkört kapja fallback-ként, amíg
  az `api_tokens` tábla be nem töltődik. Egyetlen curl hívás sem törik meg.
- A `device_keys` táblán lévő tokenek implicit `agent` szerepkört kapnak (D2 döntés: unifikáció a
  token-kezelési lépésben, de az implicit fallback már az authorization middleware-be kerül).
- Az `auth_sessions` session-cookie-val bejelentkező dashboard-felhasználók `viewer` szerepkört
  kapnak alapértelmezetten; adminisztratív jogkör explicit grant-tel adható az admin API-n.

## Miért ezek a határok?

**approvals:write csak admin:** A jóváhagyási döntések a fleet autonómia-szintjét érintik --
ez a repository tulajdonosának (repository owner) kizárólagos jogköre, nem delegálható ágenseknek.

**blackboard csak agent/read_only/admin, viewer nem:** A blackboard belső fleet-koordinációs
felület, nem publikus API. Egy külső viewer (B2B pilot) nem kap rálátást az ügynökök aktuális
állapotára.

**federation:write csak agent+:** A federációs inbox a peer-to-peer kommunikáció kapuja;
read_only/viewer tokenekkel inbound üzenet nem fogadható.

**admin:all külön Permission:** Az `/api/admin/*` namespace a token-rotációt, tenant-kezelést
és audit-exportot fogja tartalmazni. Egyetlen Permission-nel letiltható minden
nem-admin hozzáférés, nem kell enumerálni az admin végpontokat a ROLE_PERMISSIONS map-ben.

## Következő lépés

Authorization middleware, amely a `rbac.ts` exportjait használja, fail-closed
(401/403/503), backward-compat fallback-kel.
