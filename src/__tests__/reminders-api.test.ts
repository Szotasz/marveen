/**
 * fb79dc1f: POST / GET / PATCH /api/reminders. The send moment (send_after) is
 * the due time moved by the recipient's window, read from the install's config
 * (here a fixture file via REMINDER_WINDOWS_FILE_PATH); a broken config refuses
 * the reminder (503) instead of storing a moment that ignores the owner's rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { initDatabase, getReminder, listReminders, getDb } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'chief-test', ALLOWED_CHAT_ID: 'test-chat' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../web/agent-config.js')>('../web/agent-config.js')
  return { ...actual, isKnownAgent: (n: string) => ['chief-test', 'area-agent'].includes(n) }
})

const { tryHandleReminders, parseDueAt } = await import('../web/routes/reminders.js')

const OWNER_CHAT = '7000000001'
const STAFF_CHAT = '7000000002'
const WINDOWS = {
  recipients: {
    [OWNER_CHAT]: { tz: 'Europe/Budapest', quiet: { start: '23:00', end: '07:00' }, weekend: { days: ['sat', 'sun'], resume: { day: 'mon', at: '09:00' } } },
  },
}

function makeCtx(path: string, method: string, body?: unknown, query: Record<string, string> = {}, caller?: string) {
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  let status = 200
  let responseBody = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (b?: string) => { responseBody = b || '' },
  }
  const req = body === undefined
    ? Readable.from([]) as any
    : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as any
  const ctx: RouteContext = { req, res: res as any, path, method, url, auth: { kind: 'token', agent: caller } }
  return { ctx, getStatus: () => status, getBody: () => (responseBody ? JSON.parse(responseBody) : null) }
}

async function call(path: string, method: string, body?: unknown, query?: Record<string, string>, caller?: string) {
  const h = makeCtx(path, method, body, query, caller)
  const handled = await tryHandleReminders(h.ctx)
  return { handled, status: h.getStatus(), body: h.getBody() }
}

let dir = ''
const NOW = Date.parse('2026-10-07T15:00:00Z') // Wednesday 17:00 Budapest

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'rem-api-'))
  writeFileSync(join(dir, 'w.json'), JSON.stringify(WINDOWS))
  process.env['REMINDER_WINDOWS_FILE_PATH'] = join(dir, 'w.json')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env['REMINDER_WINDOWS_FILE_PATH']
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => { try { getDb().close() } catch { /* already closed */ } })

const base = (over: Record<string, unknown> = {}) => ({
  requester: 'owner-a', recipient_chat_id: OWNER_CHAT, agent_id: 'chief-test', text: 'Hívd fel a könyvelőt', due_at: '2026-10-07T18:00:00+02:00', ...over,
})

describe('POST /api/reminders', () => {
  it('creates a pending reminder; an allowed due time is its send moment', async () => {
    const r = await call('/api/reminders', 'POST', base(), {}, 'area-agent')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending')
    expect(r.body.due_at).toBe(Date.parse('2026-10-07T16:00:00Z') / 1000)
    expect(r.body.send_after).toBe(r.body.due_at)
    expect(r.body.created_by).toBe('area-agent')
    expect(getReminder(r.body.id)?.text).toBe('Hívd fel a könyvelőt')
  })

  it('a due time in the quiet hours gets the quiet end as its send moment', async () => {
    const r = await call('/api/reminders', 'POST', base({ due_at: '2026-10-07T23:30:00+02:00' }))
    expect(r.status).toBe(201)
    expect(new Date(r.body.send_after * 1000).toISOString()).toBe('2026-10-08T05:00:00.000Z')
  })

  it('a Saturday due time goes Monday 09:00 Budapest; flagged, it stays', async () => {
    const plain = await call('/api/reminders', 'POST', base({ due_at: '2026-10-10T10:00:00+02:00' }))
    expect(new Date(plain.body.send_after * 1000).toISOString()).toBe('2026-10-12T07:00:00.000Z')
    const flagged = await call('/api/reminders', 'POST', base({ due_at: '2026-10-10T10:00:00+02:00', allow_weekend: true }))
    expect(flagged.body.allow_weekend).toBe(1)
    expect(flagged.body.send_after).toBe(flagged.body.due_at)
  })

  it('a recipient without a window goes at its moment, also at night', async () => {
    const r = await call('/api/reminders', 'POST', base({ recipient_chat_id: STAFF_CHAT, due_at: '2026-10-07T23:30:00+02:00' }))
    expect(r.body.send_after).toBe(r.body.due_at)
  })

  it('takes epoch seconds and a numeric chat id', async () => {
    const due = Math.floor(NOW / 1000) + 3600
    const r = await call('/api/reminders', 'POST', base({ due_at: due, recipient_chat_id: Number(STAFF_CHAT) }))
    expect(r.status).toBe(201)
    expect(r.body.due_at).toBe(due)
    expect(r.body.recipient_chat_id).toBe(STAFF_CHAT)
  })

  it('the agent defaults to the caller (X-Agent-Id)', async () => {
    const { agent_id: _drop, ...noAgent } = base()
    const r = await call('/api/reminders', 'POST', noAgent, {}, 'area-agent')
    expect(r.status).toBe(201)
    expect(r.body.agent_id).toBe('area-agent')
  })

  it.each([
    ['no requester', base({ requester: undefined }), 'requester'],
    ['a bad chat id', base({ recipient_chat_id: '@owner' }), 'recipient_chat_id'],
    ['an unknown agent', base({ agent_id: 'nobody' }), 'agent_id'],
    ['an empty text', base({ text: '   ' }), 'text'],
    ['a too long text', base({ text: 'x'.repeat(4001) }), 'text'],
    ['a local time without its zone', base({ due_at: '2026-10-07T18:00:00' }), 'due_at'],
    ['a due time in the past', base({ due_at: '2026-10-07T14:00:00Z' }), 'past'],
    ['a due time more than a year ahead', base({ due_at: '2027-12-01T10:00:00Z' }), 'year'],
    ['a non-boolean allow_weekend', base({ allow_weekend: 'yes' }), 'allow_weekend'],
  ])('refuses %s (400, nothing stored)', async (_n, body, word) => {
    const r = await call('/api/reminders', 'POST', body)
    expect(r.status).toBe(400)
    expect(r.body.error).toContain(word)
    expect(listReminders({})).toHaveLength(0)
  })

  it('refuses invalid JSON', async () => {
    const r = await call('/api/reminders', 'POST', '{not json')
    expect(r.status).toBe(400)
  })

  it('a broken windows config refuses the reminder (503) and stores nothing', async () => {
    writeFileSync(join(dir, 'w.json'), '{"recipients": {"7000000001": {"tz": "Nowhere/City"}}}')
    const r = await call('/api/reminders', 'POST', base())
    expect(r.status).toBe(503)
    expect(listReminders({})).toHaveLength(0)
  })

  it('no windows file: every reminder goes at its moment', async () => {
    delete process.env['REMINDER_WINDOWS_FILE_PATH']
    process.env['REMINDER_WINDOWS_FILE_PATH'] = join(dir, 'missing.json')
    const r = await call('/api/reminders', 'POST', base({ due_at: '2026-10-07T23:30:00+02:00' }))
    expect(r.status).toBe(201)
    expect(r.body.send_after).toBe(r.body.due_at)
  })
})

describe('GET /api/reminders', () => {
  it('lists with filters, reads one, 404 for an unknown id', async () => {
    const a = await call('/api/reminders', 'POST', base())
    await call('/api/reminders', 'POST', base({ recipient_chat_id: STAFF_CHAT, agent_id: 'area-agent', due_at: '2026-10-08T10:00:00+02:00' }))
    const all = await call('/api/reminders', 'GET')
    expect(all.body).toHaveLength(2)
    expect((await call('/api/reminders', 'GET', undefined, { agent: 'area-agent' })).body).toHaveLength(1)
    expect((await call('/api/reminders', 'GET', undefined, { recipient: OWNER_CHAT })).body).toHaveLength(1)
    expect((await call('/api/reminders', 'GET', undefined, { due_to: '2026-10-08T00:00:00Z' })).body).toHaveLength(1)
    expect((await call('/api/reminders', 'GET', undefined, { status: 'sent' })).body).toHaveLength(0)
    const one = await call(`/api/reminders/${a.body.id}`, 'GET')
    expect(one.body.id).toBe(a.body.id)
    expect((await call('/api/reminders/00000000-0000-0000-0000-000000000000', 'GET')).status).toBe(404)
    expect((await call('/api/reminders/not-a-uuid', 'GET')).status).toBe(404)
  })
})

describe('PATCH /api/reminders/:id', () => {
  it('cancels a pending reminder; a second cancel is a conflict', async () => {
    const a = await call('/api/reminders', 'POST', base())
    const c = await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'cancelled' }, {}, 'area-agent')
    expect(c.status).toBe(200)
    expect(c.body.status).toBe('cancelled')
    expect(c.body.updated_by).toBe('area-agent')
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'cancelled' })).status).toBe(409)
  })

  it('a sent reminder cannot be cancelled or edited', async () => {
    const a = await call('/api/reminders', 'POST', base())
    getDb().prepare(`UPDATE reminders SET status = 'sent' WHERE id = ?`).run(a.body.id)
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'cancelled' })).status).toBe(409)
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', { text: 'új' })).status).toBe(409)
  })

  it('editing the due time recomputes the send moment', async () => {
    const a = await call('/api/reminders', 'POST', base())
    const e = await call(`/api/reminders/${a.body.id}`, 'PATCH', { due_at: '2026-10-11T12:00:00+02:00' })
    expect(e.status).toBe(200)
    expect(new Date(e.body.send_after * 1000).toISOString()).toBe('2026-10-12T07:00:00.000Z')
    const f = await call(`/api/reminders/${a.body.id}`, 'PATCH', { allow_weekend: true })
    expect(f.body.send_after).toBe(f.body.due_at)
  })

  it('a failed reminder goes back to pending, from the first allowed moment from now', async () => {
    const a = await call('/api/reminders', 'POST', base())
    getDb().prepare(`UPDATE reminders SET status = 'failed', error = 'Telegram API 500' WHERE id = ?`).run(a.body.id)
    const p = await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'pending' })
    expect(p.status).toBe(200)
    expect(p.body.status).toBe('pending')
    expect(p.body.error).toBeNull()
    expect(p.body.send_after).toBeGreaterThanOrEqual(Math.floor(NOW / 1000))
    // a pending one does not "go back"
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'pending' })).status).toBe(409)
  })

  it('a status move and field edits are separate requests; an unknown status is refused', async () => {
    const a = await call('/api/reminders', 'POST', base())
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'cancelled', text: 'x' })).status).toBe(400)
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', { status: 'sent' })).status).toBe(400)
    expect((await call(`/api/reminders/${a.body.id}`, 'PATCH', {})).status).toBe(400)
  })
})

describe('parseDueAt', () => {
  it('reads epoch seconds and zoned ISO, nothing else', () => {
    expect(parseDueAt(1791392400)).toBe(1791392400)
    expect(parseDueAt('2026-10-07T18:00:00+02:00')).toBe(Date.parse('2026-10-07T16:00:00Z') / 1000)
    expect(parseDueAt('2026-10-07T16:00Z')).toBe(Date.parse('2026-10-07T16:00:00Z') / 1000)
    expect(parseDueAt('2026-10-07T18:00:00')).toBeNull()
    expect(parseDueAt('holnap 9')).toBeNull()
    expect(parseDueAt(1.5)).toBeNull()
    expect(parseDueAt(-1)).toBeNull()
  })
})
