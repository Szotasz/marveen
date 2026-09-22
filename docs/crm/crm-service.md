# Marveen CRM service (1. ütem, váz)

Külön folyamat, külön port, saját adatbázis. A dashboard (3420) útját nem érinti.

## Indítás

```bash
npm run build          # a tsc a dist/crm/index.js-t is előállítja
npm run start:crm      # = node dist/crm/index.js
CRM_PORT=3425 npm run start:crm   # másik port (alapértelmezés 3421, csak 127.0.0.1)
```

A szolgáltatás FAIL-CLOSED indul: ha nincs `store/.dashboard-token` (vagy `DASHBOARD_TOKEN` env), nem
indul el (exit 3), és nem is gyárt tokent. A tokent a dashboard hozza létre az első indulásakor.

## Adat

- `store/crm.db`: a CRM saját SQLite tára (WAL). A sémát a szolgáltatás indításkor hozza létre
  `CREATE TABLE IF NOT EXISTS`-szel; a DDL forrása `docs/crm/CRM-1-UTEM-FELBONTAS.md` 2. szakasza
  (Samu), a kód `src/crm/db.ts`, és egy teszt méri, hogy a kettő szó szerint egyezik.
- `store/claudeclaw.db`: CSAK OLVASVA (`readonly: true, fileMustExist: true`). A CRM sosem ír bele;
  a teszt negatív kontrollja egy írási kísérlet, aminek buknia kell.

## Auth

Ugyanaz a bearer token és ugyanaz az ellenőrzés, mint a dashboardon (`checkBearerToken`,
`store/.dashboard-token`). `GET /health` auth nélkül válaszol; minden `/api/*` 401 token nélkül.

| útvonal | auth | válasz |
|---|---|---|
| `GET /health` | nincs | `{ok, service:'crm', crmDb, claudeclawReadOnly}` |
| `GET /api/status` | bearer | táblánkénti sorszám + a flotta-tár csak-olvasó próbája |
| `POST /api/leads` | bearer | 404, a kártya-azonosítóval: a végpont és a kapuja CRM1LEADKAPU922 (Geri) |
| `/`, `/app.js`, `/style.css` | nincs | a `web-crm/` statikus váza (négy képernyő), más fájl 404 |

## Bridge: a port bejegyzése (meglévő mechanizmus, új Bridge-funkció nem kell)

A Bridge a hoszt loopback-szolgáltatásait ssh-alagúton éri el; hogy MELYIK portokat, azt a
beléptetett kulcs `permitopen` listája dönti el az `authorized_keys`-ben, és ezt a listát KIZÁRÓLAG a
dashboard `/api/bridge/service-ports` végpontja írja (BRIDGEPORT817: validál, ledgerbe ír, értesít).
A CRM 1. ütemben ezért a teendő egyetlen bejegyzés, a telepítő oldalán:

```bash
# aktuális lista (a webPort mindig benne van, nem törölhető)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://127.0.0.1:3420/api/bridge/service-ports?install_id=<install-id>"

# a CRM port felvétele -- a PUT DEKLARATÍV: a TELJES kívánt listát küldd, ne csak az újat
curl -s -X PUT -H "Authorization: Bearer $(cat store/.dashboard-token)" -H "Content-Type: application/json" \
  "http://127.0.0.1:3420/api/bridge/service-ports" \
  --data-binary '{"install_id":"<install-id>","ports":[{"name":"crm","port":3421}]}'
```

Ami ettől történik a hoszton: a kulcs sora `permitopen="127.0.0.1:3420",permitopen="127.0.0.1:3421"`
alakra íródik át; a változás a KÖVETKEZŐ ssh-kapcsolatra él (az sshd auth-kor olvassa), ezért a Bridge
újracsatlakozik. Korlátok a szerveroldalon: csak explicit portok, 1024 alatt tilos, legfeljebb 12.
Ha `CRM_PORT` nem 3421, ugyanezt a portot kell bejegyezni.

## Amit ez az ütem NEM tartalmaz

Lead-felvétel végpont és kapu (CRM1LEADKAPU922), levél-szinkron és élő Szál (CRM1MAILSYNC922),
küldés bármilyen csatornán, launchd/systemd unit a CRM-hez (külön tétel), pénz-adatok betöltése (3. ütem).
