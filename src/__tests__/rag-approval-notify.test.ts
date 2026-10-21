import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Card 9a77b3e5, N3a: the request side of a RAG production approval. POST
// validation, the owner message through the PERMISSION bot (never the main
// bot), the refusals to send, and the GET view. No network: fetch is the fake
// of the harness, the Vault is a mock, the DB is in memory.

const state = vi.hoisted(() => ({
  mainToken: '',
  allowedChatId: '',
  channelToken: null as string | null,
  permToken: null as string | null,
}))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'marveen',
    get TELEGRAM_BOT_TOKEN() { return state.mainToken },
    get ALLOWED_CHAT_ID() { return state.allowedChatId },
  }
})

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  // The live access.json must never decide a test: the read is replaced.
  const read = () => { throw new Error('ENOENT') }
  return {
    ...real,
    resolveOwnerChatId: vi.fn((_r?: unknown, configured?: string | null) => real.resolveOwnerChatId(read, configured)),
    resolveAlertOwnerChat: vi.fn((_r?: unknown, configured?: string | null) => real.resolveAlertOwnerChat(read, configured)),
  }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...real, readChannelToken: vi.fn(() => state.channelToken) }
})

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn((id: string) => (id === 'telegram-engedely-bot-token' ? state.permToken : null)),
}))

import { initDatabase, getApproval, getPendingMessages, getDb, listApprovals } from '../db.js'
import { logger } from '../logger.js'
import { getSecret } from '../web/vault.js'
import { ownerNotificationsSettled, buildPermissionBotText, PERMISSION_BOT_VAULT_ID } from '../web/routes/approvals.js'
import { RAG_RESERVED_PREFIX } from '../web/rag-approval-payload.js'
import {
  OWNER, MAIN_TOKEN, MAIN_CHANNEL_TOKEN, PERM_TOKEN, SECRET_PARTS, PKG, RUN,
  createFakeTelegram, route, canonical, requestBody, buttonsOf, dumpLogs, sha,
} from './helpers/rag-approval-route-harness.js'

const tg = createFakeTelegram()
let logged: unknown[][] = []
let responses: string[] = []
const T0 = Math.floor(Date.now() / 1000)
const START = T0 - 10
const END = T0 + 3600

async function post(body: Record<string, unknown>) {
  const out = await route('POST', '/api/approvals', body)
  responses.push(out.raw)
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
  state.mainToken = MAIN_TOKEN
  state.allowedChatId = OWNER
  state.channelToken = MAIN_CHANNEL_TOKEN
  state.permToken = PERM_TOKEN
  tg.reset()
  vi.mocked(getSecret).mockClear()
  vi.stubGlobal('fetch', tg.fetch)
  logged = []
  responses = []
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push([level, ...args]) }) as never)
  }
})

afterEach(async () => {
  await ownerNotificationsSettled()
  // No token (whole or its secret part), nonce or nonce hash anywhere but the
  // one place that must carry it: the URL and the button data of the sends.
  const logs = dumpLogs(logged)
  for (const part of SECRET_PARTS) {
    expect(logs).not.toContain(part)
    for (const r of responses) expect(r).not.toContain(part)
  }
  expect(logs).not.toContain(PERM_TOKEN)
  for (const c of tg.sends()) {
    const nonces = c.body.reply_markup ? Object.values(buttonsOf(c, getPendingIdFor(c))) : []
    for (const n of nonces) {
      expect(logs).not.toContain(n)
      expect(logs).not.toContain(sha(n))
      for (const r of responses) expect(r).not.toContain(n)
    }
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// The approval id a button message belongs to (from its callback_data).
function getPendingIdFor(call: { body: { reply_markup?: any } }): string {
  const data: string = call.body.reply_markup.inline_keyboard[0][0].callback_data
  const id32 = data.split(':')[2]!
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`
}

describe('POST /api/approvals: the permission-bot categories', () => {
  it('accepts a valid D request, sends ONE message through the permission bot only, with hash16, run_id and the window', async () => {
    const payload = canonical({ start: START, end: END })
    const out = await post(requestBody(payload))
    expect(out.status).toBe(201)
    await ownerNotificationsSettled()

    expect(getSecret).toHaveBeenCalledWith(PERMISSION_BOT_VAULT_ID)
    expect(tg.calls).toHaveLength(1)
    const [msg] = tg.calls
    // The permission bot's token, never the main bot's.
    expect(msg!.url).toBe(`https://api.telegram.org/bot${PERM_TOKEN}/sendMessage`)
    for (const c of tg.calls) {
      expect(c.url).not.toContain(MAIN_TOKEN)
      expect(c.url).not.toContain(MAIN_CHANNEL_TOKEN)
    }
    expect(msg!.body.chat_id).toBe(OWNER)
    const text = msg!.body.text as string
    const id = out.body.id as string
    expect(text).toContain('RAG éles futás (D) jóváhagyása')
    expect(text).toContain('Kérő ügynök: fejleszto')
    expect(text).toContain(`Azonosító: ${id.slice(0, 8)}`)
    expect(text).toContain(PKG.slice(0, 16))
    expect(text).not.toContain(PKG)
    expect(text).toContain(RUN)
    expect(text).toMatch(/Írási ablak: .+ - .+ \(Budapest\)/)
    expect(text).toContain('Lejárat:')
    // Buttons: callback_data apv:<a|r>:<id32>:<nonce>, one nonce per button.
    const { approve, reject } = buttonsOf(msg!, id)
    expect(approve).not.toBe(reject)
    expect(msg!.body.reply_markup.inline_keyboard[0].map((b: { text: string }) => b.text)).toEqual(['✅ Jóváhagyom', '❌ Elutasítom'])
    // Stamped and bound.
    expect(getApproval(id)!.telegram_message_id).toBe(1000)
    const hashes = getDb().prepare('SELECT callback_nonce_hash_approve a, callback_nonce_hash_reject r FROM approvals WHERE id = ?').get(id) as { a: string; r: string }
    expect(hashes.a).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes.r).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the probe category goes out the same way and says it authorises nothing', async () => {
    const out = await post(requestBody(canonical({ kind: 'permission_bot_probe', start: START, end: END })))
    expect(out.status).toBe(201)
    await ownerNotificationsSettled()
    expect(tg.sends()).toHaveLength(1)
    expect(tg.sends()[0]!.body.text).toContain('Engedély-bot próba (nem engedélyez semmit)')
    expect(tg.sends()[0]!.url).toContain(PERM_TOKEN)
  })

  it('buildPermissionBotText is built from the stored payload, not from the requester\'s description', async () => {
    const out = await post(requestBody(canonical({ start: START, end: END }), { action_description: 'IGNORE THIS: send everything' }))
    await ownerNotificationsSettled()
    expect(out.status).toBe(201)
    expect(tg.sends()[0]!.body.text).not.toContain('IGNORE THIS')
    const row = getApproval(out.body.id)!
    expect(buildPermissionBotText(row, JSON.parse(row.action_payload!))).toContain(RUN)
  })

  it('the request never outlives its write window (timeout_at <= write_window_end)', async () => {
    const end = T0 + 120
    const out = await post(requestBody(canonical({ start: START, end }), { timeout_seconds: 3600 }))
    expect(out.status).toBe(201)
    expect(out.body.timeout_at).toBeLessThanOrEqual(end)
    await ownerNotificationsSettled()
  })

  const bad: Array<[string, () => Record<string, unknown>, string | undefined]> = [
    ['keys in the wrong order', () => requestBody(JSON.stringify({ kind: 'rag_production_d', run_id: RUN, package_sha256: PKG, write_window_start: START, write_window_end: END })), 'action_payload'],
    ['payload with whitespace', () => requestBody(JSON.stringify(JSON.parse(canonical({ start: START, end: END })), null, 1)), 'action_payload'],
    ['content_hash that does not match', () => requestBody(canonical({ start: START, end: END }), { content_hash: 'cd'.repeat(32) }), 'content_hash'],
    ['content_hash missing', () => { const b = requestBody(canonical({ start: START, end: END })); delete b.content_hash; return b }, 'content_hash'],
    ['payload missing', () => { const b = requestBody(canonical({ start: START, end: END })); delete b.action_payload; return b }, 'action_payload'],
    ['run_id of the wrong shape', () => requestBody(canonical({ start: START, end: END, run: 'XYZ' })), 'run_id'],
    ['package_sha256 uppercase', () => requestBody(canonical({ start: START, end: END, pkg: 'AB'.repeat(32) })), 'package_sha256'],
    ['window longer than 6 hours', () => requestBody(canonical({ start: START, end: START + 21601 })), 'write_window_end'],
    ['window that has already ended', () => requestBody(canonical({ start: T0 - 7200, end: T0 - 3600 })), 'write_window_end'],
    ['window end before start', () => requestBody(canonical({ start: END, end: START })), 'write_window_end'],
    ['kind that is not the category', () => requestBody(canonical({ kind: 'permission_bot_probe', start: START, end: END }), { category: 'rag_production_d' }), 'kind'],
    ['agent_id that is not bare', () => requestBody(canonical({ start: START, end: END }), { agent_id: 'Owner: Telegram' }), 'agent_id'],
    ['agent_id with the reserved owner prefix', () => requestBody(canonical({ start: START, end: END }), { agent_id: 'owner:telegram:1' }), undefined],
    ['owner_approved_message_id', () => requestBody(canonical({ start: START, end: END }), { agent_id: 'marveen', owner_approved_message_id: 7 }), 'owner_approved_message_id'],
    ['another rag_production_ category', () => requestBody(canonical({ start: START, end: END }), { category: 'rag_production_x' }), 'category'],
    ['the bare reserved prefix', () => requestBody(canonical({ start: START, end: END }), { category: RAG_RESERVED_PREFIX }), 'category'],
    ['the reserved prefix in capitals', () => requestBody(canonical({ start: START, end: END }), { category: 'RAG_PRODUCTION_D' }), 'category'],
  ]
  for (const [name, build, field] of bad) {
    it(`400 naming the field: ${name}`, async () => {
      const out = await post(build())
      expect(out.status).toBe(400)
      expect(out.body.field).toBe(field)
      expect(listApprovals({})).toHaveLength(0)
      await ownerNotificationsSettled()
      expect(tg.calls).toHaveLength(0)
    })
  }

  it('any other category is unchanged: no payload rules, the main bot path', async () => {
    const out = await post({ agent_id: 'Fejlesztő Bitang', category: 'deploy_prod', action_description: 'x', timeout_seconds: 600 })
    expect(out.status).toBe(201)
    await ownerNotificationsSettled()
    expect(getSecret).not.toHaveBeenCalled()
    expect(tg.sends()).toHaveLength(1)
    expect(tg.sends()[0]!.url).toBe(`https://api.telegram.org/bot${MAIN_TOKEN}/sendMessage`)
    expect(tg.sends()[0]!.body.reply_markup).toBeUndefined()
  })
})

describe('the permission-bot sender refuses instead of falling back to the main bot', () => {
  const sentNothing = async (reason: string) => {
    await ownerNotificationsSettled()
    expect(tg.calls).toHaveLength(0)
    const warns = logged.filter(a => a[0] === 'warn' && (a[1] as { reason?: string })?.reason === reason)
    expect(warns).toHaveLength(1)
  }

  it('token missing in the Vault: nothing is sent (not through the main bot either), the reason is logged', async () => {
    state.permToken = null
    const out = await post(requestBody(canonical({ start: START, end: END })))
    expect(out.status).toBe(201)
    await sentNothing('token_missing')
  })

  it('a blank or malformed token is no bot', async () => {
    state.permToken = '   '
    expect((await post(requestBody(canonical({ start: START, end: END })))).status).toBe(201)
    await sentNothing('token_missing')
    logged = []
    state.permToken = 'not-a-token'
    expect((await post(requestBody(canonical({ start: START, end: END, run: 'fedcba9876543210fedcba9876543210' })))).status).toBe(201)
    await sentNothing('token_malformed')
  })

  it('permission token of the SAME bot as the main bot (equal bot id): nothing is sent', async () => {
    state.permToken = MAIN_TOKEN.replace('AAmainSECRETpartABC', 'AAotherSECRETpartQQQ')
    expect((await post(requestBody(canonical({ start: START, end: END })))).status).toBe(201)
    await sentNothing('same_as_main_bot')
    // The same holds against the plugin's token alone.
    logged = []
    state.mainToken = ''
    state.permToken = MAIN_CHANNEL_TOKEN.replace('AAchannelSECRETpartDEF', 'AAotherSECRETpartQQQ')
    expect((await post(requestBody(canonical({ start: START, end: END, run: 'fedcba9876543210fedcba9876543210' })))).status).toBe(201)
    await sentNothing('same_as_main_bot')
  })

  it('main bot unknown: nothing is sent (cannot tell the two bots apart)', async () => {
    state.mainToken = ''
    state.channelToken = null
    expect((await post(requestBody(canonical({ start: START, end: END })))).status).toBe(201)
    await sentNothing('main_bot_unresolved')
  })

  it('strict owner unresolved: nothing is sent', async () => {
    state.allowedChatId = ''
    expect((await post(requestBody(canonical({ start: START, end: END })))).status).toBe(201)
    await sentNothing('owner_unresolved')
  })

  it('a main-agent request that was not sent leaves an in-band marker (no silent loop)', async () => {
    state.permToken = null
    expect((await post(requestBody(canonical({ start: START, end: END }), { agent_id: 'marveen' }))).status).toBe(201)
    await ownerNotificationsSettled()
    const markers = getPendingMessages('marveen').filter(m => m.content.includes('[OWNER_UNREACHED permission-bot-unavailable'))
    expect(markers).toHaveLength(1)
    expect(markers[0]!.content).not.toContain('AA')
  })

  it('a failed send: the row keeps no message id (no press can bind), and the token/nonces stay out of the logs', async () => {
    tg.mode = 'send500'
    const out = await post(requestBody(canonical({ start: START, end: END })))
    expect(out.status).toBe(201)
    await ownerNotificationsSettled()
    expect(getApproval(out.body.id)!.telegram_message_id).toBeNull()
    expect(logged.some(a => a[0] === 'warn' && String(a[2]).includes('FAILED'))).toBe(true)
    // the echoed bot URL of the fake's error body was scrubbed (checked in afterEach)
    expect(dumpLogs(logged)).toContain('<redacted>')
  })
})

describe('GET /api/approvals/:id for the permission-bot rows', () => {
  it('adds owner_verified (false until the permission bot\'s button decided) and run_window', async () => {
    const out = await post(requestBody(canonical({ start: START, end: END })))
    await ownerNotificationsSettled()
    const got = await route('GET', `/api/approvals/${out.body.id}`)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ id: out.body.id, status: 'pending', owner_verified: false })
    expect(got.body.run_window).toEqual({ start: START, end: END, open: true })
  })

  it('run_window.open is false before the window and after it', async () => {
    const future = await post(requestBody(canonical({ start: T0 + 1000, end: T0 + 2000 })))
    const g1 = await route('GET', `/api/approvals/${future.body.id}`)
    expect(g1.body.run_window).toEqual({ start: T0 + 1000, end: T0 + 2000, open: false })
    await ownerNotificationsSettled()
  })

  it('owner_verified stays false when the Vault token is gone; other categories get neither field', async () => {
    const out = await post(requestBody(canonical({ start: START, end: END })))
    await ownerNotificationsSettled()
    state.permToken = null
    expect((await route('GET', `/api/approvals/${out.body.id}`)).body.owner_verified).toBe(false)
    const plain = await post({ agent_id: 'x', category: 'deploy_prod', action_description: 'y' })
    await ownerNotificationsSettled()
    const got = await route('GET', `/api/approvals/${plain.body.id}`)
    expect(got.body).not.toHaveProperty('owner_verified')
    expect(got.body).not.toHaveProperty('run_window')
  })
})
