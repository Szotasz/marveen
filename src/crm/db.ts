// CRM 1. utem (CRM1SKEL922): the CRM's OWN SQLite store, separate from
// store/claudeclaw.db. The schema below is the DDL of
// workspace/CRM-1-UTEM-FELBONTAS.md section 2, verbatim, wrapped in
// CREATE TABLE IF NOT EXISTS so the service creates it on start (src/db.ts
// shape). Money tables are created here and filled in phase 3 (Boni A-D),
// so phase 3 is not a migration.
//
// claudeclaw.db is opened READ-ONLY here and nowhere else in this module:
// the CRM reads the fleet's store, it never writes it.
import Database from 'better-sqlite3'

export const CRM_TABLES = [
  'contacts',
  'contact_emails',
  'contact_phones',
  'threads',
  'messages',
  'leads',
  'tasks',
  'send_attempts',
  'audit_log',
  'billing_identities',
  'contact_billing_identities',
  'money_rows',
] as const

// Generated from docs/crm/CRM-1-UTEM-FELBONTAS.md section 2 (statement text
// verbatim, IF NOT EXISTS added); crm-skeleton.test.ts pins the equality, so
// a schema edit in the doc without this list (or vice versa) goes red.
export const CRM_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, display_name TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS contact_emails (contact_id INTEGER NOT NULL REFERENCES contacts(id), email TEXT NOT NULL UNIQUE COLLATE NOCASE, is_primary INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS contact_phones (contact_id INTEGER NOT NULL REFERENCES contacts(id), phone TEXT NOT NULL, PRIMARY KEY(contact_id, phone))`,
  `CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY, thread_key TEXT NOT NULL UNIQUE, subject TEXT, contact_id INTEGER REFERENCES contacts(id), first_at INTEGER, last_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS messages (
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
)`,
  `CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), title TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('email','telegram','phone','meeting','referral','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','won','lost','parked')),
  owner TEXT NOT NULL,
  next_step_type TEXT NOT NULL CHECK(next_step_type IN ('email','call','meeting','offer','wakeup')),
  next_step_at INTEGER NOT NULL,
  next_step_text TEXT NOT NULL CHECK(length(trim(next_step_text)) > 0),
  postpone_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES leads(id), kind TEXT NOT NULL, due_at INTEGER, owner TEXT NOT NULL, text TEXT NOT NULL, done_at INTEGER, created_at INTEGER NOT NULL, created_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS send_attempts (
  id INTEGER PRIMARY KEY, rfc_message_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('gmail_api','smtp_support','resend')),
  requested_at INTEGER NOT NULL, http_status INTEGER, provider_msg_id TEXT, thread_id_provider TEXT, sent_folder_uid TEXT,
  state TEXT NOT NULL CHECK(state IN ('draft','queued','accepted','failed','uncertain')),
  audit_gap TEXT, actor TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS billing_identities (id INTEGER PRIMARY KEY, tax_number TEXT, billingo_partner_id TEXT, name TEXT, UNIQUE(tax_number), UNIQUE(billingo_partner_id), CHECK(tax_number IS NOT NULL OR billingo_partner_id IS NOT NULL))`,
  `CREATE TABLE IF NOT EXISTS contact_billing_identities (contact_id INTEGER NOT NULL REFERENCES contacts(id), billing_identity_id INTEGER NOT NULL REFERENCES billing_identities(id), PRIMARY KEY(contact_id, billing_identity_id))`,
  `CREATE TABLE IF NOT EXISTS money_rows (
  id INTEGER PRIMARY KEY, source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('invoice','receipt','payment','expense')),
  state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('expected','invoiced','settled_per_issuer','settled_per_bank','cancelled','uncollectible','unknown')),
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, amount_basis TEXT NOT NULL CHECK(amount_basis IN ('net','gross','unknown')),
  fx_rate REAL, fx_rate_source TEXT, fx_as_of INTEGER,
  billing_identity_id INTEGER REFERENCES billing_identities(id),
  contact_id INTEGER REFERENCES contacts(id),
  link_basis TEXT NOT NULL DEFAULT 'none' CHECK(link_basis IN ('document_chain','billing_identity','manual','none')),
  owner_scope TEXT NOT NULL CHECK(owner_scope IN ('own','shared')),
  issued_at INTEGER, imported_at INTEGER NOT NULL,
  UNIQUE(source_system, source_id)
)`,
]

/** Open (creating if needed) the CRM store and apply the schema. WAL like src/db.ts. */
export function initCrmDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const ddl of CRM_SCHEMA_DDL) db.exec(ddl)
  return db
}

/** The fleet store, READ-ONLY. Throws when the file is missing rather than
 *  creating an empty one under the fleet's name. */
export function openClaudeclawReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

export function listTables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)
}
