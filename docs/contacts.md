# Névjegyek (contacts)

Brainy saját névjegytára: név, e-mail, telefon, cím, szervezet, viszony, minden érték a forrásával és a forrás dátumával.

## Mit tárol, és mit nem

- Külön táblákban él (`contacts`, `contact_values`), nem a `memories`-ben: nem embeddingelődik, nem tükröződik a memóriába, és nem kerül a fleet-transfer exportba.
- Minden kapcsolatnak kötelező a tartománya: `business` vagy `family`. A keresés és a lekérés mindig egy tartományon belül fut; nincs "mindkettő" alapértelmezés, és a másik tartomány kapcsolata 404.
- Minden mezőérték külön sor, kötelező `source` (a címzett-ledger nyelvtana: `mail:<messageId>`, `crm:<ref>`, `owner`, `doc:<ref>`, `site:<url>`, `order:<id>`) és `source_date` mezővel. Forrás nélküli érték: 400.
- Az értékek append-only módon tárolódnak: UPDATE és DELETE triggerrel tiltott. Ütközésnél (két telefonszám) mindkettő megmarad a saját forrásával. Visszavonás csak új, `retracted` sorral, saját forrással.
- Keresni csak névre, szervezetre és megjelenített névre lehet (FTS); e-mailre, telefonra, címre nem.

## Ki férhet hozzá

- Csak az `X-Agent-Id: brainy` fejlécű hívás (pontos egyezés), minden más 403 és naplósor. Ez ÖNBEVALLOTT azonosítás, nem hitelesítés: a flotta közös Bearer tokent használ.
- Ezért minden olvasás (`contact_reads`) és minden írás (`contact_writes`: create, add, retract; a 404-es írási kísérlet, vagyis másik tartományú vagy nem létező névjegy/érték, `attempt` sort kap) auditsort kap: ki, mikor, melyik rekord. A listázás minden visszaadott kapcsolat azonosítóját külön sorban naplózza (üres találatnál egyetlen azonosító nélküli sor a kereséssel), a 404-es lekérés (nem létező vagy másik tartományú azonosító) is naplósort kap a kért azonosítóval, ugyanazzal a válasszal. Az érték soha nem kerül az auditba. Az audit-táblák is append-only-k.

## Ledger-kapcsolat

- Az API soha nem ír a `store/verified-recipients.json` ledgerbe: a hívó azonosítója önbevallott, ezért egy API-n felvett cím nem válhat a küldési kapu által megbízhatóvá. Névjegy -> ledger csak kézzel, a CLI-ből: `node scripts/contacts.mjs sync-ledger --domain business --id 12` (az aktív e-mail értékeket veszi fel `addRecipient`-tel, ugyanazzal a forrással, megjegyzés `contact:<id>`; a ledgerben már szereplő címet nem írja felül; ledger-hiba esetén 1-es kilépési kód).
- Ledger -> névjegy csak kézzel, megnevezett címekre, kötelező tartománnyal, alapból próbafutás:

```bash
node scripts/contacts-import-ledger.mjs --domain business --address a@pelda.hu          # dry run
node scripts/contacts-import-ledger.mjs --domain business --address a@pelda.hu --apply
```

## API

| Végpont | Leírás |
|---|---|
| `GET /api/contacts?domain=&q=&limit=` | keresés (domain kötelező; limit alap 10, max 50, `truncated` jelzi a levágást) |
| `GET /api/contacts/:id?domain=` | egy kapcsolat az értékeivel és forrásaikkal |
| `POST /api/contacts` | új kapcsolat (`domain`, `display_name`, opcionális kezdőértékek forrással) |
| `POST /api/contacts/:id/values` | új érték (`domain`, `field`, `value`, `source`, `source_date`; a `domain` kötelező, másik tartományú vagy nem létező névjegy ugyanaz a 404, a mezők ellenőrzése előtt) |
| `POST /api/contacts/values/:id/retract` | visszavonás (`domain` és `source` kötelező; másik tartományú vagy nem létező érték ugyanaz a 404) |

Megtévesztően hasonló (homoglifás) név vagy szervezet esetén a 201-es válasz `warning` mezőt kap; a felvételt nem blokkolja.

## CLI (Brainy)

```bash
node scripts/contacts.mjs add     --domain business --name "Minta Kft." --field email --value info@minta.hu --source mail:<messageId> --source-date 2026-10-22
node scripts/contacts.mjs value   --id 12 --field phone --value "+36 1 234 5678" --source doc:<ref> --source-date 2026-10-22
node scripts/contacts.mjs find    --domain business --q minta
node scripts/contacts.mjs show    --domain business --id 12
node scripts/contacts.mjs retract --domain business --value-id 34 --source owner --source-date 2026-10-22
```

A token a `store/.dashboard-token`-ből jön hívásidőben, és nem jelenik meg sem argv-ben, sem a kimenetben. Kilépési kód: 0 = 2xx, 1 = hibás válasz vagy hálózati hiba, 2 = hibás használat.
