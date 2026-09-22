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

## Token a felületen, és a szerző ("Ki vagy")

A `web-crm/` ugyanúgy veszi át a tokent, mint a dashboard: egyszer az URL `?token=<dashboard token>`
paraméteréből (a böngésző a paramétert azonnal eldobja a címsorból, a token localStorage-ba kerül,
kulcs `marveen-crm-token`), utána minden same-origin `/api/` hívás `Authorization: Bearer`-rel megy.
Token nélkül a Ma nézet üres és kimondja, hogy miért (401), nem példaadatot mutat.

A szerző (döntés 2026-09-22, a felbontás-fájl 4. szakasza): a KÉRÉS hordozza, a törzs `actor`
mezőjében. A fejléc "Ki vagy" mezője tölti, nézőnként localStorage-ban (`crm.actor`); üresen a
Lead felvétele gomb tiltott, de az első tanú a szerver: üres vagy csak-whitespace `actor`-t a kapu
400-zal megtagad. A szolgáltatás SOHA nem tölt szerzőt konfigból vagy konstansból (nincs
`CRM_ACTOR`, nincs `system`). Ugyanez a szabály minden író végpontra.

Élő a felületen: `POST /api/leads` (Lead felvétele), `GET /api/leads/today` (Ma). Még példaadat:
a Leadek lista (nincs lista-végpont az 1. ütemben) és a Szál (CRM1MAILSYNC922).

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

## Levél-szinkron (CRM1MAILSYNC922)

```bash
npm run crm:sync                 # = node dist/crm/sync.js ; --gmail-only | --imap-only
```

Két forrás, egy közös alak (`src/crm/mail-model.ts`), idempotens upsert a `messages`/`threads`
táblákba. Kulcs az RFC Message-ID (UNIQUE) ÉS `UNIQUE(source, source_uid)`; újraszinkron = frissítés,
sosem duplikátum. **Lead SOSEM szinkronból**: a futás a `leads` darabszámát előtte-utána méri, és
eltérésnél 5-ös kilépési kóddal bukik; kontaktot sem hoz létre (a szál csak MEGLÉVŐ kontakthoz kötődik,
a `contact_emails` egyezése alapján).

- **Gmail, az asszisztensi fiók** (`~/.gmail-mcp/credentials.json` refresh_token + `gcp-oauth.keys.json`,
  nyers API, MCP nélkül; az access token csak a futás memóriájában él). Alapértelmezett lekérdezés
  `newer_than:30d` (a `store/crm-sync-state.json`-ban módosítható), lapozás a végéig. A személyes fiókból
  továbbított levél az `X-Forwarded-To` fejlécről ismerszik meg: `source = gmail_forwarded_personal`, az
  EREDETI Message-ID-vel, tehát ugyanaz a levél a support@-on át is EGY sor marad.
- **support@ IMAP** (`scripts/crm/support-imap-dump.py`: a `scripts/support-mail/lib.py` konfigjával,
  `SUPPORT_MAILBOX` + `SUPPORT_VAULT_KEY` a telepítés `.env`-jéből vagy env-ből, a jelszó a vaultból a
  folyamaton BELÜL; `select readonly`, `BODY.PEEK[]`, semmit nem jelöl olvasottnak). INBOX -> `in`,
  INBOX.Sent -> `out`. Konfig nélkül FAIL-CLOSED (exit 3), semmit nem tölt le.
  A dumper gyerek-folyamat időkorlátja `CRM_IMAP_DUMP_TIMEOUT_MS` (alap 600 000 ms; mérve ~175 ms/levél,
  tehát az első, 500-as futás két postaládán ~175 s). **A levágott vagy hibával kilépett dump sorai
  ALKALMAZÓDNAK** (a UID csak nő, adat nem vész el), de a futás `rc 4`, a `last_error` a state-ben és a
  `GET /api/sync/status`-ban kimondja, hogy RÉSZLEGES; `last_error` csak tiszta (exit 0, nem ölt) gyereknél null.
- **Szál-kulcs**: `gmail:<threadId>` ha van; különben `refs:<a References-lánc gyökere>`, annak híján
  `In-Reply-To`, annak híján a saját Message-ID. **A support@ Sent-másolatnak ma nincs Message-ID-je**
  (mérve 2026-09-22): az ilyen sor `synthetic:imap_support:INBOX.Sent:<uid>` azonosítóval, szál NÉLKÜL kerül
  be, és a `GET /api/messages/unthreaded` kimondja, hogy nem szálazható, amíg a küldő nem ír Message-ID-t.

Végpontok (bearer): `GET /api/threads?q=<cím vagy tárgyrészlet>`, `GET /api/threads/:id`,
`GET /api/messages/unthreaded`, `GET /api/sync/status`. **A Szál képernyő ezekre ül** (kereső a címre vagy
tárgyrészletre, szál-lista, idővonal be/ki iránnyal, a nem szálazható másolatok külön, a végpont mondatával);
példaadat sehol nincs, token nélkül a listák üresek és a notice mondja meg, miért. **Ami NEM látszik, és a
Szál nézet fejlécében áll:** a személyes Gmail-fiók küldöttjei és a Resend-en kimenő aiam-levelek.

## Amit ez az ütem NEM tartalmaz

Lead-felvétel végpont és kapu (CRM1LEADKAPU922), levél-szinkron és élő Szál (CRM1MAILSYNC922),
küldés bármilyen csatornán, launchd/systemd unit a CRM-hez (külön tétel), pénz-adatok betöltése (3. ütem).
