import type Database from 'better-sqlite3'

// Contacts store (card f90928e3, node C1). Separate from `memories` on
// purpose: every value is its own append-only row with a mandatory, named
// source. UPDATE/DELETE on contact_values abort in a trigger; a retraction is a
// NEW row (status 'retracted') carrying its own source and pointing at the
// value it withdraws. Two conflicting phone numbers therefore both stay.
// No embedding and no mirroring into memories.

export const CONTACT_DOMAINS = ['business', 'family'] as const
export type ContactDomain = (typeof CONTACT_DOMAINS)[number]

export const CONTACT_FIELDS = ['name', 'email', 'phone', 'address', 'org', 'relationship'] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]

// Same grammar as SOURCE_PATTERNS in scripts/recipient-ledger.mjs. A shared
// test vector (src/__tests__/fixtures/contact-source-vectors.json) keeps the
// two validators in agreement.
const SOURCE_PATTERNS = [
  /^mail:\S+$/,
  /^site:https?:\/\/\S+$/,
  /^owner$/,
  /^crm:\S+$/,
  /^order:\S+$/,
  /^doc:\S+$/,
]

export function isValidSource(source: unknown): boolean {
  const s = String(source ?? '').trim()
  return SOURCE_PATTERNS.some((re) => re.test(s))
}

export const SOURCE_HELP = 'mail:<messageId> | site:<url> | owner | crm:<ref> | order:<id> | doc:<ref>'

export function ensureContactsSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT 'brainy' CHECK (agent_id = 'brainy'),
      domain TEXT NOT NULL CHECK (domain IN ('business','family')),
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_domain ON contacts(domain);

    CREATE TABLE IF NOT EXISTS contact_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      field TEXT NOT NULL CHECK (field IN ('name','email','phone','address','org','relationship')),
      value TEXT NOT NULL,
      source TEXT NOT NULL CHECK (length(trim(source)) > 0),
      source_date TEXT NOT NULL CHECK (length(trim(source_date)) > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
      retracts_id INTEGER REFERENCES contact_values(id),
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      added_by TEXT NOT NULL,
      CHECK (status = 'active' OR retracts_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_values_contact ON contact_values(contact_id);

    CREATE TRIGGER IF NOT EXISTS contact_values_no_update
    BEFORE UPDATE ON contact_values
    BEGIN SELECT RAISE(ABORT, 'contact_values is append-only: UPDATE not allowed'); END;

    CREATE TRIGGER IF NOT EXISTS contact_values_no_delete
    BEFORE DELETE ON contact_values
    BEGIN SELECT RAISE(ABORT, 'contact_values is append-only: DELETE not allowed'); END;

    -- Display name, name and organisation only. Email, phone and address are never indexed.
    CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
      value, contact_id UNINDEXED, value_id UNINDEXED
    );

    CREATE TRIGGER IF NOT EXISTS contact_values_fts_ins
    AFTER INSERT ON contact_values
    WHEN NEW.status = 'active' AND NEW.field IN ('name','org')
    BEGIN
      INSERT INTO contacts_fts(value, contact_id, value_id) VALUES (NEW.value, NEW.contact_id, NEW.id);
    END;

    -- display_name rows carry value_id NULL, so a retraction (which deletes by
    -- value_id) never touches them; display_name is never updated.
    CREATE TRIGGER IF NOT EXISTS contacts_fts_display_name
    AFTER INSERT ON contacts
    BEGIN
      INSERT INTO contacts_fts(value, contact_id, value_id) VALUES (NEW.display_name, NEW.id, NULL);
    END;

    INSERT INTO contacts_fts(value, contact_id, value_id)
      SELECT c.display_name, c.id, NULL FROM contacts c
      WHERE NOT EXISTS (SELECT 1 FROM contacts_fts f WHERE f.contact_id = c.id AND f.value_id IS NULL);

    CREATE TRIGGER IF NOT EXISTS contact_values_fts_retract
    AFTER INSERT ON contact_values
    WHEN NEW.status = 'retracted'
    BEGIN
      DELETE FROM contacts_fts WHERE value_id = NEW.retracts_id;
    END;

    -- Read audit: who looked, when, which contact, which query. Never a value.
    CREATE TABLE IF NOT EXISTS contact_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reader TEXT NOT NULL,
      read_at INTEGER NOT NULL DEFAULT (unixepoch()),
      contact_id INTEGER,
      query TEXT
    );

    -- Write audit: who, when, which record, what kind of write. No value column.
    CREATE TABLE IF NOT EXISTS contact_writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch()),
      contact_id INTEGER,
      value_id INTEGER,
      action TEXT NOT NULL CHECK (action IN ('create','add','retract','attempt'))
    );

    -- Both audit tables are append-only, like contact_values.
    CREATE TRIGGER IF NOT EXISTS contact_reads_no_update
    BEFORE UPDATE ON contact_reads
    BEGIN SELECT RAISE(ABORT, 'contact_reads is append-only: UPDATE not allowed'); END;
    CREATE TRIGGER IF NOT EXISTS contact_reads_no_delete
    BEFORE DELETE ON contact_reads
    BEGIN SELECT RAISE(ABORT, 'contact_reads is append-only: DELETE not allowed'); END;
    CREATE TRIGGER IF NOT EXISTS contact_writes_no_update
    BEFORE UPDATE ON contact_writes
    BEGIN SELECT RAISE(ABORT, 'contact_writes is append-only: UPDATE not allowed'); END;
    CREATE TRIGGER IF NOT EXISTS contact_writes_no_delete
    BEFORE DELETE ON contact_writes
    BEGIN SELECT RAISE(ABORT, 'contact_writes is append-only: DELETE not allowed'); END;
  `)
}

export interface ContactValue {
  id: number
  contact_id: number
  field: ContactField
  value: string
  source: string
  source_date: string
  status: 'active' | 'retracted'
  retracts_id: number | null
  added_at: number
  added_by: string
}

export interface Contact {
  id: number
  agent_id: string
  domain: ContactDomain
  display_name: string
  created_at: number
}

export interface ContactWithValues extends Contact {
  values: ContactValue[]
}

function requireDomain(domain: unknown): ContactDomain {
  if (!CONTACT_DOMAINS.includes(domain as ContactDomain)) {
    throw new Error(`domain is required and must be one of: ${CONTACT_DOMAINS.join(', ')}`)
  }
  return domain as ContactDomain
}

function requireSource(source: unknown): string {
  if (!isValidSource(source)) {
    throw new Error(`invalid or missing source. Accepted: ${SOURCE_HELP}`)
  }
  return String(source).trim()
}

function requireSourceDate(sourceDate: unknown): string {
  const s = String(sourceDate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error('source_date is required (YYYY-MM-DD)')
  return s
}

export function createContact(d: Database.Database, input: { domain: unknown; display_name: string }): number {
  const domain = requireDomain(input.domain)
  const name = String(input.display_name ?? '').trim()
  if (!name) throw new Error('display_name is required')
  return Number(d.prepare('INSERT INTO contacts (domain, display_name) VALUES (?, ?)').run(domain, name).lastInsertRowid)
}

export function addValue(
  d: Database.Database,
  input: { contact_id: number; field: ContactField; value: string; source: unknown; source_date: unknown; added_by: string },
): number {
  if (!CONTACT_FIELDS.includes(input.field)) throw new Error(`field must be one of: ${CONTACT_FIELDS.join(', ')}`)
  const value = String(input.value ?? '').trim()
  if (!value) throw new Error('value is required')
  const source = requireSource(input.source)
  const sourceDate = requireSourceDate(input.source_date)
  if (!input.added_by) throw new Error('added_by is required')
  return Number(
    d.prepare(
      `INSERT INTO contact_values (contact_id, field, value, source, source_date, added_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.contact_id, input.field, value, source, sourceDate, input.added_by).lastInsertRowid,
  )
}

/** Retraction = a new row copying field/value of the target, with its own source. */
export function retractValue(
  d: Database.Database,
  input: { value_id: number; source: unknown; source_date: unknown; added_by: string },
): number {
  const source = requireSource(input.source)
  const sourceDate = requireSourceDate(input.source_date)
  if (!input.added_by) throw new Error('added_by is required')
  const target = d.prepare('SELECT * FROM contact_values WHERE id = ?').get(input.value_id) as ContactValue | undefined
  if (!target) throw new Error(`contact value ${input.value_id} not found`)
  if (target.status !== 'active') throw new Error('only an active value can be retracted')
  const already = d.prepare("SELECT 1 FROM contact_values WHERE retracts_id = ? AND status = 'retracted'").get(target.id)
  if (already) throw new Error('value is already retracted')
  return Number(
    d.prepare(
      `INSERT INTO contact_values (contact_id, field, value, source, source_date, status, retracts_id, added_by)
       VALUES (?, ?, ?, ?, ?, 'retracted', ?, ?)`,
    ).run(target.contact_id, target.field, target.value, source, sourceDate, target.id, input.added_by).lastInsertRowid,
  )
}

function activeValues(d: Database.Database, contactId: number): ContactValue[] {
  return d.prepare(
    `SELECT v.* FROM contact_values v
     WHERE v.contact_id = ? AND v.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM contact_values r WHERE r.retracts_id = v.id AND r.status = 'retracted')
     ORDER BY v.id`,
  ).all(contactId) as ContactValue[]
}

export function getContact(d: Database.Database, id: number): ContactWithValues | null {
  const c = d.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined
  return c ? { ...c, values: activeValues(d, c.id) } : null
}

/** Name/org search only. `domain` is mandatory; there is no "both" default. */
export function findContacts(d: Database.Database, input: { domain: unknown; q?: string }): ContactWithValues[] {
  const domain = requireDomain(input.domain)
  const q = String(input.q ?? '').trim()
  let rows: Contact[]
  if (!q) {
    rows = d.prepare('SELECT * FROM contacts WHERE domain = ? ORDER BY id').all(domain) as Contact[]
  } else {
    // Quote each token so FTS operators in user input are inert.
    const match = q.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
    rows = d.prepare(
      `SELECT c.* FROM contacts c
       WHERE c.domain = ? AND c.id IN (SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?)
       ORDER BY c.id`,
    ).all(domain, match) as Contact[]
  }
  return rows.map((c) => ({ ...c, values: activeValues(d, c.id) }))
}

/** Audit a write. Records who, when, which contact/value and the kind -- never a value. */
export function recordWrite(
  d: Database.Database,
  input: { actor: string; contact_id: number | null; value_id?: number | null; action: 'create' | 'add' | 'retract' | 'attempt' },
): void {
  d.prepare('INSERT INTO contact_writes (actor, contact_id, value_id, action) VALUES (?, ?, ?, ?)')
    .run(input.actor, input.contact_id ?? null, input.value_id ?? null, input.action)
}

/** Audit a read. Records who, when, which contact and the query -- never a value. */
export function recordRead(d: Database.Database, input: { reader: string; contact_id?: number | null; query?: string | null }): void {
  d.prepare('INSERT INTO contact_reads (reader, contact_id, query) VALUES (?, ?, ?)')
    .run(input.reader, input.contact_id ?? null, input.query ?? null)
}
