import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// The owner notification of a bound email_send approval -- the
// whole letter in ONE message with the approve/reject buttons, each button with
// its own nonce -- and every path that falls back to the plain,
// button-less notification, a letter too long for one message included (fail-closed:
// no chunks, a chunk without buttons could be rewritten before the decision).
// No network: fetch is stubbed, the DB is in memory, and the owner/channel
// inputs are controlled below.

const state = vi.hoisted(() => ({
  token: '',
  allowedChatId: '',
  accessJson: null as string | null,
  // When set, the delivery target (resolveOwnerChatId) differs from the strict owner.
  ownerChatOverride: null as string | null,
  stateDir: '',
  channelToken: null as string | null,
}))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'marveen',
    get TELEGRAM_BOT_TOKEN() { return state.token },
    get ALLOWED_CHAT_ID() { return state.allowedChatId },
  }
})

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  // The live access.json must never decide a test: the read is replaced, the
  // rules are the real ones.
  const read = () => {
    if (state.accessJson == null) throw new Error('ENOENT')
    return state.accessJson
  }
  return {
    ...real,
    resolveOwnerChatId: vi.fn((_read?: unknown, configured?: string | null) =>
      state.ownerChatOverride ?? real.resolveOwnerChatId(read, configured)),
    resolveAlertOwnerChat: vi.fn((_read?: unknown, configured?: string | null) =>
      real.resolveAlertOwnerChat(read, configured)),
  }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    channelStateDir: vi.fn((provider: Parameters<typeof real.channelStateDir>[0], agentDir?: string) =>
      provider === 'telegram' && !agentDir ? state.stateDir : real.channelStateDir(provider, agentDir)),
    readChannelToken: vi.fn((_provider: string, _path: string) => state.channelToken),
  }
})

// Every nonce the notifier mints is recorded, so the leak check below covers
// the paths where no button message ever carries it out.
const issuedNonces = vi.hoisted(() => [] as string[])

vi.mock('../web/approval-callback-data.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/approval-callback-data.js')>()
  return {
    ...real,
    newCallbackNonce: vi.fn(() => {
      const n = real.newCallbackNonce()
      issuedNonces.push(n)
      return n
    }),
  }
})

vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  return { ...real, setApprovalCallbackNonceHashes: vi.fn(real.setApprovalCallbackNonceHashes) }
})

import { PROJECT_ROOT } from '../config.js'
import { readChannelToken } from '../channel-provider.js'
import { initDatabase, getDb, getApproval, getPendingMessages, setApprovalCallbackNonceHashes } from '../db.js'
import { logger } from '../logger.js'
import {
  tryHandleApprovals, ownerNotificationsSettled, buildOwnerApprovalText,
  telegramBotId, sameTelegramBot, TOO_LONG_FOR_BUTTONS,
  setOwnerNotificationSleep, telegramRetryAfterSeconds,
  APPROVAL_PART_PAUSE_MS, APPROVAL_RETRY_AFTER_CAP_S,
} from '../web/routes/approvals.js'
import { sendTelegramMessage } from '../web/telegram.js'
import { computeContentAnchor, type EnvelopeV1 } from '../approval-envelope.js'
import { parseCallbackData, CALLBACK_DATA_MAX_BYTES } from '../web/approval-callback-data.js'
import { buildBoundApprovalMessages } from '../web/approval-telegram-text.js'
import { TEST_RUN_PREFIX } from '../test-run-marker.js'
import type { RouteContext } from '../web/routes/types.js'

const OWNER = '1000000001'
const BOT_TOKEN = '7000000001:AAsendSECRETpartXYZ'
const SAME_BOT_OTHER_SECRET = '7000000001:AAchannelSECRETpartQRS'
const OTHER_BOT_TOKEN = '7000000002:AAotherSECRETpartLMN'
const SECRETS = ['AAsendSECRETpartXYZ', 'AAchannelSECRETpartQRS', 'AAotherSECRETpartLMN']
const INSTALL_STATE_DIR = join(PROJECT_ROOT, '.claude', 'channels', 'telegram')
const LIMIT = 4096

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// --- fake Telegram -----------------------------------------------------------

type Reply =
  | { kind: 'ok'; messageId: number }
  | { kind: 'http'; status: number; body?: string }
  | { kind: 'okfalse' }
  | { kind: 'malformed' }
  | { kind: 'throw' }
  // A rate-limit refusal: HTTP 429 with the Bot API body, or HTTP 200 + ok:false.
  | { kind: '429'; retryAfter?: number; okFalse?: boolean; echo?: string }

type Call = { url: string; rawBody: string; body: { chat_id: string; text: string; reply_markup?: any } }

let calls: Call[] = []
let nextMessageId = 1000
let reply: (call: Call, index: number) => Reply | Promise<Reply> = () => ({ kind: 'ok', messageId: nextMessageId++ })

function respond(r: Reply): unknown {
  if (r.kind === 'throw') throw new TypeError('fetch failed')
  if (r.kind === 'http') return { ok: false, status: r.status, text: async () => r.body ?? '', json: async () => ({}) }
  if (r.kind === 'okfalse') {
    return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) }
  }
  if (r.kind === '429') {
    const description = `Too Many Requests: retry after ${r.retryAfter ?? 'later'}${r.echo ? ` ${r.echo}` : ''}`
    if (r.okFalse) {
      return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: false, error_code: 429, description }) }
    }
    const body = JSON.stringify({
      ok: false, error_code: 429, description,
      ...(r.retryAfter != null ? { parameters: { retry_after: r.retryAfter } } : {}),
    })
    return { ok: false, status: 429, text: async () => body, json: async () => JSON.parse(body) }
  }
  if (r.kind === 'malformed') {
    return { ok: true, status: 200, text: async () => '', json: async () => { throw new SyntaxError('Unexpected token') } }
  }
  return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, result: { message_id: r.messageId } }) }
}

// One timeline of sends and sleeps, so the pacing is visible in order.
let events: string[] = []

const fakeFetch = vi.fn(async (url: string, init: { body: string }) => {
  const call: Call = { url, rawBody: init.body, body: JSON.parse(init.body) }
  const index = calls.length
  calls.push(call)
  events.push(call.body.reply_markup ? 'send+buttons' : 'send')
  return respond(await reply(call, index))
})

// The notifier's pause/429 sleep: recorded, never really waited (unless a test
// installs its own).
let sleeps: number[] = []
const fakeSleep = async (ms: number) => { sleeps.push(ms); events.push(`sleep:${ms}`) }
let realSleep: ((ms: number) => Promise<void>) | null = null

// Every gate a test holds the queue with. afterEach opens them all, so a test
// that fails mid-way cannot leave the module-wide queue stuck for the next one.
const pendingReleases: Array<() => void> = []
function holdable(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  pendingReleases.push(release)
  return { wait, release }
}

// --- logger capture ----------------------------------------------------------

let logged: unknown[][] = []

function dump(v: unknown): string {
  return JSON.stringify(v, (_k, val) => val instanceof Error ? { name: val.name, message: val.message, stack: val.stack } : val)
}

const warnMessages = () => logged.filter(a => a[0] === 'warn').map(a => a[2] as string)
const warnFor = (reason: string) =>
  logged.filter(a => a[0] === 'warn' && (a[1] as { reason?: string })?.reason === reason)

// --- route helpers -----------------------------------------------------------

function fakeReq(body: unknown) {
  const bodyStr = JSON.stringify(body)
  return {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
}

async function route(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<{ status: number; body: any; raw: string }> {
  const out = { status: 0, body: null as any, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  expect(await tryHandleApprovals({ req: fakeReq(body), res, path, method, url } as unknown as RouteContext)).toBe(true)
  return out
}

function envelope(over: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return {
    envelope_v: 1,
    to: ['ugyfel@example.com'],
    cc: ['colleague@example.com'],
    bcc: [],
    text: 'Ajánlat: Minta projekt\nTisztelt Ügyfelünk!\n\nCsatoltan küldjük az ajánlatot.\n\nÜdvözlettel:\nÜgyfélszolgálat',
    subject: 'Ajánlat: Minta projekt',
    ...over,
  }
}

// POST a bound email_send approval (the payload is the letter its hash approves).
async function postBound(env: EnvelopeV1 = envelope(), agentId = 'marveen') {
  const hash = computeContentAnchor(env)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  const out = await route('POST', '/api/approvals', {
    agent_id: agentId,
    category: 'email_send',
    action_description: 'Levél az ügyfélnek: ajánlat',
    action_payload: JSON.stringify(env),
    content_hash: hash,
    timeout_seconds: 3600,
  })
  expect(out.status).toBe(201)
  return out.body as { id: string; content_hash: string }
}

async function postRaw(body: Record<string, unknown>) {
  const out = await route('POST', '/api/approvals', { agent_id: 'marveen', action_description: 'Levél: valami', timeout_seconds: 3600, ...body })
  expect(out.status).toBe(201)
  return out.body as { id: string }
}

const storedHashes = (id: string) =>
  getDb().prepare('SELECT callback_nonce_hash_approve AS approved, callback_nonce_hash_reject AS rejected FROM approvals WHERE id = ?')
    .get(id) as { approved: string | null; rejected: string | null }
const UNBOUND = { approved: null, rejected: null }

const fallbacks = () => getPendingMessages('marveen').filter(m => m.content.includes('[OWNER_UNREACHED'))

// The press as the plugin sends it (POST /api/approvals/:id/telegram).
function press(id: string, nonce: string, messageId: number, status = 'approved') {
  return route('POST', `/api/approvals/${id}/telegram`, {
    status,
    resolved_by: `owner:telegram:${OWNER}`,
    telegram_message_id: messageId,
    telegram_chat_id: OWNER,
    telegram_chat_type: 'private',
    callback_nonce: nonce,
    callback_protocol: 1,
  })
}

// The nonces the button message carried (approve, reject), with the buttons
// checked on the way: each button has its OWN nonce.
function buttonsOf(call: Call, approvalId: string): { nonce: string; rejectNonce: string } {
  const kb = call.body.reply_markup
  expect(kb).toBeTruthy()
  expect(kb.inline_keyboard).toHaveLength(1)
  const [approve, reject] = kb.inline_keyboard[0]
  expect(kb.inline_keyboard[0]).toHaveLength(2)
  expect(approve.text).toBe('✅ Jóváhagyom')
  expect(reject.text).toBe('❌ Elutasítom')
  for (const b of [approve, reject]) expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
  const a = parseCallbackData(approve.callback_data)
  const r = parseCallbackData(reject.callback_data)
  expect(a).toMatchObject({ decision: 'approved', approvalId })
  expect(r).toMatchObject({ decision: 'rejected', approvalId })
  expect(a?.nonce).not.toBe(r?.nonce)
  return { nonce: a!.nonce, rejectNonce: r!.nonce }
}

// The nonce (and its hash) appear nowhere but in the button message's
// reply_markup: not in a text, a URL, another call, a log line or a DB message.
function expectNoLeak(nonce: string) {
  for (const c of calls) {
    expect(c.url).not.toContain(nonce)
    expect(c.body.text).not.toContain(nonce)
    const { reply_markup: _kb, ...rest } = c.body
    expect(JSON.stringify(rest)).not.toContain(nonce)
  }
  // Only the button message carries it; a 429 retry resends that very message.
  const withNonce = calls.filter(c => c.rawBody.includes(nonce))
  expect(withNonce.length).toBeLessThanOrEqual(2)
  for (const c of withNonce) {
    expect(c.body.reply_markup).toBeTruthy()
    expect(c.rawBody).toBe(withNonce[0]!.rawBody)
  }
  const logs = dump(logged)
  expect(logs).not.toContain(nonce)
  expect(logs).not.toContain(sha(nonce))
  for (const s of SECRETS) expect(logs).not.toContain(s)
  expect(dump(getPendingMessages())).not.toContain(nonce)
}

beforeEach(() => {
  initDatabase(':memory:')
  state.token = BOT_TOKEN
  state.allowedChatId = OWNER
  state.accessJson = null
  state.ownerChatOverride = null
  state.stateDir = INSTALL_STATE_DIR
  state.channelToken = SAME_BOT_OTHER_SECRET
  calls = []
  events = []
  sleeps = []
  realSleep = setOwnerNotificationSleep(fakeSleep)
  issuedNonces.length = 0
  nextMessageId = 1000
  reply = () => ({ kind: 'ok', messageId: nextMessageId++ })
  fakeFetch.mockClear()
  vi.mocked(readChannelToken).mockClear()
  vi.stubGlobal('fetch', fakeFetch)
  logged = []
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push([level, ...args]) }) as never)
  }
})

afterEach(async () => {
  setOwnerNotificationSleep(fakeSleep)
  for (const r of pendingReleases.splice(0)) r()
  await ownerNotificationsSettled()
  // Two nonces per button notification, and none of them leaked anywhere.
  for (const n of issuedNonces) expectNoLeak(n)
  if (realSleep) setOwnerNotificationSleep(realSleep)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bound letter: the button message', () => {
  it('short letter: ONE message with the whole letter and two buttons, stamped and bound with one nonce per button', async () => {
    const env = envelope()
    const { id } = await postBound(env)
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(1)
    const [msg] = calls as [Call]
    expect(msg.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
    expect(msg.body.chat_id).toBe(OWNER)
    expect(msg.body.text.startsWith(TEST_RUN_PREFIX)).toBe(true)
    expect(msg.body.text).toContain(env.text)
    expect(msg.body.text).toContain('Címzett: ugyfel@example.com')
    expect(msg.body.text).toContain(`id: ${id.slice(0, 8)}`)
    expect(msg.body.text).toContain('Első sor (a kérő szerint tárgy): Ajánlat: Minta projekt')
    expect(msg.body.text.length).toBeLessThanOrEqual(LIMIT)
    const { nonce, rejectNonce } = buttonsOf(msg, id)

    const row = getApproval(id)!
    expect(row.telegram_message_id).toBe(1000)
    expect(storedHashes(id)).toEqual({ approved: sha(nonce), rejected: sha(rejectNonce) })
    expect(issuedNonces).toEqual([nonce, rejectNonce])
    expect(fallbacks()).toHaveLength(0)
    expectNoLeak(nonce)
    expectNoLeak(rejectNonce)
    const sent = logged.find(a => a[0] === 'info' && a[2] === 'approval owner notification sent')![1] as Record<string, unknown>
    expect(sent).toEqual({ approvalId: id, messageId: 1000, buttons: true })

    // The button the owner got decides the approval through the Telegram endpoint.
    const out = await press(id, nonce, 1000)
    expect(out.status).toBe(200)
    expect(out.body.approval.status).toBe('approved')
    expect(out.raw).not.toContain(nonce)
    expect(storedHashes(id)).toEqual(UNBOUND)
  })

  it('the reject button of the same message decides with its OWN nonce', async () => {
    const { id } = await postBound()
    await ownerNotificationsSettled()
    const { rejectNonce } = buttonsOf(calls[0]!, id)
    const out = await press(id, rejectNonce, 1000, 'rejected')
    expect(out.status).toBe(200)
    expect(out.body.approval.status).toBe('rejected')
  })

  it('the reject button\'s nonce cannot approve, nor the approve button\'s reject (403 bad_nonce, still pending)', async () => {
    const { id } = await postBound()
    await ownerNotificationsSettled()
    const { nonce, rejectNonce } = buttonsOf(calls[0]!, id)
    const swapped = [await press(id, rejectNonce, 1000, 'approved'), await press(id, nonce, 1000, 'rejected')]
    for (const out of swapped) {
      expect(out.status).toBe(403)
      expect(out.body).toEqual({ ok: false, reason: 'bad_nonce' })
    }
    expect(getApproval(id)!.status).toBe('pending')
    expect(storedHashes(id)).toEqual({ approved: sha(nonce), rejected: sha(rejectNonce) })
  })

  // The buttons go out only when the WHOLE letter fits the one message
  // that carries them. The boundary is computed from the same buildBoundApprovalMessages, at
  // a fixed clock (the expiry line's width depends on the hour).
  it('the longest letter that fits one message gets the buttons; one more character gets the plain notice with the too-long line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T10:30:00Z'))
    try {
      const nowS = Math.floor(Date.now() / 1000)
      const fits = (len: number) => {
        const r = buildBoundApprovalMessages(
          { to: ['ugyfel@example.com'], cc: ['colleague@example.com'], bcc: [], text: 'x'.repeat(len) },
          { agentId: 'marveen', shortId: 'abcdef01', hash8: 'abcdef01', timeoutAt: nowS + 3600, windowMinutes: 30 },
          { limit: LIMIT - TEST_RUN_PREFIX.length, reserve: 300 },
        )
        return !('unfit' in r) && r.chunks.length === 0
      }
      let max = 0
      while (fits(max + 1)) max++
      expect(max).toBeGreaterThan(3000)
      expect(fits(max + 1)).toBe(false)

      const a = await postBound(envelope({ text: 'x'.repeat(max), subject: undefined }))
      await ownerNotificationsSettled()
      expect(calls).toHaveLength(1)
      buttonsOf(calls[0]!, a.id)
      expect(calls[0]!.body.text).toContain('x'.repeat(max))
      // with the outcome line the plugin appends, the message still fits
      expect(calls[0]!.body.text.length + 300).toBeLessThanOrEqual(LIMIT)

      calls = []
      issuedNonces.length = 0
      const b = await postBound(envelope({ text: 'x'.repeat(max + 1), subject: undefined }))
      await ownerNotificationsSettled()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.body.reply_markup).toBeUndefined()
      expect(calls[0]!.rawBody).toBe(JSON.stringify({
        chat_id: OWNER, text: `${TEST_RUN_PREFIX}${buildOwnerApprovalText(getApproval(b.id)!)}\n${TOO_LONG_FOR_BUTTONS}`,
      }))
      expect(issuedNonces).toHaveLength(0)
      expect(storedHashes(b.id)).toEqual(UNBOUND)
      expect(warnFor('too_long')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a long letter: ONE plain message, no chunk, no button, no nonce; stamped but unbound, so every press is not_bound', async () => {
    const line = 'Ez a levél egy hosszú sora, ékezetekkel és emojival 🔥 együtt.\n'
    const text = 'Ajánlat: hosszú\n' + line.repeat(200)
    const { id } = await postBound(envelope({ text, subject: 'Ajánlat: hosszú' }))
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(1)
    const [msg] = calls as [Call]
    expect(msg.body.reply_markup).toBeUndefined()
    expect(msg.body.text).toBe(`${TEST_RUN_PREFIX}${buildOwnerApprovalText(getApproval(id)!)}\n${TOO_LONG_FOR_BUTTONS}`)
    expect(msg.body.text).toContain('Döntés: Dashboard')
    expect(msg.body.text).not.toMatch(/\[JÓVÁHAGYÁS [0-9a-f]{8} \|/) // no chunk header
    expect(issuedNonces).toHaveLength(0)
    expect(storedHashes(id)).toEqual(UNBOUND)
    expect(getApproval(id)!.telegram_message_id).toBe(1000)
    expect(logged.find(a => a[0] === 'info' && a[2] === 'approval owner notification sent')![1])
      .toEqual({ approvalId: id, messageId: 1000, buttons: false, buttons_withheld: 'too_long' })
    expect(fallbacks()).toHaveLength(0)
    for (const nonce of ['A'.repeat(22), 'B'.repeat(22)]) {
      const out = await press(id, nonce, 1000)
      expect(out.status).toBe(409)
      expect(out.body.reason).toBe('not_bound')
    }
    expect(getApproval(id)!.status).toBe('pending')
  })
})

describe('bound letter: a failed button message never leaves a decidable message', () => {
  const FAILED = 'approval owner notification FAILED -- the request is only visible on the dashboard'
  const PLAIN_AFTER = 'approval plain notification sent after the failed button notification (not stamped, not bound)'
  const failures: [string, Reply][] = [
    ['HTTP 500', { kind: 'http', status: 500, body: 'Internal Server Error' }],
    ['HTTP 403', { kind: 'http', status: 403, body: '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' }],
    ['ok:false', { kind: 'okfalse' }],
    ['network error', { kind: 'throw' }],
  ]

  // The best-effort plain notice after a failed button message: today's text,
  // no buttons, and its id is NOT stamped.
  function expectPlainNotice(call: Call, id: string) {
    expect(call.body.reply_markup).toBeUndefined()
    expect(call.rawBody).toBe(JSON.stringify({ chat_id: OWNER, text: TEST_RUN_PREFIX + buildOwnerApprovalText(getApproval(id)!) }))
    expect(getApproval(id)!.telegram_message_id).toBeNull()
  }

  it.each(failures)('the button message fails (%s): one plain notice (unstamped) after the pause, loud, in-band fallback; a later press is not_bound', async (_name, failure) => {
    reply = (c) => c.body.reply_markup ? failure : { kind: 'ok', messageId: nextMessageId++ }
    const { id } = await postBound()
    await ownerNotificationsSettled()

    // the button message (failed, no retry: not a 429), the plain notice.
    expect(calls).toHaveLength(2)
    expectPlainNotice(calls[1]!, id)
    expect(events).toEqual(['send+buttons', `sleep:${APPROVAL_PART_PAUSE_MS}`, 'send'])
    expect(logged.some(a => a[2] === PLAIN_AFTER)).toBe(true)
    expect(warnMessages()).toContain(FAILED)
    expect(dump(logged.find(a => a[2] === FAILED))).toContain('approval button message failed')
    const fb = fallbacks()
    expect(fb).toHaveLength(1)
    expect(fb[0]!.content).toContain('[OWNER_UNREACHED send-failed]')
    expect(fb[0]!.content).toContain(`id=${id}`)

    // Even the real nonces cannot decide: without a stamped message id the row
    // is not_bound -- also for the plain notice's id.
    const { nonce, rejectNonce } = buttonsOf(calls[0]!, id)
    expect(storedHashes(id)).toEqual({ approved: sha(nonce), rejected: sha(rejectNonce) })
    for (const mid of [1000, 1001]) {
      for (const [n, st] of [[nonce, 'approved'], [rejectNonce, 'rejected']] as const) {
        const out = await press(id, n, mid, st)
        expect(out.status).toBe(409)
        expect(out.body.reason).toBe('not_bound')
      }
    }
    expect(getApproval(id)!.status).toBe('pending')
  })

  it('the plain notice is ONE attempt: when it fails too, that is logged and nothing more is sent', async () => {
    reply = () => ({ kind: 'http', status: 502, body: 'Bad Gateway' })
    const { id } = await postBound()
    await ownerNotificationsSettled()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.reply_markup).toBeUndefined()
    expect(warnMessages()).toContain('approval plain notification after the failed button notification failed too')
    expect(getApproval(id)!.telegram_message_id).toBeNull()
    expect(fallbacks()).toHaveLength(1)
  })

  it('the plain notice is not retried even on a 429', async () => {
    reply = (c) => c.body.reply_markup ? { kind: 'http', status: 400 } : { kind: '429', retryAfter: 5 }
    await postBound()
    await ownerNotificationsSettled()
    expect(events).toEqual(['send+buttons', `sleep:${APPROVAL_PART_PAUSE_MS}`, 'send'])
    expect(warnMessages()).toContain('approval plain notification after the failed button notification failed too')
  })

  it('the button message fails and Telegram echoes BOTH buttons\' data: the error is logged with neither nonce', async () => {
    let nonces: string[] = []
    reply = (c) => {
      const row: { callback_data: string }[] | undefined = c.body.reply_markup?.inline_keyboard?.[0]
      if (row) {
        nonces = row.map(b => parseCallbackData(b.callback_data)!.nonce)
        return { kind: 'http', status: 400, body: `{"ok":false,"description":"Bad Request: ${row[0]!.callback_data} ${row[1]!.callback_data}"}` }
      }
      return { kind: 'ok', messageId: nextMessageId++ }
    }
    const { id } = await postBound()
    await ownerNotificationsSettled()

    expect(nonces).toHaveLength(2)
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(calls).toHaveLength(2)
    expectPlainNotice(calls[1]!, id)
    expect(fallbacks()).toHaveLength(1)
    const failed = logged.find(a => a[2] === FAILED)!
    expect(dump(failed)).toContain('approval button message failed: Telegram API 400')
    expect(dump(failed)).toContain('<redacted>')
    for (const n of nonces) expectNoLeak(n)
    const out = await press(id, nonces[0]!, 1000)
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('not_bound')
  })

  it('the button message returns no message_id: not stamped, loud, and every later press is not_bound', async () => {
    reply = () => ({ kind: 'malformed' })
    const { id } = await postBound()
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(1)
    const { nonce, rejectNonce } = buttonsOf(calls[0]!, id)
    expect(getApproval(id)!.telegram_message_id).toBeNull()
    expect(warnMessages().some(m => m.includes('without a message_id'))).toBe(true)
    // The message did reach the owner: no in-band fallback, no plain notice.
    expect(fallbacks()).toHaveLength(0)
    expectNoLeak(nonce)

    for (const mid of [1, 1000, 999_999]) {
      expect((await press(id, nonce, mid)).body.reason).toBe('not_bound')
      expect((await press(id, rejectNonce, mid, 'rejected')).body.reason).toBe('not_bound')
    }
    expect(getApproval(id)!.status).toBe('pending')
  })
})

describe('pacing and the Telegram rate limit', () => {
  const RETRY = 'approval notification hit the Telegram rate limit (429): one retry after the wait'

  it('a button notification is ONE send with no pause; the pause only comes before a plain notice after a failure', async () => {
    const { id } = await postBound()
    await ownerNotificationsSettled()
    expect(events).toEqual(['send+buttons'])
    expect(sleeps).toEqual([])
    buttonsOf(calls[0]!, id)
  })

  it('a 429 on the button message waits retry_after once, resends the SAME message, and it is stamped', async () => {
    reply = (_c, i) => i === 0 ? { kind: '429', retryAfter: 7 } : { kind: 'ok', messageId: nextMessageId++ }
    const { id } = await postBound()
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(2)
    expect(calls[1]!.rawBody).toBe(calls[0]!.rawBody)
    expect(events).toEqual(['send+buttons', 'sleep:7000', 'send+buttons'])
    const { nonce } = buttonsOf(calls[1]!, id)
    expect(getApproval(id)!.telegram_message_id).toBe(1000)
    expect(logged.filter(a => a[2] === RETRY)).toHaveLength(1)
    expect(fallbacks()).toHaveLength(0)
    expect((await press(id, nonce, 1000)).status).toBe(200)
  })

  it(`a long retry_after is capped at ${APPROVAL_RETRY_AFTER_CAP_S} s`, async () => {
    reply = (_c, i) => i === 0 ? { kind: '429', retryAfter: 600 } : { kind: 'ok', messageId: nextMessageId++ }
    const { id } = await postBound()
    await ownerNotificationsSettled()
    expect(sleeps).toEqual([APPROVAL_RETRY_AFTER_CAP_S * 1000])
    expect(calls).toHaveLength(2)
    buttonsOf(calls[1]!, id)
    expect(getApproval(id)!.telegram_message_id).toBe(1000)
  })

  it('a 429 as HTTP 200 + ok:false (error_code 429) is retried too, by the "retry after N" text', async () => {
    reply = (_c, i) => i === 0 ? { kind: '429', retryAfter: 4, okFalse: true } : { kind: 'ok', messageId: nextMessageId++ }
    const { id } = await postBound()
    await ownerNotificationsSettled()
    expect(sleeps).toEqual([4000])
    buttonsOf(calls[1]!, id)
  })

  it('a second 429 on the same message: the sequence fails (one retry only), plain notice, fallback', async () => {
    reply = (c) => c.body.reply_markup ? { kind: '429', retryAfter: 2 } : { kind: 'ok', messageId: nextMessageId++ }
    const { id } = await postBound()
    await ownerNotificationsSettled()
    // button message, its one retry, then the plain notice.
    expect(events).toEqual(['send+buttons', 'sleep:2000', 'send+buttons', `sleep:${APPROVAL_PART_PAUSE_MS}`, 'send'])
    expect(logged.filter(a => a[2] === RETRY)).toHaveLength(1)
    expect(getApproval(id)!.telegram_message_id).toBeNull()
    expect(fallbacks()).toHaveLength(1)
    expect(dump(logged.find(a => a[2] === 'approval owner notification FAILED -- the request is only visible on the dashboard'))).toContain('Telegram API 429')
  })

  it('a 429 that echoes the button data: retried, and neither the retry line nor anything else logs the nonce', async () => {
    reply = (c, i) => {
      const data: string | undefined = c.body.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data
      return i === 0 && data ? { kind: '429', retryAfter: 1, echo: data } : { kind: 'ok', messageId: nextMessageId++ }
    }
    const { id } = await postBound()
    await ownerNotificationsSettled()
    expect(calls).toHaveLength(2)
    const { nonce } = buttonsOf(calls[1]!, id)
    expect(getApproval(id)!.telegram_message_id).toBe(1000)
    expect(logged.filter(a => a[2] === RETRY).map(a => a[1])).toEqual([{ approvalId: id, waitS: 1 }])
    expectNoLeak(nonce)
  })

  it.each([
    ['HTTP 500', { kind: 'http', status: 500 } as Reply],
    ['HTTP 400', { kind: 'http', status: 400, body: '{"ok":false,"error_code":400,"description":"Bad Request"}' } as Reply],
    ['network error', { kind: 'throw' } as Reply],
  ])('%s is never retried', async (_name, failure) => {
    reply = (_c, i) => i === 0 ? failure : { kind: 'ok', messageId: nextMessageId++ }
    await postBound()
    await ownerNotificationsSettled()
    // the failed button message, then the plain notice: no second try of the button message.
    expect(events).toEqual(['send+buttons', `sleep:${APPROVAL_PART_PAUSE_MS}`, 'send'])
    expect(logged.filter(a => a[2] === RETRY)).toHaveLength(0)
  })

  describe('telegramRetryAfterSeconds', () => {
    it.each([
      ['Telegram API 429: {"ok":false,"error_code":429,"description":"Too Many Requests: retry after 5","parameters":{"retry_after":5}}', 5],
      ['Telegram API 429: ok:false Too Many Requests: retry after 12', 12],
      ['Telegram API 429: {"parameters":{"retry_after":9999}}', APPROVAL_RETRY_AFTER_CAP_S],
      ['Telegram API 429: {"parameters":{"retry_after":0}}', 1],
      ['Telegram API 429: Too Many Requests', 3],
    ])('%j -> %d', (message, seconds) => {
      expect(telegramRetryAfterSeconds(new Error(message))).toBe(seconds)
    })

    it.each([
      ['Telegram API 500: retry after 5'],
      ['Telegram API 4290: retry after 5'],
      ['fetch failed'],
      ['something Telegram API 429: retry after 5'],
    ])('%j -> null', (message) => {
      expect(telegramRetryAfterSeconds(new Error(message))).toBeNull()
    })

    it('a non-Error is no 429', () => {
      expect(telegramRetryAfterSeconds('Telegram API 429: retry after 5')).toBeNull()
      expect(telegramRetryAfterSeconds(undefined)).toBeNull()
    })
  })
})

describe('serialisation: concurrent notifications never interleave', () => {
  it('two button letters and a plain request posted together go out one after the other, each with its own nonces', async () => {
    reply = async () => {
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 6)))
      return { kind: 'ok', messageId: nextMessageId++ }
    }
    const [a, b, p] = await Promise.all([
      postBound(envelope({ to: ['elso@example.com'] })),
      postBound(envelope({ to: ['masodik@example.com'] })),
      postRaw({ category: 'skill_patch' }),
    ])
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(3)
    const ka = buttonsOf(calls.find(c => c.body.text.includes(a.id.slice(0, 8)))!, a.id)
    const kb = buttonsOf(calls.find(c => c.body.text.includes(b.id.slice(0, 8)))!, b.id)
    expect(new Set([ka.nonce, ka.rejectNonce, kb.nonce, kb.rejectNonce]).size).toBe(4)
    expect(calls.filter(c => c.body.reply_markup)).toHaveLength(2)
    expect(calls.find(c => c.body.text.includes(p.id))!.body.reply_markup).toBeUndefined()
  })

  it('two failing button letters: each failed button message is followed by ITS plain notice, never interleaved', async () => {
    reply = async (c) => {
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 6)))
      return c.body.reply_markup ? { kind: 'http', status: 500 } : { kind: 'ok', messageId: nextMessageId++ }
    }
    const [a, b, p] = await Promise.all([
      postBound(envelope({ to: ['elso@example.com'] })),
      postBound(envelope({ to: ['masodik@example.com'] })),
      postRaw({ category: 'skill_patch' }),
    ])
    await ownerNotificationsSettled()

    const owner = (c: Call) =>
      c.body.text.includes(a.id.slice(0, 8)) ? 'a' : c.body.text.includes(b.id.slice(0, 8)) ? 'b' : c.body.text.includes(p.id) ? 'p' : '?'
    const seq: string[] = calls.map(owner)
    expect(seq).not.toContain('?')
    // Each notification is one contiguous run (three runs, none repeated).
    const runs = seq.filter((x, i) => i === 0 || seq[i - 1] !== x)
    expect([...runs].sort()).toEqual(['a', 'b', 'p'])
    expect(seq.filter(x => x === 'a')).toHaveLength(2)
    expect(seq.filter(x => x === 'b')).toHaveLength(2)
    for (const k of ['a', 'b']) {
      expect(calls[seq.indexOf(k)]!.body.reply_markup).toBeTruthy()
      expect(calls[seq.lastIndexOf(k)]!.body.reply_markup).toBeUndefined()
    }
    expect(getApproval(a.id)!.telegram_message_id).toBeNull()
    expect(getApproval(b.id)!.telegram_message_id).toBeNull()
  })

  it('a failed notification does not stop the next one', async () => {
    reply = (_c, i) => i === 0 ? { kind: 'throw' } : { kind: 'ok', messageId: nextMessageId++ }
    const first = await postBound()
    const second = await postBound(envelope({ to: ['masik@example.com'] }))
    await ownerNotificationsSettled()
    // first: the failed button message + its plain notice; then the second one.
    expect(calls).toHaveLength(3)
    expect(calls[1]!.body.text).toContain(first.id)
    expect(getApproval(first.id)!.telegram_message_id).toBeNull()
    buttonsOf(calls[2]!, second.id)
    expect(getApproval(second.id)!.telegram_message_id).toBe(1001)
  })
})

describe('plain notification (no buttons): today\'s text, one message', () => {
  async function expectPlain(id: string, tail = '') {
    await ownerNotificationsSettled()
    expect(calls).toHaveLength(1)
    const msg = calls[0]!
    expect(msg.body.reply_markup).toBeUndefined()
    expect(msg.rawBody).toBe(JSON.stringify({ chat_id: msg.body.chat_id, text: TEST_RUN_PREFIX + buildOwnerApprovalText(getApproval(id)!) + tail }))
    expect(msg.body.text).toContain('Döntés: Dashboard')
    expect(storedHashes(id)).toEqual(UNBOUND)
    expect(getApproval(id)!.telegram_message_id).toBe(1000)
    // A refused precondition is decided before any nonce exists.
    expect(issuedNonces).toHaveLength(0)
  }

  const sentLine = () => logged.find(a => a[0] === 'info' && a[2] === 'approval owner notification sent')![1] as Record<string, unknown>

  it('not email_send: plain, the reason only on the "sent" line', async () => {
    const { id } = await postRaw({ category: 'skill_patch' })
    await expectPlain(id)
    expect(sentLine()).toMatchObject({ buttons: false, buttons_withheld: 'not_email_send' })
    expect(warnMessages().filter(m => m.includes('WITHOUT buttons'))).toHaveLength(0)
  })

  it('email_send without a payload: plain, quiet', async () => {
    const env = envelope()
    const { id } = await postRaw({ category: 'email_send', content_hash: computeContentAnchor(env) })
    await expectPlain(id)
    expect(sentLine()).toMatchObject({ buttons: false, buttons_withheld: 'no_payload' })
  })

  it('email_send without a content_hash: plain, quiet', async () => {
    const { id } = await postRaw({ category: 'email_send', action_payload: JSON.stringify(envelope()) })
    await expectPlain(id)
    expect(sentLine()).toMatchObject({ buttons_withheld: 'no_content_hash' })
  })

  it('a malformed payload: plain, with a warning', async () => {
    const { id } = await postRaw({ category: 'email_send', action_payload: '{"envelope_v":1,', content_hash: 'ab'.repeat(32) })
    await expectPlain(id)
    expect(warnFor('bad_payload')).toHaveLength(1)
  })

  it('a payload that is not the letter the hash approves: plain, with a warning, no hash in the log', async () => {
    const shown = envelope()
    const approved = envelope({ to: ['masvalaki@example.com'] })
    const hash = computeContentAnchor(approved)!
    const { id } = await postRaw({ category: 'email_send', action_payload: JSON.stringify(shown), content_hash: hash })
    await expectPlain(id)
    expect(warnFor('hash_mismatch')).toHaveLength(1)
    expect(dump(logged)).not.toContain(hash)
    expect(dump(logged)).not.toContain('ugyfel@example.com')
  })

  it('the delivery chat is not the strict owner: plain', async () => {
    state.ownerChatOverride = '555000555'
    const { id } = await postBound()
    await expectPlain(id)
    expect(calls[0]!.body.chat_id).toBe('555000555')
    expect(warnFor('owner_chat_mismatch')).toHaveLength(1)
  })

  it('no strict owner (placeholder .env, two DM entries): plain to the first entry', async () => {
    state.allowedChatId = '0'
    state.accessJson = JSON.stringify({ allowFrom: [OWNER, '42424242'] })
    const { id } = await postBound()
    await expectPlain(id)
    expect(calls[0]!.body.chat_id).toBe(OWNER)
    expect(warnFor('owner_unresolved')).toHaveLength(1)
  })

  it('a group as the configured chat is no owner: plain', async () => {
    state.allowedChatId = '-1001234567890'
    const { id } = await postBound()
    await expectPlain(id)
    expect(warnFor('owner_unresolved')).toHaveLength(1)
  })

  it('the channel plugin polls ANOTHER bot: plain, and neither token is logged', async () => {
    state.channelToken = OTHER_BOT_TOKEN
    const { id } = await postBound()
    await expectPlain(id)
    expect(warnFor('bot_mismatch')).toHaveLength(1)
    expect(vi.mocked(readChannelToken)).toHaveBeenCalledWith('telegram', join(INSTALL_STATE_DIR, '.env'))
    const logs = dump(logged)
    for (const s of SECRETS) expect(logs).not.toContain(s)
    expect(logs).not.toContain('7000000002')
  })

  it('no token in the channel .env: plain', async () => {
    state.channelToken = null
    const { id } = await postBound()
    await expectPlain(id)
    expect(warnFor('bot_mismatch')).toHaveLength(1)
  })

  it('a legacy (shared ~/.claude) state dir: plain, the channel token is not even read', async () => {
    state.stateDir = '/home/someone/.claude/channels/telegram'
    const { id } = await postBound()
    await expectPlain(id)
    expect(warnFor('state_dir_not_install_scoped')).toHaveLength(1)
    expect(vi.mocked(readChannelToken)).not.toHaveBeenCalled()
  })

  it('identification that cannot fit one message (huge recipient list): plain, with the too-long line', async () => {
    const to = Array.from({ length: 250 }, (_, i) => `cimzett.szama.${i}@nagyon-hosszu-domain.example.com`)
    const { id } = await postBound(envelope({ to }))
    await expectPlain(id, `\n${TOO_LONG_FOR_BUTTONS}`)
    expect(warnFor('too_long')).toHaveLength(1)
  })

  it('the too-long line is only for a bound letter too long for the buttons, never for the other plain notices', async () => {
    const { id } = await postRaw({ category: 'skill_patch' })
    await expectPlain(id)
    expect(calls[0]!.body.text).not.toContain(TOO_LONG_FOR_BUTTONS)
  })

  const SKIPPED = 'approval owner notification skipped: decided, expired or gone while it waited in the queue'

  // A plain request whose send hangs until released, so the next one waits in the queue.
  function blockFirstSend(): () => void {
    const gate = holdable()
    reply = async (_c, i) => {
      if (i === 0) await gate.wait
      return { kind: 'ok', messageId: nextMessageId++ }
    }
    return gate.release
  }

  it('decided while it waited in the queue: NOT sent at all, one log line, no nonce minted', async () => {
    const release = blockFirstSend()
    const blocker = await postRaw({ category: 'skill_patch' })
    const { id } = await postBound()
    const out = await route('PATCH', `/api/approvals/${id}`, { status: 'rejected', resolved_by: 'dashboard' })
    expect(out.status).toBe(200)
    release()
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.text).toContain(blocker.id)
    const skipped = logged.filter(a => a[2] === SKIPPED)
    expect(skipped.map(a => a[1])).toEqual([{ approvalId: id, status: 'rejected', expired: false }])
    expect(issuedNonces).toHaveLength(0)
    expect(storedHashes(id)).toEqual(UNBOUND)
    expect(getApproval(id)!.telegram_message_id).toBeNull()
    expect(fallbacks()).toHaveLength(0)
  })

  it('past its deadline while it waited (the sweeper has not run yet): NOT sent, logged as expired', async () => {
    const release = blockFirstSend()
    await postRaw({ category: 'skill_patch' })
    const { id } = await postBound()
    getDb().prepare('UPDATE approvals SET timeout_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, id)
    release()
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(1)
    expect(logged.filter(a => a[2] === SKIPPED).map(a => a[1])).toEqual([{ approvalId: id, status: 'pending', expired: true }])
    expect(issuedNonces).toHaveLength(0)
    expect(getApproval(id)!.status).toBe('pending')
  })

  it('swept to timeout while it waited: NOT sent', async () => {
    const release = blockFirstSend()
    await postRaw({ category: 'skill_patch' })
    const { id } = await postBound()
    getDb().prepare("UPDATE approvals SET status = 'timeout', resolved_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), id)
    release()
    await ownerNotificationsSettled()
    expect(calls).toHaveLength(1)
    expect(logged.filter(a => a[2] === SKIPPED)).toHaveLength(1)
  })

  it('the row refuses the nonces (decided between the check and the bind): plain, the nonces leak nowhere', async () => {
    vi.mocked(setApprovalCallbackNonceHashes).mockImplementationOnce(() => false)
    const { id } = await postBound()
    await ownerNotificationsSettled()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.reply_markup).toBeUndefined()
    expect(calls[0]!.body.text).toBe(TEST_RUN_PREFIX + buildOwnerApprovalText(getApproval(id)!))
    expect(warnFor('nonce_not_bound')).toHaveLength(1)
    // Minted (one per button), refused by the row, and never sent: afterEach
    // checks they leaked nowhere.
    expect(issuedNonces).toHaveLength(2)
    expect(vi.mocked(setApprovalCallbackNonceHashes)).toHaveBeenCalledWith(id, { approved: sha(issuedNonces[0]!), rejected: sha(issuedNonces[1]!) })
  })
})

describe('the POST never waits for the queue', () => {
  it('answers 201 while the Telegram send (and a pause) still hang; the send happens afterwards', async () => {
    const gate = holdable()
    const release = gate.release
    // The button message hangs, then fails: the plain notice after it waits
    // for the pause, which hangs too.
    reply = async (c) => { await gate.wait; return c.body.reply_markup ? { kind: 'http', status: 500 } : { kind: 'ok', messageId: nextMessageId++ } }
    let pausing!: () => void
    setOwnerNotificationSleep(() => { const h = holdable(); pausing = h.release; return h.wait })
    let settled = false

    const first = await postBound()
    const second = await postRaw({ category: 'skill_patch' })
    void ownerNotificationsSettled().then(() => { settled = true })
    // Both requests were created and answered; nothing has been sent yet.
    expect(getApproval(first.id)!.status).toBe('pending')
    expect(getApproval(second.id)!.status).toBe('pending')
    expect(calls).toHaveLength(0)

    release()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await vi.waitFor(() => expect(pausing).toBeTypeOf('function'))
    expect(settled).toBe(false)
    // From here the pauses resolve at once.
    setOwnerNotificationSleep(fakeSleep)
    pausing()
    await ownerNotificationsSettled()
    expect(settled).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls.filter(c => c.body.reply_markup)).toHaveLength(1)
    expect(calls[1]!.body.text).toContain(first.id)
    expect(calls[calls.length - 1]!.body.text).toContain(second.id)
  })
})

describe('suppressed before any send (unchanged behaviour)', () => {
  it('no TELEGRAM_BOT_TOKEN: nothing sent, the in-band fallback is immediate', async () => {
    state.token = ''
    const { id } = await postBound()
    // Synchronous, as before: no need to wait for the queue.
    expect(fallbacks().map(m => m.content)).toEqual([expect.stringContaining('[OWNER_UNREACHED no-token]')])
    await ownerNotificationsSettled()
    expect(calls).toHaveLength(0)
    expect(storedHashes(id)).toEqual(UNBOUND)
  })

  it('no owner chat: nothing sent, the in-band fallback is immediate', async () => {
    state.allowedChatId = ''
    state.accessJson = null
    await postBound()
    expect(fallbacks().map(m => m.content)).toEqual([expect.stringContaining('[OWNER_UNREACHED no-owner-chat]')])
    await ownerNotificationsSettled()
    expect(calls).toHaveLength(0)
  })
})

describe('sendTelegramMessage: the optional reply_markup', () => {
  it('without it the request body is byte-for-byte the old one', async () => {
    await sendTelegramMessage(BOT_TOKEN, OWNER, 'Szia')
    expect(calls[0]!.rawBody).toBe(JSON.stringify({ chat_id: OWNER, text: `${TEST_RUN_PREFIX}Szia` }))
  })

  it('with it the keyboard rides along as reply_markup', async () => {
    const kb = { inline_keyboard: [[{ text: 'A', callback_data: 'x' }]] }
    expect(await sendTelegramMessage(BOT_TOKEN, OWNER, 'Szia', kb)).toBe(1000)
    expect(calls[0]!.rawBody).toBe(JSON.stringify({ chat_id: OWNER, text: `${TEST_RUN_PREFIX}Szia`, reply_markup: kb }))
  })
})

describe('telegramBotId / sameTelegramBot', () => {
  it.each([
    ['7000000001:AAsecret', '7000000001'],
    ['  7000000001:AAsecret \n', '7000000001'],
    ['1:x', '1'],
  ])('%j -> %j', (token, id) => {
    expect(telegramBotId(token)).toBe(id)
  })

  it.each([
    [null], [undefined], [''], ['7000000001'], ['7000000001:'], [':AAsecret'], ['0700:AAsecret'],
    ['-7000000001:AAsecret'], ['abc:AAsecret'], ['"7000000001:AAsecret"'], ['7000000001 :AAsecret'],
  ])('%j -> null', (token) => {
    expect(telegramBotId(token)).toBeNull()
  })

  it('never returns any part of the secret', () => {
    expect(telegramBotId(BOT_TOKEN)).toBe('7000000001')
    expect(String(telegramBotId(BOT_TOKEN))).not.toContain('AA')
  })

  it('compares the bot ids only, and both must be well-formed', () => {
    expect(sameTelegramBot(BOT_TOKEN, SAME_BOT_OTHER_SECRET)).toBe(true)
    expect(sameTelegramBot(BOT_TOKEN, OTHER_BOT_TOKEN)).toBe(false)
    expect(sameTelegramBot(BOT_TOKEN, null)).toBe(false)
    expect(sameTelegramBot(null, null)).toBe(false)
    expect(sameTelegramBot('garbage', 'garbage')).toBe(false)
  })
})
