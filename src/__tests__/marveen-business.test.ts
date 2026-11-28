// scripts/telegram-plugin/marveen-business.ts: the Telegram Business part of
// the telegram channel plugin (Bud Parker, 2026-10-20). grammy is not a repo
// dependency (it lives in the plugin's own node_modules), so a small stand-in
// routes updates by type and button data the way the module uses it. The
// same checks were also run once against the real grammy 1.41.1 of the 0.0.7
// plugin with bun.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('grammy', () => {
  class InlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [[]]
    text(label: string, data: string) { this.inline_keyboard[0].push({ text: label, callback_data: data }); return this }
  }
  // grammY's own default set (1.41.1): every update type but chat_member, message_reaction, message_reaction_count
  const API_CONSTANTS = { DEFAULT_UPDATE_TYPES: ['message', 'edited_message', 'callback_query', 'my_chat_member'] }
  return { InlineKeyboard, API_CONSTANTS }
})

// Loaded by path, not by a static import: the module lives outside src/, so
// tsc (rootDir src) must not follow it.
const MODULE = join(__dirname, '..', '..', 'scripts', 'telegram-plugin', 'marveen-business.ts')
const { registerBusiness } = await import(MODULE)

const OWNER = 111, PARTNER = 222, STRANGER = 333

type Call = { method: string; args: any[] }

function fakeBot(calls: Call[]) {
  const onHandlers: Record<string, Array<(ctx: any) => unknown>> = {}
  const cbHandlers: Array<{ rx: RegExp; fn: (ctx: any) => unknown }> = []
  const api: any = {
    getBusinessConnection: async (id: string) => {
      calls.push({ method: 'getBusinessConnection', args: [id] })
      const owner = id === 'cX' ? STRANGER : OWNER
      return { id, user: { id: owner }, user_chat_id: owner, is_enabled: true, rights: { can_reply: true } }
    },
    sendMessage: async (...args: any[]) => { calls.push({ method: 'sendMessage', args }); return { message_id: 900 + calls.length } },
  }
  const bot = {
    api,
    on: (filter: string, fn: (ctx: any) => unknown) => { (onHandlers[filter] ??= []).push(fn) },
    callbackQuery: (rx: RegExp, fn: (ctx: any) => unknown) => { cbHandlers.push({ rx, fn }) },
    start: async (o?: any) => { calls.push({ method: 'start', args: [o] }) },
  }
  let fellThrough = 0
  async function update(u: any) {
    const type = Object.keys(u)[0]
    if (type === 'callback_query') {
      const answers: any[] = [], edits: string[] = []
      for (const h of cbHandlers) {
        const match = h.rx.exec(u.callback_query.data)
        if (match) {
          await h.fn({ match, from: u.callback_query.from, callbackQuery: u.callback_query,
            answerCallbackQuery: async (a: any) => { answers.push(a) }, editMessageText: async (t: string) => { edits.push(t) } })
          return { answers, edits }
        }
      }
      fellThrough++
      return { answers, edits }
    }
    for (const fn of onHandlers[type] ?? []) await fn({ update: u })
    return { answers: [], edits: [] }
  }
  return { bot, update, fell: () => fellThrough }
}

let dir = ''
let calls: Call[] = []
let notes: any[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-biz-')); calls = []; notes = [] })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  const f = fakeBot(calls)
  const mcp = { notification: async (n: any) => { notes.push(n.params) } }
  const biz = registerBusiness({ bot: f.bot as any, mcp: mcp as any, loadAccess: () => ({ allowFrom: [String(OWNER)] }), stateDir: dir })
  return { ...f, biz }
}

const bmsg = (conn: string, from: number, text: string) => ({ business_message: {
  message_id: 50, business_connection_id: conn, date: 1, chat: { id: PARTNER, type: 'private', first_name: 'Pa<r>tner' },
  from: { id: from, first_name: 'X' }, text } })
const tap = (from: number, data: string) => ({ callback_query: { id: 'q', from: { id: from }, data, message: { text: 'Vázlat' } } })
const sends = () => calls.filter(c => c.method === 'sendMessage')
const draftId = (r: any) => /draft ([a-f0-9]{10})/.exec(r.content[0].text)![1]

describe('marveen-business: inbound', () => {
  it('a partner message of an allowlisted account arrives as business data; the owner\'s own message is marked out', async () => {
    const { update } = setup()
    await update(bmsg('c1', PARTNER, 'Szia, mi a helyzet?'))
    expect(notes[0].content).toBe('Szia, mi a helyzet?')
    expect(notes[0].meta).toMatchObject({ chat_id: String(PARTNER), business: '1', business_connection_id: 'c1', direction: 'in', partner: 'Pa_r_tner', kind: 'text' })
    // no user_id: the owner-command hook must never take a business message for the owner typing to the bot
    expect(notes[0].meta).not.toHaveProperty('user_id')
    await update(bmsg('c1', OWNER, 'mindjárt'))
    expect(notes[1].meta.direction).toBe('out')
  })

  it('an account that is not allowlisted is ignored: its connection and its messages', async () => {
    const { update } = setup()
    await update({ business_connection: { id: 'cX', user: { id: STRANGER }, user_chat_id: STRANGER, is_enabled: true } })
    await update(bmsg('cX', PARTNER, 'hi'))
    expect(notes).toEqual([])
  })

  it('connect and disconnect are reported to the session', async () => {
    const { update } = setup()
    await update({ business_connection: { id: 'c1', user: { id: OWNER }, user_chat_id: OWNER, is_enabled: true, rights: { can_reply: true } } })
    await update({ business_connection: { id: 'c1', user: { id: OWNER }, user_chat_id: OWNER, is_enabled: false } })
    expect(notes.map(n => n.meta.business_event)).toEqual(['connected', 'disconnected'])
  })
})

const logLines = () => {
  const f = join(dir, 'business-updates.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
}

describe('marveen-business: update log (Kérdés 116)', () => {
  it('every business message gets one text-free line with direction, reply_to and outcome; reply_to also reaches the session', async () => {
    const { update } = setup()
    const reply = bmsg('c1', PARTNER, 'titkos szöveg')
    ;(reply.business_message as any).reply_to_message = { message_id: 42 }
    await update(reply)
    await update(bmsg('c1', OWNER, 'mindjárt'))
    const lines = logLines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ update: 'business_message', connection: 'c1', chat_id: PARTNER, message_id: 50, reply_to: 42, direction: 'in', outcome: 'delivered' })
    expect(lines[1]).toMatchObject({ direction: 'out', outcome: 'delivered' })
    expect(JSON.stringify(lines)).not.toContain('titkos')
    expect(notes[0].meta.reply_to).toBe('42')
    expect(notes[1].meta).not.toHaveProperty('reply_to')
  })

  it('a silent drop is logged with its reason, and deletions are recorded without telling the session', async () => {
    const { update } = setup()
    await update(bmsg('cX', PARTNER, 'hi'))
    await update({ business_message: { message_id: 7, chat: { id: PARTNER }, from: { id: PARTNER }, date: 1, text: 'x' } })
    await update({ deleted_business_messages: { business_connection_id: 'c1', chat: { id: PARTNER }, message_ids: [48, 49] } })
    expect(logLines().map(l => l.outcome)).toEqual(['dropped:owner-not-allowlisted', 'dropped:no-connection-id', 'recorded'])
    expect(logLines()[2]).toMatchObject({ update: 'deleted_business_messages', message_ids: [48, 49] })
    expect(notes).toEqual([])
  })
})

describe('marveen-business: drafts need the owner\'s tap', () => {
  it('no draft into a chat that has not written on this connection', async () => {
    const { biz } = setup()
    await expect(biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: 'x' })).rejects.toThrow(/no business message/)
    expect(sends()).toEqual([])
  })

  it('the draft goes to the owner only; a stranger\'s tap sends nothing; the owner\'s tap sends once, on the owner\'s behalf', async () => {
    const { biz, update } = setup()
    await update(bmsg('c1', PARTNER, 'kérdés'))
    const id = draftId(await biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: 'Holnap küldöm.', reply_to: '50' }))
    expect(sends()).toHaveLength(1)
    const [chat, text, opts] = sends()[0].args
    expect(chat).toBe(String(OWNER))
    expect(text).toContain('Holnap küldöm.')
    expect(opts).not.toHaveProperty('business_connection_id')
    expect(opts.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([`bizd:send:${id}`, `bizd:drop:${id}`])

    const denied = await update(tap(STRANGER, `bizd:send:${id}`))
    expect(denied.answers[0].text).toBe('Not authorized.')
    expect(sends()).toHaveLength(1)

    await update(tap(OWNER, `bizd:send:${id}`))
    expect(sends()).toHaveLength(2)
    expect(sends()[1].args).toEqual([PARTNER, 'Holnap küldöm.', { business_connection_id: 'c1', reply_parameters: { message_id: 50 } }])
    expect(notes.at(-1).meta).toMatchObject({ business_draft: id, outcome: 'sent' })

    await update(tap(OWNER, `bizd:send:${id}`))
    expect(sends()).toHaveLength(2)
  })

  it('reject sends nothing to the partner and tells the session', async () => {
    const { biz, update } = setup()
    await update(bmsg('c1', PARTNER, 'kérdés'))
    const id = draftId(await biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: 'x' }))
    const r = await update(tap(OWNER, `bizd:drop:${id}`))
    expect(sends()).toHaveLength(1)
    expect(r.edits[0]).toMatch(/Elvetve$/)
    expect(notes.at(-1).meta).toMatchObject({ business_draft: id, outcome: 'rejected' })
  })

  it('a restart keeps the known chats and the open drafts', async () => {
    const first = setup()
    await first.update(bmsg('c1', PARTNER, 'kérdés'))
    const id = draftId(await first.biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: 'Rendben.' }))
    const second = setup()
    await second.update(tap(OWNER, `bizd:send:${id}`))
    expect(sends().at(-1)!.args.slice(0, 2)).toEqual([PARTNER, 'Rendben.'])
    await expect(second.biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: 'még egy' })).resolves.toBeTruthy()
  })

  it('other buttons (the plugin\'s permission prompts) are left to the plugin', async () => {
    const { update, fell } = setup()
    await update(tap(OWNER, 'perm:allow:abcde'))
    expect(fell()).toBe(1)
  })

  it('empty and over-long drafts are refused', async () => {
    const { biz, update } = setup()
    await update(bmsg('c1', PARTNER, 'kérdés'))
    await expect(biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: '  ' })).rejects.toThrow(/empty/)
    await expect(biz.callTool('business_draft', { chat_id: String(PARTNER), business_connection_id: 'c1', text: 'x'.repeat(3801) })).rejects.toThrow(/too long/)
  })
})

describe('marveen-business: polling', () => {
  const BIZ = ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages']
  const started = () => calls.filter(c => c.method === 'start').map(c => c.args[0])

  it('bot.start without a list asks for grammY\'s default set plus the business types, the other options kept', async () => {
    const { bot } = setup()
    const onStart = () => {}
    await (bot as any).start({ onStart })
    expect(started()).toEqual([{ onStart, allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member', ...BIZ] }])
  })

  it('a list another patch set (tgreact1119: message_reaction) is extended, not replaced, and nothing twice', async () => {
    const { bot } = setup()
    await (bot as any).start({ allowed_updates: ['message', 'callback_query', 'message_reaction', 'business_message'] })
    expect(started()[0].allowed_updates).toEqual(['message', 'callback_query', 'message_reaction', 'business_message',
      'business_connection', 'edited_business_message', 'deleted_business_messages'])
  })
})
