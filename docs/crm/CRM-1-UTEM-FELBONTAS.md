# CRM 1. ütem: felbontás és kiosztás (Samu, 2026-09-22 18:4x CEST)

Mérvadó: workspace/CRM-FELULET-BRIEF.md (scope-váltás 18:22), Marveen sorrendje (28234), Geri kapu-specje (CRM-GERI-KAPUK-ES-NYOM.md 6. szakasz), Boni előfeltételei (28239), a rendszer-oldali terv (CRM-SAMU-RENDSZER-OLDAL.md). Ügyfélüzenet nem megy ki, éles adathoz írásra senki nem nyúl a gazda GO-ja nélkül.

## 1. Szerkezeti döntések (Samu, nem kérdés)

- **Hol él a kód:** a marveen/ClaudeClaw repóban, KÜLÖN belépési pont: `src/crm/index.ts` (a `tsc` build a `dist/crm/index.js`-t adja, ahogy a dashboardnál). Nem külön repó: a Bridge-allowlist, a bearer-token, a claudeclaw.db olvasása és a CI mind itt van.
- **Port:** `CRM_PORT` env, alapértelmezés 3421 (mérve szabad 3421-3430). A dashboard 3420-as útját nem érinti.
- **Adat:** saját `store/crm.db` (SQLite, WAL), sémát a szolgáltatás maga hozza létre indításkor `CREATE TABLE IF NOT EXISTS`-szel, a repo db.ts mintájára. A `store/claudeclaw.db`-t CSAK OLVASSA (`?mode=ro`), sosem írja.
- **Auth:** ugyanaz a bearer token (`store/.dashboard-token`), ugyanazzal az ellenőrzéssel, mint a dashboard; a Bridge már ismeri.
- **Bridge:** a meglévő service-port allowlist mechanizmus (profil servicePorts + host permitopen sync). Az 1. ütem szállítmánya: a port bejegyzése és a host-oldali permitopen dokumentálva a telepítő-oldalon; új Bridge-funkció nem kell.
- **UI:** statikus fájlok `web-crm/` alatt, a szolgáltatás szolgálja ki; a mai `web/` mintája, keretrendszer nélkül. Négy képernyő az 1. ütemben: Ma (lejárt és mai következő lépések), Leadek (lista + szűrés), Lead felvétele (a gomb, e-mail nélkül is), Szál (egy kontakt levelezése idővonalon).
- **Amit a felület KIMOND:** a személyes Gmail-fiók küldöttjei és a Resend-en kimenő aiam-levelek most NEM látszanak (két gazda-döntés áll mögötte). Ez a Szál nézet fejlécében áll, nem egy súgóban.

## 2. Séma, 1. ütem (Boni A-D előfeltételei beépítve, hogy a 3. ütem ne migráció legyen)

```sql
CREATE TABLE contacts (id INTEGER PRIMARY KEY, display_name TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, notes TEXT);
CREATE TABLE contact_emails (contact_id INTEGER NOT NULL REFERENCES contacts(id), email TEXT NOT NULL UNIQUE COLLATE NOCASE, is_primary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE contact_phones (contact_id INTEGER NOT NULL REFERENCES contacts(id), phone TEXT NOT NULL, PRIMARY KEY(contact_id, phone));
CREATE TABLE threads (id INTEGER PRIMARY KEY, thread_key TEXT NOT NULL UNIQUE, subject TEXT, contact_id INTEGER REFERENCES contacts(id), first_at INTEGER, last_at INTEGER);
-- thread_key: Gmail threadId ha van ('gmail:<id>'), különben az RFC References-lánc gyökere ('refs:<Message-ID>')
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  rfc_message_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('gmail_assistant','gmail_forwarded_personal','imap_support','manual')),
  source_uid TEXT NOT NULL,
  thread_id INTEGER REFERENCES threads(id),
  direction TEXT NOT NULL CHECK(direction IN ('in','out','draft')),
  from_addr TEXT, to_addrs TEXT, cc_addrs TEXT, subject TEXT, sent_at INTEGER, body_text TEXT,
  in_reply_to TEXT, refs TEXT,
  synced_at INTEGER NOT NULL,
  UNIQUE(source, source_uid)
);
CREATE TABLE leads (
  id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), title TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('email','telegram','phone','meeting','referral','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','won','lost','parked')),
  owner TEXT NOT NULL,
  next_step_type TEXT NOT NULL CHECK(next_step_type IN ('email','call','meeting','offer','wakeup')),
  -- 'wakeup' = ügyfél későbbre kérte (ébresztés): a kapu ennél a típusnál 12 hónapos dátumot enged, és NEM halasztás (Geri 6.5b). MOST került be, mert SQLite-ban a CHECK bővítése később táblaújraépítés (Geri mérése, 28253).
  next_step_at INTEGER NOT NULL,
  next_step_text TEXT NOT NULL CHECK(length(trim(next_step_text)) > 0),
  postpone_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL
);
-- A kapu (Geri 6. szakasz) a végponton áll; a CHECK-ek a második tanú, nem az első.
CREATE TABLE tasks (id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES leads(id), kind TEXT NOT NULL, due_at INTEGER, owner TEXT NOT NULL, text TEXT NOT NULL, done_at INTEGER, created_at INTEGER NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE send_attempts (
  id INTEGER PRIMARY KEY, rfc_message_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('gmail_api','smtp_support','resend')),
  requested_at INTEGER NOT NULL, http_status INTEGER, provider_msg_id TEXT, thread_id_provider TEXT, sent_folder_uid TEXT,
  state TEXT NOT NULL CHECK(state IN ('draft','queued','accepted','failed','uncertain')),
  audit_gap TEXT, actor TEXT NOT NULL
);
-- accepted CSAK bizonyítékkal: gmail_api = provider_msg_id + thread_id_provider; resend = provider_msg_id; smtp_support = http_status 250 + sent_folder_uid + a saját rfc_message_id. audit_gap != NULL esetén ugyanabban a tranzakcióban tasks-sor.
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, detail TEXT);
-- Pénz (3. ütem tölti, az 1. ütem csak létrehozza; Boni A-D):
CREATE TABLE billing_identities (id INTEGER PRIMARY KEY, tax_number TEXT, billingo_partner_id TEXT, name TEXT, UNIQUE(tax_number), UNIQUE(billingo_partner_id), CHECK(tax_number IS NOT NULL OR billingo_partner_id IS NOT NULL));
-- a CHECK zárja ki az üres identitás-sort: SQLite-ban a UNIQUE több NULL-t is enged (Boni 28255).
CREATE TABLE contact_billing_identities (contact_id INTEGER NOT NULL REFERENCES contacts(id), billing_identity_id INTEGER NOT NULL REFERENCES billing_identities(id), PRIMARY KEY(contact_id, billing_identity_id));
CREATE TABLE money_rows (
  id INTEGER PRIMARY KEY, source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('invoice','receipt','payment','expense')),
  state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('expected','invoiced','settled_per_issuer','settled_per_bank','cancelled','uncollectible','unknown')),
  -- state: a négy külön szám (várható / számlázott / befolyt a számlázó szerint / befolyt a bankban) + sztornó + behajthatatlan (mért: 55 sztornó a Billingo none-kulcsán, kimerült dunning a Stripe-on) + unknown importkor (Boni 28255).
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, amount_basis TEXT NOT NULL CHECK(amount_basis IN ('net','gross','unknown')),
  fx_rate REAL, fx_rate_source TEXT, fx_as_of INTEGER,
  billing_identity_id INTEGER REFERENCES billing_identities(id),
  contact_id INTEGER REFERENCES contacts(id),
  link_basis TEXT NOT NULL DEFAULT 'none' CHECK(link_basis IN ('document_chain','billing_identity','manual','none')),
  owner_scope TEXT NOT NULL CHECK(owner_scope IN ('own','shared')),
  -- owner_scope-nak SZÁNDÉKOSAN NINCS default-ja: az importáló köteles kimondani, és hangosan bukik, ha nem tudja; egy 'own' default a társas árbevételt csendben sajáttá minősítené (Boni 28255).
  issued_at INTEGER, imported_at INTEGER NOT NULL,
  UNIQUE(source_system, source_id)
);
-- TILTOTT KULCS (Boni mérése): a Billingo dokumentumba ágyazott partner emails mezője. Nem kulcs, nem link_basis forrás.
-- NINCS tárolt "mennyit költött" a contacts-on: számított, két számból + "nem köthető" sor.
```

## 3. Munkatételek és sorrend

| # | Kártya | Gazda | Tartalom | Függ |
|---|---|---|---|---|
| S1 | (ez a fájl) | Samu | szerkezet, séma, review minden PR-en | - |
| D1 | CRM1SKEL922 | Dani | szolgáltatás-váz: src/crm/index.ts, CRM_PORT, crm.db + séma (fenti DDL), bearer auth, /health, claudeclaw.db csak-olvasó kapcsolat, web-crm/ váz a négy képernyővel (Ma, Leadek, Lead felvétele, Szál) statikus adattal, Bridge-port bejegyzés + permitopen doksi | S1 |
| G1 | CRM1LEADKAPU922 | Geri | POST /api/leads végpont a 6. szakasz kapujával, a hat elfogadási feltétel tesztje, audit_log sor, a Ma nézet rendezése (lejárt elöl); NEM a felület, csak a végpont + teszt | D1 váz (a végpont a vázba illeszkedik) |
| D2 | CRM1MAILSYNC922 | Dani | levél-szinkron: Gmail API az asszisztensi fiókról (messages+threads, Message-ID dedup, UNIQUE(source,uid), upsert), support@ IMAP a fejlécek parse-olásával (Message-ID/In-Reply-To/References), a Szál nézet élő adattal, a "nem látszik" fejléc-mondat; LEAD SOSEM SZINKRONBÓL | D1 |
| G2 | (2. ütemben) | Geri | send_attempts állapotgép, audit_gap + task ugyanabban a tranzakcióban, a többi három kényszer | G1 |

Review: minden PR-t Samu mér a szokott recepttel (worktree, suite, mutánsok). A merge Marveené.

## 4. Szerző (actor): döntés 2026-09-22 19:0x (Geri 28281, Dani 28286)

(a): a KÉRÉS hordozza a szerzőt, a törzs `actor` mezőjében (nem fejlécben: a törzs kerül a nyomba). A bearer token engedélyt mond, nem nevet, ezért a szolgáltatás SOHA nem tölt ki szerzőt konfigból vagy konstansból: nincs CRM_ACTOR, nincs 'system'. Szerver-oldalon a kapu megtagadja az üres vagy csak-whitespace actor-t (trim után 1..64 karakter), ugyanez a szabály minden író végpontra (leads, contacts, tasks, később send_attempts). A felület "Ki vagy" mezője tölti, localStorage-ban nézőnként, üresen a gomb tiltott, de a szerver-oldali megtagadás az első tanú, a gomb csak kényelem. Név-allowlist az 1. ütemben nincs (a gazda saját nevét nem zárhatjuk ki); a nyomban a beírt név áll. Sorrend: Geri végpontja definiálja a szerződést (body.actor), Dani felület-PR-je a mezőt hozza, mindkettő a D1 merge után. Ezzel a séma három NOT NULL mezője (contacts.created_by, leads.created_by, audit_log.actor) mindig a kérésből töltődik.
