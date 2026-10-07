/**
 * fb79dc1f: the reminder sender (src/web/reminder-sender.ts). One tick sends the
 * due reminders on the agent's bot, at most once, inside the recipient's window;
 * success is 'sent' + the Telegram message id and a copy to the agent; a failure
 * is 'failed' + an alert to the main agent; a claim a crash left behind becomes
 * 'failed' and is never sent again; a broken windows config sends nothing. The
 * Bot API is mocked (an injected send, and fetch for the live send path).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A fixed temp root, known before the mocks are built: the install .env and agents/ of the test live here.
const H = vi.hoisted(() => ({ root: `${process.env['TMPDIR'] || '/tmp'}/rem-sender-${process.pid}-${Date.now()}` }))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'chief-test', PROJECT_ROOT: H.root }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { initDatabase, createReminder, getReminder, getDb } = await import('../db.js')
const { reminderTick, liveReminderSend, reminderBotToken, _resetReminderSenderForTest, REMINDER_CLAIM_STALE_SEC } = await import('../web/reminder-sender.js')
import type { ReminderSenderDeps, WindowsLoad } from '../web/reminder-sender.js'
import type { ReminderWindowsConfig } from '../reminder-window.js'

const OWNER_CHAT = '7000000001'
const STAFF_CHAT = '7000000002'
const OWNER_WINDOW: ReminderWindowsConfig = {
  recipients: { [OWNER_CHAT]: { tz: 'Europe/Budapest', quiet: { start: '23:00', end: '07:00' }, weekend: { days: ['sat', 'sun'], resume: { day: 'mon', at: '09:00' } } } },
}
const WED_17 = Date.parse('2026-10-07T15:00:00Z') // Wednesday 17:00 Budapest
const sec = (ms: number) => Math.floor(ms / 1000)

let n = 0
function reminder(over: Partial<Parameters<typeof createReminder>[0]> = {}) {
  n++
  return createReminder({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    requester: 'owner-a', recipient_chat_id: STAFF_CHAT, agent_id: 'area-agent', text: `Szólj a szállítónak (${n})`,
    due_at: sec(WED_17) - 60, send_after: sec(WED_17) - 60, ...over,
  })
}

function deps(over: Partial<ReminderSenderDeps> = {}) {
  const calls = { send: [] as Array<[string, string, string]>, alerts: [] as string[], copies: [] as Array<[string, string]> }
  let now = WED_17
  const d: ReminderSenderDeps = {
    nowMs: () => now,
    windows: (): WindowsLoad => ({ ok: true, config: OWNER_WINDOW }),
    send: async (a, c, t) => { calls.send.push([a, c, t]); return 4242 },
    alertMain: (t) => { calls.alerts.push(t) },
    copyToAgent: (a, t) => { calls.copies.push([a, t]) },
    ...over,
  }
  return { d, calls, setNow: (ms: number) => { now = ms } }
}

beforeEach(() => {
  rmSync(H.root, { recursive: true, force: true })
  mkdirSync(H.root, { recursive: true })
  // the main channel dir of the test: never the host's real ~/.claude/channels/telegram
  process.env['TELEGRAM_STATE_DIR'] = join(H.root, 'tg-state')
  initDatabase(':memory:')
  _resetReminderSenderForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['TELEGRAM_STATE_DIR']
  rmSync(H.root, { recursive: true, force: true })
})

afterAll(() => { try { getDb().close() } catch { /* already closed */ } })

describe('reminderTick', () => {
  it('sends a due reminder: sent + the message id, a copy to the agent, no alert', async () => {
    const r = reminder()
    const { d, calls } = deps()
    const out = await reminderTick(d)
    expect(out.sent).toBe(1)
    expect(calls.send).toEqual([['area-agent', STAFF_CHAT, r.text]])
    const row = getReminder(r.id)!
    expect(row.status).toBe('sent')
    expect(row.sent_message_id).toBe(4242)
    expect(row.sent_at).toBe(sec(WED_17))
    expect(row.attempts).toBe(1)
    expect(calls.copies).toHaveLength(1)
    expect(calls.copies[0][0]).toBe('area-agent')
    expect(calls.copies[0][1]).toContain('[EMLÉKEZTETŐ KIMENT]')
    expect(calls.copies[0][1]).toContain(r.text)
    expect(calls.alerts).toHaveLength(0)
    // sent once: the next tick does nothing
    expect((await reminderTick(d)).sent).toBe(0)
    expect(calls.send).toHaveLength(1)
  })

  it('a failed send: failed + the error, an alert to the main agent and the agent copy', async () => {
    const r = reminder()
    const { d, calls } = deps({ send: async () => { throw new Error('Telegram API 400: {"ok":false,"description":"Bad Request: chat not found"}') } })
    const out = await reminderTick(d)
    expect(out.failed).toBe(1)
    const row = getReminder(r.id)!
    expect(row.status).toBe('failed')
    expect(row.error).toContain('chat not found')
    expect(calls.alerts).toHaveLength(1)
    expect(calls.alerts[0]).toContain('[EMLÉKEZTETŐ HIBA]')
    expect(calls.alerts[0]).toContain(r.id)
    expect(calls.copies).toEqual([['area-agent', calls.alerts[0]]])
    // failed is final: no retry by itself
    await reminderTick(d)
    expect(getReminder(r.id)!.attempts).toBe(1)
  })

  it("the main agent's own failed reminder gets ONE message (the alert), not two", async () => {
    reminder({ agent_id: 'chief-test' })
    const { d, calls } = deps({ send: async () => { throw new Error('boom') } })
    await reminderTick(d)
    expect(calls.alerts).toHaveLength(1)
    expect(calls.copies).toHaveLength(0)
  })

  it('a bot token in an error message is not stored or forwarded', async () => {
    const r = reminder()
    const { d, calls } = deps({ send: async () => { throw new Error('connect ETIMEDOUT https://api.telegram.org/bot123456:AAbbCC-dd_ee/sendMessage') } })
    await reminderTick(d)
    expect(getReminder(r.id)!.error).not.toContain('AAbbCC')
    expect(calls.alerts[0]).not.toContain('AAbbCC')
  })

  it('a reminder not yet due is left alone', async () => {
    const r = reminder({ due_at: sec(WED_17) + 600, send_after: sec(WED_17) + 600 })
    const { d, calls } = deps()
    await reminderTick(d)
    expect(calls.send).toHaveLength(0)
    expect(getReminder(r.id)!.status).toBe('pending')
  })

  it('the window changed since it was planned: the moment moves, nothing is sent', async () => {
    // planned for Wednesday 23:30 Budapest without a window; the owner window now forbids that moment
    const at = Date.parse('2026-10-07T21:30:00Z')
    const r = reminder({ recipient_chat_id: OWNER_CHAT, due_at: sec(at), send_after: sec(at) })
    const { d, calls, setNow } = deps()
    setNow(at + 60_000)
    const out = await reminderTick(d)
    expect(out.deferred).toBe(1)
    expect(calls.send).toHaveLength(0)
    const row = getReminder(r.id)!
    expect(row.status).toBe('pending')
    expect(new Date(row.send_after * 1000).toISOString()).toBe('2026-10-08T05:00:00.000Z')
  })

  it('a SATURDAY reminder to the owner waits for Monday 09:00 Budapest; a flagged one goes', async () => {
    const sat = Date.parse('2026-10-10T08:00:00Z') // Saturday 10:00 Budapest
    const plain = reminder({ recipient_chat_id: OWNER_CHAT, due_at: sec(sat), send_after: sec(sat) })
    const flagged = reminder({ recipient_chat_id: OWNER_CHAT, due_at: sec(sat), send_after: sec(sat), allow_weekend: true })
    const { d, calls, setNow } = deps()
    setNow(sat + 30_000)
    await reminderTick(d)
    expect(calls.send.map(c => c[2])).toEqual([flagged.text])
    expect(getReminder(flagged.id)!.status).toBe('sent')
    expect(getReminder(plain.id)!.status).toBe('pending')
    expect(new Date(getReminder(plain.id)!.send_after * 1000).toISOString()).toBe('2026-10-12T07:00:00.000Z')
    // and on Monday 09:00 Budapest it goes
    setNow(Date.parse('2026-10-12T07:00:30Z'))
    await reminderTick(d)
    expect(getReminder(plain.id)!.status).toBe('sent')
  })

  it('a claim a crash left behind becomes failed (send_uncertain) and is never sent again', async () => {
    const r = reminder()
    getDb().prepare(`UPDATE reminders SET status = 'sending', claimed_at = ? WHERE id = ?`).run(sec(WED_17) - REMINDER_CLAIM_STALE_SEC - 60, r.id)
    const { d, calls } = deps()
    const out = await reminderTick(d)
    expect(out.stale).toBe(1)
    expect(calls.send).toHaveLength(0)
    expect(getReminder(r.id)!.status).toBe('failed')
    expect(getReminder(r.id)!.error).toBe('send_uncertain')
    expect(calls.alerts[0]).toContain('[EMLÉKEZTETŐ BIZONYTALAN]')
  })

  it('a fresh claim (another tick is sending) is not touched', async () => {
    const r = reminder()
    getDb().prepare(`UPDATE reminders SET status = 'sending', claimed_at = ? WHERE id = ?`).run(sec(WED_17) - 30, r.id)
    const { d, calls } = deps()
    await reminderTick(d)
    expect(getReminder(r.id)!.status).toBe('sending')
    expect(calls.send).toHaveLength(0)
  })

  it('a broken windows config sends nothing and alerts the main agent at most once an hour', async () => {
    reminder()
    const { d, calls, setNow } = deps({ windows: () => ({ ok: false, error: 'bad tz' }) })
    const out = await reminderTick(d)
    expect(out.configError).toBe(true)
    expect(calls.send).toHaveLength(0)
    expect(calls.alerts).toHaveLength(1)
    expect(calls.alerts[0]).toContain('bad tz')
    setNow(WED_17 + 10 * 60_000)
    await reminderTick(d)
    expect(calls.alerts).toHaveLength(1)
    setNow(WED_17 + 61 * 60_000)
    await reminderTick(d)
    expect(calls.alerts).toHaveLength(2)
  })

  it('at most once: two overlapping ticks send a reminder once', async () => {
    const r = reminder()
    let release: () => void = () => {}
    const gate = new Promise<void>(res => { release = res })
    const { d, calls } = deps({ send: async (a, c, t) => { calls.send.push([a, c, t]); await gate; return 7 } })
    const t1 = reminderTick(d)
    const t2 = reminderTick(d)
    release()
    await Promise.all([t1, t2])
    expect(calls.send).toHaveLength(1)
    expect(getReminder(r.id)!.status).toBe('sent')
  })
})

describe('the live send path (Bot API mocked)', () => {
  it("sends on the main agent's bot from the install .env and returns the message id", async () => {
    writeFileSync(join(H.root, '.env'), 'TELEGRAM_BOT_TOKEN=111:main-token\n')
    expect(reminderBotToken('chief-test')).toBe('111:main-token')
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 991 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const id = await liveReminderSend('chief-test', OWNER_CHAT, 'Holnap 9-kor könyvelő')
    expect(id).toBe(991)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/bot111:main-token/sendMessage')
    const body = JSON.parse(String(init?.body))
    expect(body.chat_id).toBe(OWNER_CHAT)
    expect(body.text).toBe('[TESZT] Holnap 9-kor könyvelő')
  })

  it("sends on a sub-agent's own bot (its channel .env)", async () => {
    mkdirSync(join(H.root, 'agents', 'area-agent', '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(H.root, 'agents', 'area-agent', '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=222:area-token\n')
    expect(reminderBotToken('area-agent')).toBe('222:area-token')
  })

  it('an agent without a bot token: no_bot_token, nothing posted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(liveReminderSend('area-agent', STAFF_CHAT, 'x')).rejects.toThrow(/no_bot_token/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a Bot API refusal (200 with ok:false) is a failure, not a sent reminder', async () => {
    writeFileSync(join(H.root, '.env'), 'TELEGRAM_BOT_TOKEN=111:main-token\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 200 })))
    await expect(liveReminderSend('chief-test', OWNER_CHAT, 'x')).rejects.toThrow(/blocked/)
  })
})
