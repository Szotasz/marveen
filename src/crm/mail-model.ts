// CRM 1. utem, D2 (CRM1MAILSYNC922): the ONE shape every mail source is
// normalised into, the thread-key rule, and the idempotent upsert into
// messages/threads. Sources: Gmail (assistant account, raw API), Gmail
// forwarded-from-personal (X-Forwarded-To), support@ IMAP (INBOX +
// INBOX.Sent). Pure where possible so the fixtures test everything without
// a network.
//
// LEAD SOSEM SZINKRONBOL: nothing in this module touches `leads`, and the
// test asserts the count is unchanged across a sync.
import type Database from 'better-sqlite3'

export type MailSource = 'gmail_assistant' | 'gmail_forwarded_personal' | 'imap_support' | 'manual'
export type MailDirection = 'in' | 'out' | 'draft'

export interface NormalizedMail {
  source: MailSource
  /** Provider-side id: Gmail message id, IMAP "<mailbox>:<uid>". */
  source_uid: string
  /** RFC Message-ID with angle brackets stripped, or null when the copy
   *  carries none (measured: every support@ Sent copy today). */
  rfc_message_id: string | null
  /** Gmail threadId when the source has one. */
  provider_thread_id: string | null
  direction: MailDirection
  from_addr: string | null
  to_addrs: string[]
  cc_addrs: string[]
  subject: string | null
  /** epoch seconds */
  sent_at: number | null
  body_text: string | null
  in_reply_to: string | null
  references: string[]
}

/** '<a@b>' -> 'a@b'; trims; empty -> null. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().replace(/^<|>$/g, '').trim()
  return v || null
}

/** Splits a References header into ids (angle brackets stripped). */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return []
  return (raw.match(/<[^<>]+>/g) ?? []).map((s) => s.slice(1, -1).trim()).filter(Boolean)
}

/** Lower-cased bare addresses out of a header value ("Name <a@b>, c@d"). */
export function parseAddresses(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const m of raw.matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g)) {
    const a = (m[1] ?? m[2] ?? '').trim().toLowerCase().replace(/^mailto:/, '')
    if (a && !out.includes(a)) out.push(a)
  }
  return out
}

/**
 * thread_key (breakdown section 2): 'gmail:<threadId>' when Gmail gives one,
 * else 'refs:<root>' where root is the FIRST id of the References chain, else
 * the In-Reply-To, else the message's own Message-ID (a thread of one). A
 * message with none of these (a support@ Sent copy) has NO thread key: it is
 * stored, but stated as not threadable.
 */
export function deriveThreadKey(m: NormalizedMail): string | null {
  if (m.provider_thread_id) return `gmail:${m.provider_thread_id}`
  const root = m.references[0] ?? m.in_reply_to ?? m.rfc_message_id
  return root ? `refs:${root}` : null
}

/** A synthetic, clearly-labelled id for copies without a Message-ID so the
 *  NOT NULL UNIQUE column holds; never mistaken for an RFC id. */
export function syntheticMessageId(m: Pick<NormalizedMail, 'source' | 'source_uid'>): string {
  return `synthetic:${m.source}:${m.source_uid}`
}

export interface UpsertResult {
  messageId: number
  inserted: boolean
  threadId: number | null
  threadKey: string | null
}

/** Idempotent: keyed on (source, source_uid) AND rfc_message_id. A re-sync
 *  updates the row in place; the same letter seen from two sources (forwarded
 *  personal mail keeps the original Message-ID) stays ONE row, the first
 *  source wins and the second is recorded as an update, not a duplicate. */
export function upsertMail(db: Database.Database, m: NormalizedMail, now: number): UpsertResult {
  const rfcId = m.rfc_message_id ?? syntheticMessageId(m)
  const threadKey = deriveThreadKey(m)
  let threadId: number | null = null
  if (threadKey) {
    const existing = db.prepare('SELECT id, first_at, last_at FROM threads WHERE thread_key = ?').get(threadKey) as
      | { id: number; first_at: number | null; last_at: number | null }
      | undefined
    if (existing) {
      threadId = existing.id
      const first = m.sent_at != null && (existing.first_at == null || m.sent_at < existing.first_at) ? m.sent_at : existing.first_at
      const last = m.sent_at != null && (existing.last_at == null || m.sent_at > existing.last_at) ? m.sent_at : existing.last_at
      db.prepare('UPDATE threads SET first_at = ?, last_at = ?, subject = COALESCE(subject, ?) WHERE id = ?').run(first, last, m.subject, threadId)
    } else {
      const contactId = findContactByAddresses(db, [m.from_addr, ...m.to_addrs, ...m.cc_addrs])
      const r = db
        .prepare('INSERT INTO threads (thread_key, subject, contact_id, first_at, last_at) VALUES (?,?,?,?,?)')
        .run(threadKey, m.subject, contactId, m.sent_at, m.sent_at)
      threadId = Number(r.lastInsertRowid)
    }
  }
  const prior = db
    .prepare('SELECT id FROM messages WHERE rfc_message_id = ? OR (source = ? AND source_uid = ?)')
    .get(rfcId, m.source, m.source_uid) as { id: number } | undefined
  const to = m.to_addrs.join(', ') || null
  const cc = m.cc_addrs.join(', ') || null
  const refs = m.references.join(' ') || null
  if (prior) {
    db.prepare(
      `UPDATE messages SET thread_id = COALESCE(?, thread_id), direction = ?, from_addr = ?, to_addrs = ?, cc_addrs = ?,
              subject = ?, sent_at = ?, body_text = ?, in_reply_to = ?, refs = ?, synced_at = ? WHERE id = ?`,
    ).run(threadId, m.direction, m.from_addr, to, cc, m.subject, m.sent_at, m.body_text, m.in_reply_to, refs, now, prior.id)
    return { messageId: prior.id, inserted: false, threadId, threadKey }
  }
  const r = db
    .prepare(
      `INSERT INTO messages (rfc_message_id, source, source_uid, thread_id, direction, from_addr, to_addrs, cc_addrs, subject,
                             sent_at, body_text, in_reply_to, refs, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(rfcId, m.source, m.source_uid, threadId, m.direction, m.from_addr, to, cc, m.subject, m.sent_at, m.body_text, m.in_reply_to, refs, now)
  return { messageId: Number(r.lastInsertRowid), inserted: true, threadId, threadKey }
}

/** The contact a thread belongs to: the first participant address that is a
 *  known contact e-mail (COLLATE NOCASE), else null. Never creates contacts:
 *  a sync must not invent people (that is the lead gate's job, by a named
 *  actor). */
export function findContactByAddresses(db: Database.Database, addrs: Array<string | null>): number | null {
  const stmt = db.prepare('SELECT contact_id FROM contact_emails WHERE email = ? COLLATE NOCASE')
  for (const a of addrs) {
    if (!a) continue
    const row = stmt.get(a) as { contact_id: number } | undefined
    if (row) return row.contact_id
  }
  return null
}

/** Best-effort plain text: strip tags/entities from HTML when no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
