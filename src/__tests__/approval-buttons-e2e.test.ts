import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The whole button chain in one process, no live service:
//   requester helper (scripts/approval-envelope.py) -> POST /api/approvals ->
//   a fake Telegram records the button message -> the plugin block
//   (src/telegram-plugin-patches/approval-callback.ts) runs on a fake grammY ctx,
//   its fetch bridged straight into the route handler -> POST
//   /api/approvals/:id/telegram -> the send side:
//   consumeApproval AND the unchanged Python gate (scripts/hooks/email-approval-gate.py),
//   both reading the same on-disk SQLite store.
// Every node has its own unit tests; this file checks that their contracts meet.
// Rules pinned here: the buttons only ever sit under ONE message that holds
// the whole letter (a longer letter gets the plain notice, no chunks); each
// button has its own nonce; the legacy PATCH never takes a button press.

const ROOT = join(__dirname, '..', '..')
const HELPER = join(ROOT, 'scripts', 'approval-envelope.py')
const GATE = join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py')

const state = vi.hoisted(() => ({
  token: '',
  allowedChatId: '',
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
  // The live access.json never decides a test: no file, only the .env owner.
  const read = () => { throw new Error('ENOENT') }
  return {
    ...real,
    resolveOwnerChatId: vi.fn((_read?: unknown, configured?: string | null) => real.resolveOwnerChatId(read, configured)),
    resolveAlertOwnerChat: vi.fn((_read?: unknown, configured?: string | null) => real.resolveAlertOwnerChat(read, configured)),
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

import { PROJECT_ROOT } from '../config.js'
import { initDatabase, getDb, getApproval, consumeApproval } from '../db.js'
import { logger } from '../logger.js'
import {
  tryHandleApprovals, ownerNotificationsSettled, setOwnerNotificationSleep, approvalWindowSeconds,
  buildOwnerApprovalText, TOO_LONG_FOR_BUTTONS,
} from '../web/routes/approvals.js'
import { TEST_RUN_PREFIX } from '../test-run-marker.js'
import { APPROVAL_CALLBACK_RE, CALLBACK_DATA_MAX_BYTES, parseCallbackData, newCallbackNonce } from '../web/approval-callback-data.js'
import { parseEnvelopePayload, computeContentAnchor } from '../approval-envelope.js'
import {
  marveenApprovalCallback, MARVEEN_APV_CALLBACK_RE, MARVEEN_APV_TOAST,
  type MarveenApvCtx, type MarveenApvDeps,
} from '../telegram-plugin-patches/approval-callback.js'
import type { RouteContext } from '../web/routes/types.js'

const OWNER = '1000000001'
const STRANGER = '2000000002'
const BOT_TOKEN = '7000000001:AAsendSECRETpartXYZ'
const CHANNEL_TOKEN = '7000000001:AAchannelSECRETpartQRS'
const DASHBOARD_TOKEN = 'e2e-dashboard-token-' + 'beef'.repeat(8)
const INSTALL_STATE_DIR = join(PROJECT_ROOT, '.claude', 'channels', 'telegram')
const MCP_SEND = 'mcp__server-gmail-autoauth-mcp__send_email'

// --- scratch store (the Python gate reads <store>/claudeclaw.db) --------------

let scratch = ''
let store = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'apv-e2e-'))
  store = join(scratch, 'store')
  mkdirSync(store)
  writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({
    version: 1,
    categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false }],
  }))
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

// --- the requester side: the helper and the gate, as the agent runs them -------

type PreToolUse = { tool_name: string; tool_input: Record<string, unknown> }

function letter(over: Record<string, unknown> = {}): PreToolUse {
  return {
    tool_name: MCP_SEND,
    tool_input: {
      to: ['ugyfel@example.com'],
      cc: ['colleague@example.com'],
      subject: 'Ajánlat: Minta projekt',
      body: 'Tisztelt Ügyfelünk!\n\nCsatoltan küldjük az ajánlatot. 🔥\n\nÜdvözlettel:\nÜgyfélszolgálat',
      ...over,
    },
  }
}

type PostBody = { agent_id: string; category: string; content_hash: string; action_description: string; action_payload: string }

function runHelper(input: PreToolUse, subject?: string): PostBody {
  const args = ['-I', HELPER, '--agent', 'marveen', ...(subject ? ['--subject', subject] : [])]
  const res = spawnSync('python3', args, { input: JSON.stringify(input), encoding: 'utf-8', timeout: 60_000 })
  if (res.status !== 0) throw new Error(`approval-envelope.py exit ${res.status}: ${res.stderr}`)
  return JSON.parse(res.stdout) as PostBody
}

// The gate exactly as the PreToolUse hook starts it, on the scratch store.
function runGate(input: PreToolUse): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync('python3', [GATE], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      EMAIL_APPROVAL_GATE_STORE: store,
      EMAIL_APPROVAL_WINDOW_S: '1800',
      OUTGOING_COPY_GATE_RULES: join(store, 'no-rules.json'),
    },
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

// --- fake Telegram (the dashboard's sendMessage) -------------------------------

type TgCall = { url: string; rawBody: string; body: { chat_id: string; text: string; reply_markup?: any } }
let tgCalls: TgCall[] = []
let nextMessageId = 5000

const fakeTelegram = vi.fn(async (url: string, init: { body: string }) => {
  const call: TgCall = { url, rawBody: init.body, body: JSON.parse(init.body) }
  tgCalls.push(call)
  const messageId = nextMessageId++
  return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, result: { message_id: messageId } }) }
})

// --- route plumbing --------------------------------------------------------------

function fakeReq(raw: string) {
  return {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(raw))
      if (event === 'end') cb()
    },
  }
}

async function route(method: string, path: string, raw: string): Promise<{ status: number; raw: string; body: any }> {
  const out = { status: 0, raw: '', body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  expect(await tryHandleApprovals({ req: fakeReq(raw), res, path, method, url } as unknown as RouteContext)).toBe(true)
  return out
}

// The plugin's fetch, bridged into the route handler. It checks what a real
// dashboard's auth middleware would see (URL, method, bearer) and records the
// exchange.
type Bridged = { url: string; method: string; body: any; status: number; response: any }
let bridged: Bridged[] = []

const bridgeFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const u = new URL(url)
  expect(u.origin).toBe('http://127.0.0.1:3420')
  expect(init?.method).toBe('POST')
  expect(u.pathname).toMatch(/^\/api\/approvals\/[0-9a-f-]{36}\/telegram$/)
  expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${DASHBOARD_TOKEN}`)
  expect(init?.redirect).toBe('manual')
  const raw = String(init?.body)
  const out = await route('POST', u.pathname, raw)
  bridged.push({ url, method: 'POST', body: JSON.parse(raw), status: out.status, response: out.body })
  return new Response(out.raw, { status: out.status, headers: { 'content-type': 'application/json' } })
})

function pluginDeps(allowFrom: string[] = [OWNER]): MarveenApvDeps {
  const files: Record<string, string> = {
    [`${PROJECT_ROOT}/store/.dashboard-token`]: `${DASHBOARD_TOKEN}\n`,
    [`${PROJECT_ROOT}/.env`]: 'WEB_PORT=3420\n',
  }
  return {
    stateDir: INSTALL_STATE_DIR,
    readFileSync: (p: string) => {
      const v = files[p]
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return v
    },
    fetch: bridgeFetch as unknown as typeof fetch,
    loadAccess: () => ({ allowFrom }),
    env: {},
    envAtLoad: {},
  }
}

// The message the owner sees: one Telegram message, its buttons, and what the
// plugin did to it.
type Shown = {
  messageId: number
  text: string
  keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } | null
  answers: (string | undefined)[]
}

function pressCtx(shown: Shown, o: { fromId?: string; chatId?: string; chatType?: string } = {}): MarveenApvCtx {
  return {
    from: { id: Number(o.fromId ?? OWNER) },
    callbackQuery: {
      message: {
        message_id: shown.messageId,
        chat: { id: Number(o.chatId ?? OWNER), type: o.chatType ?? 'private' },
        text: shown.text,
      },
    },
    answerCallbackQuery: async (other?: { text?: string }) => { shown.answers.push(other?.text) },
    editMessageText: async (text: string, other?: { reply_markup?: any }) => {
      shown.text = text
      shown.keyboard = other?.reply_markup ?? null
    },
    editMessageReplyMarkup: async (other?: { reply_markup?: any }) => {
      shown.keyboard = other?.reply_markup?.inline_keyboard?.length ? other.reply_markup : null
    },
  }
}

async function press(shown: Shown, which: 'approve' | 'reject', o: Parameters<typeof pressCtx>[1] & { data?: string; allowFrom?: string[] } = {}) {
  const data = o.data ?? shown.keyboard?.inline_keyboard[0]?.[which === 'approve' ? 0 : 1]?.callback_data
  if (!data) throw new Error('no button to press')
  await marveenApprovalCallback(pressCtx(shown, o), data, pluginDeps(o.allowFrom))
  return shown.answers[shown.answers.length - 1]
}

// The whole requester side: helper -> POST -> the notification on the fake
// Telegram. Returns the row and the button message as the owner sees it.
// No --subject by default: on the MCP path the extractor puts the subject LAST
// in the hashed text, and the helper labels only the first line.
async function request(input: PreToolUse = letter(), subject?: string) {
  const body = runHelper(input, subject)
  const created = await route('POST', '/api/approvals', JSON.stringify({ ...body, timeout_seconds: 3600 }))
  expect(created.status).toBe(201)
  const id = created.body.id as string
  await ownerNotificationsSettled()
  // ONE message to the owner, and it carries the buttons (no chunks).
  expect(tgCalls).toHaveLength(1)
  const call = tgCalls[0]!
  expect(call.body.reply_markup).toBeTruthy()
  const row = getApproval(id)!
  expect(row.telegram_message_id).toBeGreaterThan(0)
  const shown: Shown = { messageId: row.telegram_message_id!, text: call.body.text, keyboard: call.body.reply_markup, answers: [] }
  return { id, body, shown, call }
}

const nonceHashesOf = (id: string) =>
  getDb().prepare('SELECT callback_nonce_hash_approve AS approved, callback_nonce_hash_reject AS rejected FROM approvals WHERE id = ?')
    .get(id) as { approved: string | null; rejected: string | null }
const UNBOUND = { approved: null, rejected: null }
const nonceOf = (shown: Shown, which: 'approve' | 'reject') =>
  parseCallbackData(shown.keyboard!.inline_keyboard[0]![which === 'approve' ? 0 : 1]!.callback_data)!.nonce

let logged: unknown[][] = []

beforeEach(() => {
  initDatabase(join(store, 'claudeclaw.db'))
  getDb().exec('DELETE FROM approval_events; DELETE FROM approvals; DELETE FROM agent_messages')
  state.token = BOT_TOKEN
  state.allowedChatId = OWNER
  state.stateDir = INSTALL_STATE_DIR
  state.channelToken = CHANNEL_TOKEN
  tgCalls = []
  bridged = []
  nextMessageId = 5000
  fakeTelegram.mockClear()
  bridgeFetch.mockClear()
  vi.stubGlobal('fetch', fakeTelegram)
  setOwnerNotificationSleep(async () => {})
  logged = []
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push([level, ...args]) }) as never)
  }
})

afterEach(async () => {
  await ownerNotificationsSettled()
  // Both nonces of every button message stay out of the logs and every API answer.
  for (const c of tgCalls.filter(t => t.body.reply_markup)) {
    for (const button of c.body.reply_markup.inline_keyboard[0]) {
      const nonce = parseCallbackData(button.callback_data)!.nonce
      expect(JSON.stringify(logged)).not.toContain(nonce)
      for (const b of bridged) expect(JSON.stringify(b.response)).not.toContain(nonce)
    }
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('approval buttons end to end', () => {
  it('the helper body is bound, and the server-built callback_data passes the plugin regex (codec parity)', async () => {
    const { id, body, shown, call } = await request()
    // The helper's payload is the letter its hash approves.
    const env = parseEnvelopePayload(body.action_payload)
    expect(env).not.toBeNull()
    expect(computeContentAnchor(env!)).toBe(body.content_hash)
    const hashes = nonceHashesOf(id)
    expect(hashes.approved).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes.rejected).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes.approved).not.toBe(hashes.rejected)

    // The button message went to the owner, and it is the WHOLE letter: every
    // identifying line and the full body, in the one message under the buttons.
    expect(call.body.chat_id).toBe(OWNER)
    expect(call.body.text).toContain(env!.text)
    for (const line of ['Címzett: ugyfel@example.com', 'Cc: colleague@example.com', 'Bcc: nincs', `id: ${id.slice(0, 8)}`,
      `boríték: ${body.content_hash.slice(0, 8)}`, '--- A levél szövege ---', '--- A levél szövegének vége ---']) {
      expect(call.body.text).toContain(line)
    }
    // MCP: the subject is the LAST line of the hashed text, so it is not labelled.
    expect(call.body.text).toContain('Tárgy: a levél szövegében szerepel (nem külön hitelesített mező)')
    expect(call.body.text.length + 300).toBeLessThanOrEqual(4096)
    const [approve, reject] = shown.keyboard!.inline_keyboard[0]!
    for (const b of [approve!, reject!]) {
      expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
      expect(MARVEEN_APV_CALLBACK_RE.test(b.callback_data)).toBe(true)
      expect(APPROVAL_CALLBACK_RE.test(b.callback_data)).toBe(true)
      expect(String(MARVEEN_APV_CALLBACK_RE)).toBe(String(APPROVAL_CALLBACK_RE))
      expect(parseCallbackData(b.callback_data)!.approvalId).toBe(id)
    }
    expect(approve!.callback_data.startsWith('apv:a:')).toBe(true)
    expect(reject!.callback_data.startsWith('apv:r:')).toBe(true)
    // Each button has its own nonce, and the API never hands out a nonce hash.
    expect(nonceOf(shown, 'approve')).not.toBe(nonceOf(shown, 'reject'))
    const got = await route('GET', `/api/approvals/${id}`, '')
    expect(got.status).toBe(200)
    expect(got.body).not.toHaveProperty('callback_nonce_hash_approve')
    expect(got.body).not.toHaveProperty('callback_nonce_hash_reject')
  })

  it('approve: the plugin\'s POST decides it, the buttons go, and consumeApproval honours hash, one-shot and window', async () => {
    const { id, body, shown } = await request()
    const toast = await press(shown, 'approve')
    expect(toast).toBe(MARVEEN_APV_TOAST.approved)
    expect(bridged).toHaveLength(1)
    expect(bridged[0]!.status).toBe(200)
    expect(bridged[0]!.url).toBe(`http://127.0.0.1:3420/api/approvals/${id}/telegram`)
    expect(bridged[0]!.body).toMatchObject({
      status: 'approved', resolved_by: `owner:telegram:${OWNER}`, telegram_message_id: shown.messageId,
      telegram_chat_id: OWNER, telegram_chat_type: 'private', callback_protocol: 1,
    })
    expect(shown.keyboard).toBeNull()
    expect(shown.text).toMatch(/\n\n✅ Jóváhagyva: .+ \(Budapest\)\./)

    const row = getApproval(id)!
    expect(row.status).toBe('approved')
    expect(row.resolved_by).toBe(`owner:telegram:${OWNER}`)
    expect(nonceHashesOf(id)).toEqual(UNBOUND)

    const windowSeconds = approvalWindowSeconds()
    const other = '0'.repeat(64)
    expect(consumeApproval({ id, contentHash: other, consumer: 'e2e', windowSeconds })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    // 31 minutes after the decision the window is closed.
    expect(consumeApproval({ id, contentHash: body.content_hash, consumer: 'e2e', windowSeconds, nowS: row.resolved_at! + 31 * 60 }))
      .toMatchObject({ ok: false, reason: 'expired' })
    expect(consumeApproval({ id, contentHash: body.content_hash, consumer: 'e2e', windowSeconds })).toMatchObject({ ok: true })
    expect(consumeApproval({ id, contentHash: body.content_hash, consumer: 'e2e', windowSeconds })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('approve: the unchanged Python gate lets the byte-identical letter through once, and nothing else', async () => {
    const input = letter()
    const before = runGate(input)
    expect(before.code).toBe(2)
    expect(before.stderr).toContain('NINCS jovahagyas')

    const { id, body, shown } = await request(input)
    // Pending: the gate still says wait.
    const pending = runGate(input)
    expect(pending.code).toBe(2)
    expect(pending.stderr).toContain('FUGGOBEN')
    expect(pending.stderr).toContain(body.content_hash)

    expect(await press(shown, 'approve')).toBe(MARVEEN_APV_TOAST.approved)

    // A different letter (one word of the body changed) has no approval.
    const altered = runGate(letter({ body: 'Tisztelt Ügyfelünk!\n\nCsatoltan küldjük a MÓDOSÍTOTT ajánlatot.\n\nÜdvözlettel:\nÜgyfélszolgálat' }))
    expect(altered.code).toBe(2)
    expect(altered.stderr).toContain('NINCS jovahagyas')
    // So has the same letter with an extra cc.
    const recc = runGate(letter({ cc: ['colleague@example.com', 'masik@example.com'] }))
    expect(recc.code).toBe(2)
    expect(recc.stderr).toContain('NINCS jovahagyas')

    const sent = runGate(input)
    expect(sent.code).toBe(0)
    expect(sent.stdout).toContain(id)
    expect(getApproval(id)!.consumed_at).not.toBeNull()

    const again = runGate(input)
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('MAR FEL LETT HASZNALVA')
    // The two consume paths share consumed_at.
    expect(consumeApproval({ id, contentHash: body.content_hash, consumer: 'e2e', windowSeconds: approvalWindowSeconds() }))
      .toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('approve: past the 30-minute window the Python gate refuses (expired)', async () => {
    const input = letter()
    const { id, shown } = await request(input)
    expect(await press(shown, 'approve')).toBe(MARVEEN_APV_TOAST.approved)
    // 31 minutes later: resolved_at moved back, the gate reads the real clock.
    getDb().prepare('UPDATE approvals SET resolved_at = resolved_at - ? WHERE id = ?').run(31 * 60, id)
    const late = runGate(input)
    expect(late.code).toBe(2)
    expect(late.stderr).toContain('IDOABLAKA lejart')
    expect(getApproval(id)!.consumed_at).toBeNull()
  })

  it('reject: the plugin\'s POST rejects it, the consume refuses (not_approved), and the Python gate denies', async () => {
    const input = letter()
    const { id, body, shown } = await request(input)
    expect(await press(shown, 'reject')).toBe(MARVEEN_APV_TOAST.rejected)
    expect(bridged[0]!.body.status).toBe('rejected')
    expect(shown.keyboard).toBeNull()
    expect(shown.text).toMatch(/\n\n❌ Elutasítva: /)
    const row = getApproval(id)!
    expect(row.status).toBe('rejected')
    expect(row.resolved_by).toBe(`owner:telegram:${OWNER}`)

    expect(consumeApproval({ id, contentHash: body.content_hash, consumer: 'e2e', windowSeconds: approvalWindowSeconds() }))
      .toMatchObject({ ok: false, reason: 'not_approved' })
    const gate = runGate(input)
    expect(gate.code).toBe(2)
    expect(gate.stderr).toContain('NINCS jovahagyas')
    expect(getApproval(id)!.consumed_at).toBeNull()
  })

  it('a second press (the same or the other button) gets 409 already_resolved, the buttons go, the decision stands', async () => {
    const { id, shown } = await request()
    const original = { ...shown, keyboard: shown.keyboard, answers: [] as (string | undefined)[] }
    expect(await press(shown, 'approve')).toBe(MARVEEN_APV_TOAST.approved)

    // A stale client still shows the buttons: press reject on the original message.
    const stale: Shown = { ...original, answers: [] }
    expect(await press(stale, 'reject')).toBe(MARVEEN_APV_TOAST.alreadyResolved)
    expect(bridged[1]!.status).toBe(409)
    expect(bridged[1]!.response).toMatchObject({ ok: false, reason: 'already_resolved', status: 'approved' })
    expect(stale.keyboard).toBeNull()
    expect(stale.text).toContain('Jóváhagyva')

    const stale2: Shown = { ...original, answers: [] }
    expect(await press(stale2, 'approve')).toBe(MARVEEN_APV_TOAST.alreadyResolved)
    expect(bridged[2]!.status).toBe(409)
    expect(stale2.keyboard).toBeNull()

    const row = getApproval(id)!
    expect(row.status).toBe('approved')
    expect(row.resolved_by).toBe(`owner:telegram:${OWNER}`)
  })

  it('a forged decision (right message id, wrong nonce) is 403 and the approval stays pending; the real press still works', async () => {
    const { id, shown } = await request()
    const forged = await route('POST', `/api/approvals/${id}/telegram`, JSON.stringify({
      status: 'approved',
      resolved_by: `owner:telegram:${OWNER}`,
      telegram_message_id: shown.messageId,
      telegram_chat_id: OWNER,
      telegram_chat_type: 'private',
      callback_nonce: newCallbackNonce(),
      callback_protocol: 1,
    }))
    expect(forged.status).toBe(403)
    expect(forged.body).toEqual({ ok: false, reason: 'bad_nonce' })
    expect(getApproval(id)!.status).toBe('pending')
    expect(nonceHashesOf(id).approved).not.toBeNull()

    // The same through the plugin: well-formed callback_data with a guessed nonce.
    const guessed = `apv:a:${id.replace(/-/g, '')}:${newCallbackNonce()}`
    const keyboardBefore = shown.keyboard
    expect(await press(shown, 'approve', { data: guessed })).toBe(MARVEEN_APV_TOAST.invalid)
    expect(bridged[0]!.status).toBe(403)
    expect(shown.keyboard).toBe(keyboardBefore)
    expect(getApproval(id)!.status).toBe('pending')

    expect(await press(shown, 'approve')).toBe(MARVEEN_APV_TOAST.approved)
    expect(getApproval(id)!.status).toBe('approved')
  })

  it('the real nonce but another message id is 403 message_mismatch, and the nonce is not burnt', async () => {
    const { id, shown } = await request()
    const nonce = nonceOf(shown, 'approve')
    const wrong = await route('POST', `/api/approvals/${id}/telegram`, JSON.stringify({
      status: 'approved',
      resolved_by: `owner:telegram:${OWNER}`,
      telegram_message_id: shown.messageId + 1,
      telegram_chat_id: OWNER,
      telegram_chat_type: 'private',
      callback_nonce: nonce,
      callback_protocol: 1,
    }))
    expect(wrong.status).toBe(403)
    expect(wrong.body).toEqual({ ok: false, reason: 'message_mismatch' })
    expect(getApproval(id)!.status).toBe('pending')
    expect(await press(shown, 'reject')).toBe(MARVEEN_APV_TOAST.rejected)
    expect(getApproval(id)!.status).toBe('rejected')
  })

  it('forged callback data, a stranger, a group or a foreign chat never reach the dashboard', async () => {
    const { id, shown } = await request()
    const real = shown.keyboard!.inline_keyboard[0]![0]!.callback_data
    for (const data of [`perm:allow:abcde`, real.toUpperCase(), `${real} `, real.replace('apv:a:', 'apv:x:'), real.slice(0, -1)]) {
      expect(await press(shown, 'approve', { data })).toBe(MARVEEN_APV_TOAST.invalid)
    }
    // A stranger is not in the allowlist; even an allowlisted one fails on the server's owner rule.
    expect(await press(shown, 'approve', { fromId: STRANGER, chatId: STRANGER })).toBe(MARVEEN_APV_TOAST.forbidden)
    expect(await press(shown, 'approve', { chatType: 'group', chatId: '-100123' })).toBe(MARVEEN_APV_TOAST.forbidden)
    expect(await press(shown, 'approve', { chatId: STRANGER })).toBe(MARVEEN_APV_TOAST.forbidden)
    expect(bridged).toHaveLength(0)

    expect(await press(shown, 'approve', { fromId: STRANGER, chatId: STRANGER, allowFrom: [OWNER, STRANGER] }))
      .toBe(MARVEEN_APV_TOAST.forbidden)
    expect(bridged).toHaveLength(1)
    expect(bridged[0]!.status).toBe(403)
    expect(bridged[0]!.response).toEqual({ ok: false, reason: 'not_owner' })

    expect(shown.keyboard).not.toBeNull()
    expect(getApproval(id)!.status).toBe('pending')
  })

  it('the data of one button cannot take the other decision (403 bad_nonce, buttons stay, still pending)', async () => {
    const { id, shown } = await request()
    const id32 = id.replace(/-/g, '')
    // A leaked reject button turned into an approve, and the other way round.
    const swapped = [`apv:a:${id32}:${nonceOf(shown, 'reject')}`, `apv:r:${id32}:${nonceOf(shown, 'approve')}`]
    const keyboardBefore = shown.keyboard
    for (const data of swapped) {
      expect(await press(shown, 'approve', { data })).toBe(MARVEEN_APV_TOAST.invalid)
    }
    expect(bridged.map(b => [b.status, b.response])).toEqual([
      [403, { ok: false, reason: 'bad_nonce' }],
      [403, { ok: false, reason: 'bad_nonce' }],
    ])
    expect(shown.keyboard).toBe(keyboardBefore)
    expect(getApproval(id)).toMatchObject({ status: 'pending', resolved_by: null })
    // The real reject button still rejects.
    expect(await press(shown, 'reject')).toBe(MARVEEN_APV_TOAST.rejected)
    expect(getApproval(id)!.status).toBe('rejected')
  })

  it('a press sent to the legacy PATCH (an older plugin) is a 400 and decides nothing; the POST still decides', async () => {
    const { id, shown } = await request()
    const legacy = await route('PATCH', `/api/approvals/${id}`, JSON.stringify({
      status: 'approved',
      resolved_by: `owner:telegram:${OWNER}`,
      telegram_message_id: shown.messageId,
      telegram_chat_id: OWNER,
      telegram_chat_type: 'private',
      callback_nonce: nonceOf(shown, 'approve'),
      callback_protocol: 1,
    }))
    expect(legacy.status).toBe(400)
    expect(legacy.body).toEqual({ error: 'resolved_by may not use the reserved owner:telegram: prefix' })
    expect(getApproval(id)).toMatchObject({ status: 'pending', resolved_by: null })
    expect(await press(shown, 'approve')).toBe(MARVEEN_APV_TOAST.approved)
    expect(getApproval(id)!.status).toBe('approved')
  })

  it('a plugin newer than the dashboard -- the endpoint is missing (the router\'s bare 404): the buttons stay, nothing is decided', async () => {
    const { id, shown } = await request()
    // What src/web.ts answers when no handler takes the path, as on a
    // dashboard older than the endpoint (simulated: no old server runs here).
    const oldServer = vi.fn(async () => new Response('Not found', { status: 404 }))
    const deps = { ...pluginDeps(), fetch: oldServer as unknown as typeof fetch }
    const keyboardBefore = shown.keyboard
    await marveenApprovalCallback(pressCtx(shown), shown.keyboard!.inline_keyboard[0]![0]!.callback_data, deps)
    expect(oldServer).toHaveBeenCalledTimes(1)
    expect(shown.answers.at(-1)).toBe(MARVEEN_APV_TOAST.unavailable)
    expect(shown.keyboard).toBe(keyboardBefore)
    expect(getApproval(id)!.status).toBe('pending')
    // Once the dashboard has the endpoint, the same button works.
    expect(await press(shown, 'approve')).toBe(MARVEEN_APV_TOAST.approved)
  })

  it('a letter too long for ONE message gets NO buttons: one plain notice with the too-long line, nothing bound, the gate still waits', async () => {
    const para = 'Ez egy hosszú levél bekezdése ékezetekkel (árvíztűrő tükörfúrógép) és emojival 🔥.\n'
    const input = letter({ body: para.repeat(120) })
    const body = runHelper(input)
    const env = parseEnvelopePayload(body.action_payload)!
    expect(env.text.length).toBeGreaterThan(4096)
    // The envelope IS bound to its hash; the length alone withholds the buttons.
    expect(computeContentAnchor(env)).toBe(body.content_hash)
    const created = await route('POST', '/api/approvals', JSON.stringify({ ...body, timeout_seconds: 3600 }))
    expect(created.status).toBe(201)
    const id = created.body.id as string
    await ownerNotificationsSettled()

    expect(tgCalls).toHaveLength(1)
    const [msg] = tgCalls as [TgCall]
    expect(msg.body.chat_id).toBe(OWNER)
    expect(msg.body.reply_markup).toBeUndefined()
    expect(msg.body.text).toBe(`${TEST_RUN_PREFIX}${buildOwnerApprovalText(getApproval(id)!)}\n${TOO_LONG_FOR_BUTTONS}`)
    expect(nonceHashesOf(id)).toEqual(UNBOUND)
    // A made-up press on that message binds nothing: no nonce was ever minted for it.
    const forged = await route('POST', `/api/approvals/${id}/telegram`, JSON.stringify({
      status: 'approved',
      resolved_by: `owner:telegram:${OWNER}`,
      telegram_message_id: getApproval(id)!.telegram_message_id,
      telegram_chat_id: OWNER,
      telegram_chat_type: 'private',
      callback_nonce: newCallbackNonce(),
      callback_protocol: 1,
    }))
    expect(forged.status).toBe(409)
    expect(forged.body).toEqual({ ok: false, reason: 'not_bound' })
    expect(getApproval(id)!.status).toBe('pending')
    const gate = runGate(input)
    expect(gate.code).toBe(2)
    expect(gate.stderr).toContain('FUGGOBEN')
  })

  it('the subject is shown only as the FIRST line, labelled as the requester\'s claim (Bash --subject before --body); any MCP --subject is refused by the helper', async () => {
    expect(() => runHelper(letter(), 'Ajánlat: Minta utca 1.')).toThrow(/exit 2/)
    const bashInput: PreToolUse = {
      tool_name: 'Bash',
      tool_input: { command: 'python3 scripts/send.py --to "ugyfel@example.com" --subject "Ajánlat: Minta utca 1." --body "Tisztelt Ügyfelünk! Csatoltan küldjük."' },
    }
    const { call } = await request(bashInput, 'Ajánlat: Minta utca 1.')
    expect(call.body.text).toMatch(/^Első sor \(a kérő szerint tárgy\): Ajánlat: Minta utca 1\.$/m)
    expect(call.body.text).not.toMatch(/^Tárgy: Ajánlat/m)
  })
})
