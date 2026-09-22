// CRM 1. utem, D2 (CRM1MAILSYNC922): mail sync on FIXTURES only, never a live
// account. The properties: one common shape for every source; the thread-key
// rule; idempotent upsert (a second run inserts nothing); the same letter seen
// through two sources is ONE row; a Sent copy without a Message-ID is stored
// but stated as unthreadable; a sync NEVER creates leads or contacts; the
// read endpoints serve the Szal view; the Python dumper parses raw mail
// offline (no network, no vault).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { initCrmDatabase } from '../crm/db.js'
import { deriveThreadKey, htmlToText, parseAddresses, parseReferences, type NormalizedMail } from '../crm/mail-model.js'
import { normalizeGmail, extractBodyText, syncGmail, type GmailApi, type GmailMessage } from '../crm/gmail-sync.js'
import { applyImapLines, applyImapDump, normalizeImap, parseDumpOutput, resolveDumpTimeoutMs, type ImapDumpLine, type ImapSyncState } from '../crm/imap-sync.js'
import { syncStatus } from '../crm/thread-routes.js'
import { writeFileSync } from 'node:fs'
import { createCrmServer } from '../crm/server.js'

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..')
const FIX = join(REPO, 'src', '__tests__', 'fixtures', 'crm-mail')
const TOKEN = 'crm-sync-test-token'
const NOW = 1758600000

const gmailFixture = JSON.parse(readFileSync(join(FIX, 'gmail-messages.json'), 'utf-8')) as GmailMessage[]
const fakeGmail: GmailApi = {
  async listMessageIds() { return gmailFixture.map((m) => m.id) },
  async getMessage(id) { const m = gmailFixture.find((x) => x.id === id); if (!m) throw new Error('no fixture ' + id); return m },
}
const imapLines = parseDumpOutput(readFileSync(join(FIX, 'imap-dump.jsonl'), 'utf-8'))

let tmp: string
let db: Database.Database
let contactId: number
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'crm-sync-'))
  db = initCrmDatabase(join(tmp, 'crm.db'))
  const r = db.prepare(`INSERT INTO contacts (display_name, created_at, created_by) VALUES ('Példa Vevő', ?, 'teszt')`).run(NOW)
  contactId = Number(r.lastInsertRowid)
  db.prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, 'vevo@example.com', 1)`).run(contactId)
})
afterAll(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

describe('pure pieces', () => {
  it('thread key: gmail thread id first, then References root, then In-Reply-To, then own id, else none', () => {
    const base: NormalizedMail = { source: 'imap_support', source_uid: 'INBOX:1', rfc_message_id: 'me@x', provider_thread_id: null, direction: 'in', from_addr: null, to_addrs: [], cc_addrs: [], subject: null, sent_at: null, body_text: null, in_reply_to: null, references: [] }
    expect(deriveThreadKey({ ...base, provider_thread_id: 'T9', references: ['r@x'] })).toBe('gmail:T9')
    expect(deriveThreadKey({ ...base, references: ['root@x', 'mid@x'], in_reply_to: 'mid@x' })).toBe('refs:root@x')
    expect(deriveThreadKey({ ...base, in_reply_to: 'parent@x' })).toBe('refs:parent@x')
    expect(deriveThreadKey(base)).toBe('refs:me@x')
    expect(deriveThreadKey({ ...base, rfc_message_id: null })).toBe(null)
  })
  it('address and reference parsing', () => {
    expect(parseAddresses('Példa Vevő <Vevo@Example.com>, masik@x.hu')).toEqual(['vevo@example.com', 'masik@x.hu'])
    expect(parseReferences('<a@b> <c@d>')).toEqual(['a@b', 'c@d'])
    expect(htmlToText('<p>Csütörtök jó lenne,<br>10 órakor.</p><style>p{}</style>')).toBe('Csütörtök jó lenne,\n10 órakor.')
  })
  it('gmail normalisation: forwarded-from-personal keeps the ORIGINAL Message-ID and gets its own source; SENT/DRAFT map to direction; html falls back to text', () => {
    const g4 = normalizeGmail(gmailFixture.find((m) => m.id === 'g4')!)
    expect(g4.source).toBe('gmail_forwarded_personal')
    expect(g4.rfc_message_id).toBe('orig-personal-1@example.org')
    expect(normalizeGmail(gmailFixture.find((m) => m.id === 'g2')!).direction).toBe('out')
    expect(normalizeGmail(gmailFixture.find((m) => m.id === 'g5')!).direction).toBe('draft')
    expect(extractBodyText(gmailFixture.find((m) => m.id === 'g3')!.payload)).toBe('Csütörtök jó lenne,\n10 órakor.')
  })
})

describe('sync into the store', () => {
  it('gmail: inserts every fixture message once, threads by Gmail threadId, links the thread to the known contact', async () => {
    const leadsBefore = count('SELECT count(*) AS n FROM leads')
    const s = await syncGmail(db, fakeGmail, { query: 'fixture', max: 100, now: NOW })
    expect(s).toEqual({ fetched: 5, inserted: 5, updated: 0, unthreaded: 0 })
    expect(count('SELECT count(*) AS n FROM messages')).toBe(5)
    const t1 = db.prepare(`SELECT id, contact_id, subject, first_at, last_at FROM threads WHERE thread_key = 'gmail:t1'`).get() as { id: number; contact_id: number; subject: string; first_at: number; last_at: number }
    expect(t1.contact_id).toBe(contactId)
    expect(count(`SELECT count(*) AS n FROM messages WHERE thread_id = ${t1.id}`)).toBe(3)
    expect(t1.first_at).toBeLessThan(t1.last_at)
    expect(count('SELECT count(*) AS n FROM leads')).toBe(leadsBefore)
    expect(count('SELECT count(*) AS n FROM contacts')).toBe(1) // a sync never invents people
  })
  it('gmail again: idempotent, zero inserts, the same counts', async () => {
    const s = await syncGmail(db, fakeGmail, { query: 'fixture', max: 100, now: NOW + 60 })
    expect(s).toEqual({ fetched: 5, inserted: 5 * 0, updated: 5, unthreaded: 0 })
    expect(count('SELECT count(*) AS n FROM messages')).toBe(5)
    expect(count('SELECT count(*) AS n FROM threads')).toBe(3)
  })
  it('imap: INBOX in / Sent out; the Sent copy without a Message-ID is stored under a synthetic id with NO thread; the References root threads a reply; the forwarded letter already seen via Gmail stays ONE row', () => {
    const before = count('SELECT count(*) AS n FROM messages')
    const s = applyImapLines(db, imapLines, NOW + 120)
    expect(s.fetched).toBe(4)
    expect(s.inserted).toBe(3)   // uid 122 is the same letter as gmail g4 (orig-personal-1)
    expect(s.updated).toBe(1)
    expect(s.unthreaded).toBe(1)
    expect(s.maxUid).toEqual({ INBOX: 122, 'INBOX.Sent': 40 })
    expect(count('SELECT count(*) AS n FROM messages')).toBe(before + 3)
    const sent = db.prepare(`SELECT rfc_message_id, thread_id, direction FROM messages WHERE source = 'imap_support' AND source_uid = 'INBOX.Sent:40'`).get() as { rfc_message_id: string; thread_id: number | null; direction: string }
    expect(sent.rfc_message_id).toBe('synthetic:imap_support:INBOX.Sent:40')
    expect(sent.thread_id).toBe(null)
    expect(sent.direction).toBe('out')
    const t = db.prepare(`SELECT id FROM threads WHERE thread_key = 'refs:s1@customer.hu'`).get() as { id: number }
    expect(count(`SELECT count(*) AS n FROM messages WHERE thread_id = ${t.id}`)).toBe(2)
    const same = db.prepare(`SELECT count(*) AS n FROM messages WHERE rfc_message_id = 'orig-personal-1@example.org'`).get() as { n: number }
    expect(same.n).toBe(1)
    expect(count('SELECT count(*) AS n FROM leads')).toBe(0)
  })
  it('imap again: idempotent', () => {
    const before = count('SELECT count(*) AS n FROM messages')
    const s = applyImapLines(db, imapLines, NOW + 180)
    expect(s.inserted).toBe(0)
    expect(count('SELECT count(*) AS n FROM messages')).toBe(before)
  })
})

describe('thread endpoints', () => {
  let port = 0
  let server: ReturnType<typeof createCrmServer>
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } }
  beforeAll(async () => {
    server = createCrmServer({ token: TOKEN, webDir: join(REPO, 'web-crm'), crmDb: db, readDb: null })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })
  it('are gated', async () => { expect((await fetch(url('/api/threads'))).status).toBe(401) })
  it('search by participant finds the Gmail thread with counts', async () => {
    const r = await fetch(url('/api/threads?q=vevo@example.com'), auth)
    expect(r.status).toBe(200)
    const b = await r.json() as { threads: Array<{ id: number; message_count: number; out_count: number; contact_id: number }>; unthreaded_messages: number }
    // two threads carry this address: the conversation (t1) and the draft (t5)
    expect(b.threads.length).toBe(2)
    const conv = b.threads.find((t) => t.message_count === 3)!
    expect(conv).toBeDefined()
    expect(conv.out_count).toBe(1)
    expect(conv.contact_id).toBe(contactId)
    expect(b.unthreaded_messages).toBe(1)
    const d = await (await fetch(url(`/api/threads/${conv.id}`), auth)).json() as { messages: Array<{ direction: string; sent_at: number }> }
    expect(d.messages.map((m) => m.direction)).toEqual(['in', 'out', 'in'])
    expect(d.messages[0].sent_at).toBeLessThan(d.messages[2].sent_at)
  })
  it('unthreaded copies are listed with the reason; sync status reports counts by source and what is not visible', async () => {
    const u = await (await fetch(url('/api/messages/unthreaded'), auth)).json() as { messages: unknown[]; note: string }
    expect(u.messages.length).toBe(1)
    expect(u.note).toContain('Message-ID')
    const s = await (await fetch(url('/api/sync/status'), auth)).json() as { counts: { by_source: Record<string, number>; unthreaded: number }; not_visible: string }
    expect(s.counts.by_source).toEqual({ gmail_assistant: 4, gmail_forwarded_personal: 1, imap_support: 3 })
    expect(s.counts.unthreaded).toBe(1)
    expect(s.not_visible).toContain('Resend')
    expect((await fetch(url('/api/threads/999999'), auth)).status).toBe(404)
  })
})

describe('the Python dumper, offline', () => {
  const script = join(REPO, 'scripts', 'crm', 'support-imap-dump.py')
  const run = (f: string) => JSON.parse(execFileSync('python3', [script, '--parse-file', join(FIX, f)], { encoding: 'utf-8' }).trim()) as ImapDumpLine
  it('a Sent copy without Message-ID parses with message_id null and a decoded subject', () => {
    const p = run('sent-copy.eml')
    expect(p.message_id).toBe(null)
    expect(p.subject).toBe('Re: Licenc kérdés')
    expect(p.body_text).toContain('Licenc fülön')
    expect(normalizeImap({ ...p, mailbox: 'INBOX.Sent', uid: '7' }).rfc_message_id).toBe(null)
  })
  it('an INBOX mail parses its ids, references and html body; normalisation threads it on the References root', () => {
    const p = run('inbox-mail.eml')
    expect(p.message_id).toBe('<s9@customer.hu>')
    expect(p.references).toBe('<root@y> <x@y>')
    expect(p.body_text).toBe(null)
    expect(p.body_html).toContain('<b>ott</b>')
    const n = normalizeImap({ ...p, mailbox: 'INBOX', uid: '9' })
    expect(n.rfc_message_id).toBe('s9@customer.hu')
    expect(n.references).toEqual(['root@y', 'x@y'])
    expect(deriveThreadKey(n)).toBe('refs:root@y')
    expect(n.body_text).toBe('Hali ott')
    expect(n.from_addr).toBe('ugyfel@customer.hu')
  })
  it('refuses to fetch without a mailbox (usage) and never reads the vault in --parse-file mode', () => {
    let code = 0
    try { execFileSync('python3', [script], { stdio: 'pipe' }) } catch (e) { code = (e as { status: number }).status }
    expect(code).toBe(2)
  })
})

describe('a cut or failed dump is applied but never reported clean (Samu review on #1475)', () => {
  const freshState = (): ImapSyncState => ({ mailboxes: ['INBOX', 'INBOX.Sent'], last_uid: {}, last_run: null, last_stats: null, last_error: null })
  it('killed child with partial stdout: the lines land, the uid advances, last_error is set, rc 4, and /api/sync/status carries it', () => {
    const d2 = initCrmDatabase(join(tmp, 'cut.db'))
    const state = freshState()
    const partial = imapLines.filter((l) => l.mailbox === 'INBOX').slice(0, 1)
    const r = applyImapDump(d2, state, { lines: partial, stderr: '', code: 1, killed: true }, NOW, 120_000)
    expect(r.rc).toBe(4)
    expect((d2.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(1)
    expect(state.last_uid.INBOX).toBe(Number(partial[0].uid))
    expect(state.last_error).toMatch(/^dump killed \(timeout 120000 ms\); 1 lines applied, the run is PARTIAL$/)
    expect(r.out.partial).toBe(true)
    const statePath = join(tmp, 'cut-state.json')
    writeFileSync(statePath, JSON.stringify({ gmail: {}, imap: state }))
    const st = syncStatus(d2, statePath).body as { state: { imap: { last_error: string | null } } }
    expect(st.state.imap.last_error).not.toBeNull()
    d2.close()
  })
  it('non-zero exit with lines: applied, stderr in last_error, rc 4; a clean exit 0 afterwards clears it', () => {
    const d2 = initCrmDatabase(join(tmp, 'cut2.db'))
    const state = freshState()
    const r1 = applyImapDump(d2, state, { lines: imapLines, stderr: 'IMAP select failed: INBOX.Sent', code: 4, killed: false }, NOW)
    expect(r1.rc).toBe(4)
    expect(state.last_error).toMatch(/^IMAP select failed: INBOX.Sent; \d+ lines applied/)
    const r2 = applyImapDump(d2, state, { lines: [], stderr: '', code: 0, killed: false }, NOW + 1)
    expect(r2.rc).toBe(0)
    expect(state.last_error).toBeNull()
    expect(r2.out.partial).toBeUndefined()
    d2.close()
  })
  it('the dump timeout defaults to 600 s and honours CRM_IMAP_DUMP_TIMEOUT_MS', () => {
    expect(resolveDumpTimeoutMs(undefined)).toBe(600_000)
    expect(resolveDumpTimeoutMs('30000')).toBe(30_000)
    expect(resolveDumpTimeoutMs('nope')).toBe(600_000)
    expect(resolveDumpTimeoutMs('0')).toBe(600_000)
  })
})
