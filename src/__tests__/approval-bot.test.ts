// Kanban 80d0e3c6: the approval bot. Every press check and every step against a fake Telegram API, the
// notifyOwner wiring (bot on, bot failing, bot off), and the poller.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainSend = vi.hoisted(() => vi.fn(async () => 4242))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: 'main-token', CHANNEL_PROVIDER: 'telegram' }))
vi.mock('../owner-chat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../owner-chat.js')>()), resolveOwnerChatId: () => '777' }))
vi.mock('../web/telegram.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../web/telegram.js')>()), sendTelegramMessage: mainSend }))

import { initDatabase, createApproval, getApproval, resolveApproval, getApprovalBotMessage } from '../db.js'
import {
  sendApprovalPrompt, handleCallback, callbackData, parseCallbackData, compactId, expandId, confirmText,
  startApprovalBotPoller, setActiveApprovalBotForTest, activeApprovalBot, CONFIRM_WINDOW_SEC, RESOLVED_BY,
  type ApprovalBot, type BotApi, type CallbackQuery, type InlineButton,
} from '../approval-bot.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { TelegramApiError } from '../channel-coordinator/telegram-client.js'

const td = mkdtempSync(join(tmpdir(), 'approval-bot-'))
afterAll(() => { rmSync(td, { recursive: true, force: true }); setActiveApprovalBotForTest(undefined) })
mkdirSync(join(td, 'store'), { recursive: true })
initDatabase(join(td, 'store', 'claudeclaw.db'))

const OWNER = '777'
type Call = { m: string; args: any[] }
function fakeApi(over: Partial<BotApi> = {}) {
  const calls: Call[] = []
  let nextId = 100
  const api: BotApi = {
    async sendMessage(...args) { calls.push({ m: 'sendMessage', args }); return nextId++ },
    async editMessageText(...args) { calls.push({ m: 'editMessageText', args }) },
    async answerCallbackQuery(...args) { calls.push({ m: 'answerCallbackQuery', args }) },
    ...over,
  }
  return { api, calls }
}
let clock = 1_800_000_000
function makeBot(api: BotApi, allow = [OWNER]): ApprovalBot {
  return { token: '1:' + 'a'.repeat(35), key: randomBytes(32), api, ownerChat: () => OWNER, allowFrom: () => allow, now: () => clock }
}
function newApproval(opts: { timeoutIn?: number | null } = {}) {
  const id = randomUUID()
  const t = opts.timeoutIn === null ? null : clock + (opts.timeoutIn ?? 3600)
  return createApproval({ id, agent_id: 'soma', category: 'email_send', action_description: 'Levél a@pelda.hu címre', action_payload: null, timeout_at: t, content_hash: null })
}
function press(bot: ApprovalBot, data: string, o: { from?: string; chat?: string; message?: number } = {}): CallbackQuery {
  const from = o.from ?? OWNER
  return { id: `cq-${Math.random()}`, data, from: { id: Number(from) }, message: { message_id: o.message ?? 0, chat: { id: Number(o.chat ?? from) } } }
}
const lastEdit = (calls: Call[]) => [...calls].reverse().find((c) => c.m === 'editMessageText')
const lastAnswer = (calls: Call[]) => [...calls].reverse().find((c) => c.m === 'answerCallbackQuery')?.args[1]

async function prompted(bot: ApprovalBot, opts?: { timeoutIn?: number | null }) {
  const a = newApproval(opts)
  expect(await sendApprovalPrompt(bot, a)).toBe(true)
  const sent = getApprovalBotMessage(a.id)!
  const data = (op: 'a' | 'c' | 'x' | 'r', chat = OWNER) => callbackData(bot.key, op, a.id, chat)
  return { a, msg: sent.message_id, data }
}

beforeEach(() => { clock = 1_800_000_000; mainSend.mockClear() })

describe('callback data', () => {
  it('round-trips the approval id, fits in 64 bytes, and refuses a changed character', () => {
    const key = randomBytes(32)
    const id = randomUUID()
    expect(expandId(compactId(id)!)).toBe(id)
    const d = callbackData(key, 'c', id, OWNER)
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64)
    expect(parseCallbackData(key, d, OWNER)).toEqual({ op: 'c', approvalId: id })
    expect(parseCallbackData(key, d.replace(/^c/, 'a'), OWNER)).toBeNull() // the op is under the MAC
    expect(parseCallbackData(key, d, '888')).toBeNull() // so is the chat
    expect(parseCallbackData(randomBytes(32), d, OWNER)).toBeNull()
  })
})

describe('the question', () => {
  it('goes to the owner chat with two buttons, and the message is on record', async () => {
    const { api, calls } = fakeApi()
    const bot = makeBot(api)
    const { a, msg } = await prompted(bot)
    const send = calls.find((c) => c.m === 'sendMessage')!
    expect(send.args[0]).toBe(OWNER)
    expect(send.args[1]).toContain(a.action_description)
    expect((send.args[2] as InlineButton[][])[0].map((b) => b.text)).toEqual(['Jóváhagyom', 'Elutasítom'])
    expect(getApprovalBotMessage(a.id)).toMatchObject({ chat_id: OWNER, message_id: msg, confirm_at: null })
  })
  it('a non-UUID id gets no buttons (the dashboard stays the way)', async () => {
    const { api } = fakeApi()
    const a = createApproval({ id: 'not-a-uuid', agent_id: 'soma', category: 'x', action_description: 'y', action_payload: null, timeout_at: null, content_hash: null })
    expect(await sendApprovalPrompt(makeBot(api), a)).toBe(false)
  })
})

describe('the owner approves in two presses', () => {
  it('first press: the text is rewritten FROM THE DATABASE and a confirm is asked; second press approves', async () => {
    const { api, calls } = fakeApi()
    const bot = makeBot(api)
    const { a, msg, data } = await prompted(bot)
    expect(await handleCallback(bot, press(bot, data('a'), { message: msg }))).toBe('confirm-asked')
    expect(getApproval(a.id)?.status).toBe('pending')
    const edit = lastEdit(calls)!
    expect(edit.args[2]).toBe(confirmText(getApproval(a.id)!))
    expect((edit.args[3] as InlineButton[][])[0].map((b) => b.text)).toEqual(['Megerősítem', 'Mégse'])
    clock += 30
    expect(await handleCallback(bot, press(bot, data('c'), { message: msg }))).toBe('approved')
    expect(getApproval(a.id)).toMatchObject({ status: 'approved', resolved_by: RESOLVED_BY })
    expect(lastEdit(calls)!.args[2]).toContain(a.action_description)
    expect(lastEdit(calls)!.args[3]).toBeNull()
    expect(lastAnswer(calls)).toBe('Jóváhagyva.')
  })
  it('a second confirm does nothing more', async () => {
    const { api } = fakeApi()
    const bot = makeBot(api)
    const { a, msg, data } = await prompted(bot)
    await handleCallback(bot, press(bot, data('a'), { message: msg }))
    await handleCallback(bot, press(bot, data('c'), { message: msg }))
    expect(await handleCallback(bot, press(bot, data('c'), { message: msg }))).toBe('already-decided')
    expect(getApproval(a.id)?.status).toBe('approved')
  })
  it('a confirm without the first press is refused', async () => {
    const { api } = fakeApi()
    const bot = makeBot(api)
    const { a, msg, data } = await prompted(bot)
    expect(await handleCallback(bot, press(bot, data('c'), { message: msg }))).toBe('confirm-without-step-one')
    expect(getApproval(a.id)?.status).toBe('pending')
  })
  it('a confirm after the window is refused and the question starts over', async () => {
    const { api, calls } = fakeApi()
    const bot = makeBot(api)
    const { a, msg, data } = await prompted(bot)
    await handleCallback(bot, press(bot, data('a'), { message: msg }))
    clock += CONFIRM_WINDOW_SEC + 1
    expect(await handleCallback(bot, press(bot, data('c'), { message: msg }))).toBe('confirm-too-late')
    expect(getApproval(a.id)?.status).toBe('pending')
    expect((lastEdit(calls)!.args[3] as InlineButton[][])[0][0].text).toBe('Jóváhagyom')
    expect(getApprovalBotMessage(a.id)?.confirm_at).toBeNull()
  })
  it('cancel puts the first buttons back, and a later confirm needs a new first press', async () => {
    const { api } = fakeApi()
    const bot = makeBot(api)
    const { a, msg, data } = await prompted(bot)
    await handleCallback(bot, press(bot, data('a'), { message: msg }))
    expect(await handleCallback(bot, press(bot, data('x'), { message: msg }))).toBe('cancelled')
    expect(await handleCallback(bot, press(bot, data('c'), { message: msg }))).toBe('confirm-without-step-one')
    expect(getApproval(a.id)?.status).toBe('pending')
  })
  it('reject is one press', async () => {
    const { api } = fakeApi()
    const bot = makeBot(api)
    const { a, msg, data } = await prompted(bot)
    expect(await handleCallback(bot, press(bot, data('r'), { message: msg }))).toBe('rejected')
    expect(getApproval(a.id)).toMatchObject({ status: 'rejected', resolved_by: RESOLVED_BY })
  })
})

describe('presses that must change nothing', () => {
  async function refused(setup: (bot: ApprovalBot, p: Awaited<ReturnType<typeof prompted>>) => CallbackQuery, outcome: string, allow?: string[]) {
    const { api } = fakeApi()
    const bot = makeBot(api, allow)
    const p = await prompted(bot)
    await handleCallback(bot, press(bot, p.data('a'), { message: p.msg })) // even after step 1
    expect(await handleCallback(bot, setup(bot, p))).toBe(outcome)
    expect(getApproval(p.a.id)?.status).toBe('pending')
  }
  it('someone not on allowFrom', () => refused((bot, p) => press(bot, p.data('c', '555'), { from: '555', message: p.msg }), 'not-owner'))
  it('the owner, but in a group chat', () => refused((bot, p) => press(bot, p.data('c', '-100'), { chat: '-100', message: p.msg }), 'wrong-chat'))
  it('another allowFrom member, in their own chat', () =>
    refused((bot, p) => press(bot, p.data('c', '888'), { from: '888', message: p.msg }), 'wrong-chat', [OWNER, '888']))
  it('a valid HMAC on a message this server did not send (an agent with the bot token sent it)', () =>
    refused((bot, p) => press(bot, p.data('c'), { message: p.msg + 999 }), 'not-our-message'))
  it('a tampered HMAC', () => refused((bot, p) => press(bot, p.data('c').slice(0, -2) + 'AA', { message: p.msg }), 'bad-data'))
  it('a request with no question on record', () => refused((bot, p) => press(bot, callbackData(bot.key, 'c', randomUUID(), OWNER), { message: p.msg }), 'wrong-chat'))

  it('a question that went to a GROUP (owner chat configured as a group) cannot be approved from that group', async () => {
    const { api } = fakeApi()
    const bot = { ...makeBot(api), ownerChat: () => '-100' }
    const a = newApproval()
    expect(await sendApprovalPrompt(bot, a)).toBe(true)
    const msg = getApprovalBotMessage(a.id)!.message_id
    expect(await handleCallback(bot, press(bot, callbackData(bot.key, 'a', a.id, '-100'), { chat: '-100', message: msg }))).toBe('wrong-chat')
    expect(getApprovalBotMessage(a.id)?.confirm_at).toBeNull()
  })
  it('a timed-out request', async () => {
    const { api } = fakeApi()
    const bot = makeBot(api)
    const p = await prompted(bot, { timeoutIn: 60 })
    clock += 61
    expect(await handleCallback(bot, press(bot, p.data('a'), { message: p.msg }))).toBe('expired')
    expect(getApproval(p.a.id)?.status).toBe('pending')
  })
  it('a request already decided on the dashboard: the message shows the result, nothing changes', async () => {
    const { api, calls } = fakeApi()
    const bot = makeBot(api)
    const p = await prompted(bot)
    resolveApproval(p.a.id, 'rejected', 'dashboard')
    expect(await handleCallback(bot, press(bot, p.data('a'), { message: p.msg }))).toBe('already-decided')
    expect(getApproval(p.a.id)?.status).toBe('rejected')
    expect(lastEdit(calls)!.args[2]).toContain('ELUTASÍTVA')
  })
})

describe('notifyOwner wiring', () => {
  async function file() {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const str = JSON.stringify({ agent_id: 'soma', category: 'email_send', action_description: 'kérés' })
    const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(str)); if (ev === 'end') cb() } }
    const url = new URL('http://localhost/api/approvals')
    await tryHandleApprovals({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'token', agent: 'soma' } } as any)
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    return out
  }
  it('bot on: the question goes through the approval bot, not the main bot', async () => {
    const { api, calls } = fakeApi()
    setActiveApprovalBotForTest(makeBot(api))
    const r = await file()
    expect(r.status).toBe(201)
    expect(calls.filter((c) => c.m === 'sendMessage')).toHaveLength(1)
    expect(mainSend).not.toHaveBeenCalled()
    expect(getApprovalBotMessage(r.body.id)).toBeTruthy()
  })
  it('bot failing (e.g. the owner never sent /start to it): the main bot carries the question', async () => {
    const { api } = fakeApi({ async sendMessage() { throw new Error("Forbidden: bot can't initiate conversation with a user") } })
    setActiveApprovalBotForTest(makeBot(api))
    await file()
    expect(mainSend).toHaveBeenCalledTimes(1)
  })
  it('POSITIVE CONTROL: bot off, the main bot carries the question exactly as before', async () => {
    setActiveApprovalBotForTest(null)
    await file()
    expect(mainSend).toHaveBeenCalledTimes(1)
    expect(String((mainSend.mock.calls[0] as unknown[])[2])).toContain('[JÓVÁHAGYÁS KELL]')
  })
  it('the switch is off by default: no bot', () => {
    setActiveApprovalBotForTest(undefined)
    expect(activeApprovalBot(join(td, 'store'))).toBeNull()
  })
})

describe('the poller', () => {
  it('hands callback presses to the handler, skips other updates, advances the offset, and stops on a refused token', async () => {
    const { api } = fakeApi()
    const bot = makeBot(api)
    const p = await prompted(bot)
    const offsets: number[] = []
    let n = 0
    const poll = vi.fn(async (_t: string, offset: number) => {
      offsets.push(offset)
      n++
      if (n === 1) return [
        { update_id: 10, message: { message_id: 1, chat: { id: 777 }, text: 'szia' } },
        { update_id: 11, callback_query: press(bot, p.data('r'), { message: p.msg }) },
      ] as any
      if (n === 2) throw new TelegramApiError('transient', 'net')
      throw new TelegramApiError('fatal', '401')
    })
    const h = startApprovalBotPoller(bot, poll as any, async () => {})!
    await h.done
    expect(getApproval(p.a.id)?.status).toBe('rejected')
    expect(offsets).toEqual([0, 12, 12])
  })
  it('no bot, no poller', () => {
    expect(startApprovalBotPoller(null)).toBeNull()
  })
})
