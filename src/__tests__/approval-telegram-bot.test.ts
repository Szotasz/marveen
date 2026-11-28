// APPROVALTGBOT1128: an agent_create approval on Telegram with a separate approval bot. No real bot: the Bot API is a
// fake call, the DB is in memory. The route (switch, explicit owner, vault token, never the main bot's token), the post
// (the stored spec's own text, two buttons with separate one-time nonces, the row bound to the text and the keyboard
// Telegram stored), a request too long
// for one message (a pointer, no row), the click rules (owner, private chat, the posted message of this bot, unedited,
// the same keyboard, the pressed button's nonce; Revizor 6111 R1: a swapped button never decides), the decision through the core against the posted hash (once, the consumer once), and the offset.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initDatabase, createApproval, getApproval, getDb, getApprovalTelegramPost, getApprovalTelegramOffset, registerApprovalConsumer, type Approval } from '../db.js'
import {
  postAgentCreateToTelegramBot, telegramApprovalTick, handleTelegramUpdate, telegramApprovalRoute, _clearBotIdCacheForTest, canonicalJsonValue,
  _clearSetupAlertsForTest, startTelegramApprovalPoller, stopTelegramApprovalPollerForTest,
  type TelegramApprovalDeps,
} from '../web/approval-telegram-bot.js'
import { canonicalJson, renderAgentSpec, type AgentSpecV1 } from '../web/agent-create-spec.js'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const OWNER = '1268077055'
const BOT = 7000001
const TOKEN = '7000001:APPROVAL-bot-token-not-real'
const MAIN = '6000001:MAIN-bot-token-not-real'
const VIZIT = '6000002:VIZIT-agent-bot-token-not-real'
const SPEC: AgentSpecV1 = {
  spec_version: 1, name: 'kutato', display_name: 'Kutató', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default',
  custom_provider: null, channel: null,
}

let n = 0
function request(spec: AgentSpecV1 = SPEC, category = 'agent_create'): Approval {
  const id = `ac-tg-${String(n++).padStart(4, '0')}`
  const json = canonicalJson(spec)
  const a = createApproval({ id, agent_id: 'samu', category, action_description: 'AZ ÜGYNÖK SAJÁT LEÍRÁSA', action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: sha(json) })
  getDb().prepare('INSERT INTO agent_create_specs (approval_id, spec_json, content_hash, requested_by, requested_at) VALUES (?, ?, ?, ?, ?)').run(id, json, sha(json), 'samu', Math.floor(Date.now() / 1000))
  return a
}

type Call = { token: string; method: string; params: Record<string, unknown> }
function fake(opts: { settings?: Record<string, string>; token?: string | null; mainToken?: string | null; sendFails?: boolean; agentTokens?: Array<{ agent: string; token: string }> } = {}) {
  const calls: Call[] = []
  const alerts: string[] = []
  const updates: Record<string, unknown>[] = []
  let nextMessageId = 500
  const settings: Record<string, string> = { APPROVAL_TELEGRAM_BOT: 'on', APPROVAL_TELEGRAM_OWNER_ID: OWNER, ...opts.settings }
  const deps: TelegramApprovalDeps = {
    setting: (k) => settings[k] ?? '',
    token: () => (opts.token === undefined ? TOKEN : opts.token),
    mainToken: () => (opts.mainToken === undefined ? MAIN : opts.mainToken),
    agentTokens: () => opts.agentTokens ?? [{ agent: 'vizit', token: VIZIT }],
    alert: (text) => { alerts.push(text) },
    api: async (token, method, params) => {
      calls.push({ token, method, params })
      if (method === 'getMe') return { id: BOT, is_bot: true, username: 'approval_bot' }
      if (method === 'sendMessage') {
        if (opts.sendFails) throw new Error('Telegram API sendMessage 403: Forbidden: bot was blocked by the user')
        return { message_id: nextMessageId++, chat: { id: Number(params.chat_id), type: 'private' }, from: { id: BOT, is_bot: true }, text: String(params.text), reply_markup: params.reply_markup }
      }
      if (method === 'getUpdates') return updates.filter((u) => (u.update_id as number) >= Number(params.offset))
      return true
    },
  }
  return { deps, calls, updates, settings, alerts }
}

async function posted(f = fake()) {
  const a = request()
  expect(await postAgentCreateToTelegramBot(a, 'hu', f.deps)).toBe('posted')
  const send = f.calls.filter((c) => c.method === 'sendMessage').at(-1)!
  const kb = (send.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]
  const nonce = kb[0].callback_data.slice(2)
  const rnonce = kb[1].callback_data.slice(2)
  const post = getApprovalTelegramPost(a.id)!
  markups.set(post.message_id, send.params.reply_markup)
  return { a, f, nonce, rnonce, post, text: String(send.params.text), markup: send.params.reply_markup }
}

let updateId = 9000
// The keyboard Telegram returned for each posted message: a click carries its message's current keyboard.
const markups = new Map<number, unknown>()
function click(p: { messageId: number; text: string; data: string; fromId?: number; isBot?: boolean; chatId?: number; chatType?: string; authorId?: number; edited?: boolean; markup?: unknown }) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: p.fromId ?? Number(OWNER), is_bot: p.isBot ?? false },
      data: p.data,
      message: {
        message_id: p.messageId, date: Math.floor(Date.now() / 1000), text: p.text,
        chat: { id: p.chatId ?? Number(OWNER), type: p.chatType ?? 'private' },
        from: { id: p.authorId ?? BOT, is_bot: true },
        reply_markup: p.markup === undefined ? markups.get(p.messageId) : p.markup,
        ...(p.edited ? { edit_date: Math.floor(Date.now() / 1000) } : {}),
      },
    },
  }
}
const ctx = (f: ReturnType<typeof fake>) => ({ token: TOKEN, owner: OWNER, botId: String(BOT), deps: f.deps })

const consumed: string[] = []
beforeAll(() => { registerApprovalConsumer('agent_create', (a) => { consumed.push(a.id) }) })
beforeEach(() => { initDatabase(':memory:'); _clearBotIdCacheForTest(); _clearSetupAlertsForTest(); consumed.length = 0 })

describe('the route: switch, explicit owner, vault token, never the main bot', () => {
  it('off (the default): nothing is posted, the poller never calls Telegram', async () => {
    const f = fake({ settings: { APPROVAL_TELEGRAM_BOT: 'off' } })
    const a = request()
    expect(await postAgentCreateToTelegramBot(a, 'hu', f.deps)).toBe('switch_off')
    expect(await telegramApprovalTick(f.deps)).toEqual([])
    expect(f.calls).toEqual([])
    expect(getApprovalTelegramPost(a.id)).toBeUndefined()
  })
  it('no explicit owner, a group id or junk as owner, no token: nothing is posted', async () => {
    for (const owner of ['', '-1001234', 'abc', '0']) {
      expect(telegramApprovalRoute(fake({ settings: { APPROVAL_TELEGRAM_OWNER_ID: owner } }).deps)).toEqual({ ok: false, reason: 'no_explicit_owner' })
    }
    const f = fake({ token: null })
    expect(await postAgentCreateToTelegramBot(request(), 'hu', f.deps)).toBe('no_token')
    expect(f.calls).toEqual([])
  })
  it('the main bot\'s token as the approval bot is refused (its updates belong to the channel plugin); the main agent hears it once', async () => {
    const f = fake({ token: MAIN })
    expect(await postAgentCreateToTelegramBot(request(), 'hu', f.deps)).toBe('main_bot_token')
    expect(await postAgentCreateToTelegramBot(request(), 'hu', f.deps)).toBe('main_bot_token')
    expect(f.calls).toEqual([])
    expect(f.alerts).toHaveLength(1)
    expect(f.alerts[0]).toContain('a FŐ bot tokenje')
    expect(f.alerts[0]).not.toContain(MAIN)
  })
  it('Marveen 6117: ANY agent\'s own bot token is refused too, naming the agent; at start, at the poll and at the post, said once', async () => {
    const f = fake({ token: VIZIT })
    expect(telegramApprovalRoute(f.deps)).toEqual({ ok: false, reason: 'agent_bot_token', agent: 'vizit' })
    startTelegramApprovalPoller(f.deps)
    stopTelegramApprovalPollerForTest()
    expect(f.alerts).toHaveLength(1)
    expect(f.alerts[0]).toContain('a(z) vizit ügynök saját Telegram-botjáé')
    expect(f.alerts[0]).toContain('approval-telegram-bot-token')
    expect(f.alerts[0]).not.toContain(VIZIT)
    request()
    expect(await telegramApprovalTick(f.deps)).toEqual([])
    expect(await postAgentCreateToTelegramBot(request(), 'hu', f.deps)).toBe('agent_bot_token')
    expect(f.calls).toEqual([])
    expect(f.alerts).toHaveLength(1)
  })
  it('a poll reports the setup error even while nothing waits (within one poll of the change)', async () => {
    const f = fake({ token: VIZIT })
    expect(await telegramApprovalTick(f.deps)).toEqual([])
    expect(f.alerts).toHaveLength(1)
  })
  it('a separate bot\'s token with agents that have their own bots: posted as usual, no alert', async () => {
    const f = fake({ agentTokens: [{ agent: 'vizit', token: VIZIT }, { agent: 'roka', token: '6000003:ROKA-not-real' }] })
    expect(await postAgentCreateToTelegramBot(request(), 'hu', f.deps)).toBe('posted')
    expect(f.alerts).toEqual([])
  })
  it('only agent_create is posted; a request whose stored spec no longer hashes to it is not', async () => {
    const f = fake()
    expect(await postAgentCreateToTelegramBot(request(SPEC, 'email_send'), 'hu', f.deps)).toBe('not_agent_create')
    const a = request()
    getDb().prepare('UPDATE agent_create_specs SET spec_json = ? WHERE approval_id = ?').run(canonicalJson({ ...SPEC, model: 'other' }), a.id)
    expect(await postAgentCreateToTelegramBot(a, 'hu', f.deps)).toBe('not_verifiable')
    expect(f.calls.filter((c) => c.method === 'sendMessage')).toEqual([])
  })
})

describe('the post', () => {
  it('the stored spec\'s own text to the owner\'s chat with the approval bot, two buttons with separate nonces; the row binds what Telegram stored', async () => {
    const { a, f, nonce, rnonce, post, text, markup } = await posted()
    const send = f.calls.find((c) => c.method === 'sendMessage')!
    expect(send.token).toBe(TOKEN)
    expect(send.params.chat_id).toBe(OWNER)
    expect(text.startsWith(renderAgentSpec(SPEC, a.content_hash!, 'hu'))).toBe(true)
    const kb = (send.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]
    expect(kb.map((b) => b.callback_data)).toEqual([`a:${nonce}`, `r:${rnonce}`])
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(rnonce).toMatch(/^[0-9a-f]{32}$/)
    expect(rnonce).not.toBe(nonce)
    expect(post).toMatchObject({ chat_id: OWNER, bot_id: String(BOT), owner_user_id: OWNER, content_hash: a.content_hash, text_sha256: sha(text), approve_nonce_sha256: sha(nonce), reject_nonce_sha256: sha(rnonce), markup_sha256: sha(canonicalJsonValue(markup)), lang: 'hu', decided_at: null })
    expect(JSON.stringify(post)).not.toContain(nonce)
    expect(JSON.stringify(post)).not.toContain(rnonce)
  })
  it('too long for one Telegram message: a short dashboard pointer, no post row, so no click can approve it', async () => {
    const f = fake()
    const a = request({ ...SPEC, description: 'x'.repeat(5000) })
    expect(await postAgentCreateToTelegramBot(a, 'hu', f.deps)).toBe('too_long')
    const send = f.calls.filter((c) => c.method === 'sendMessage')
    expect(send).toHaveLength(1)
    expect(send[0].params.reply_markup).toBeUndefined()
    expect(String(send[0].params.text)).toContain('dashboardon')
    expect(getApprovalTelegramPost(a.id)).toBeUndefined()
  })
  it('a failed send leaves the request pending, with no row', async () => {
    const f = fake({ sendFails: true })
    const a = request()
    expect(await postAgentCreateToTelegramBot(a, 'hu', f.deps)).toBe('send_failed')
    expect(getApprovalTelegramPost(a.id)).toBeUndefined()
    expect(getApproval(a.id)!.status).toBe('pending')
  })
})

describe('a click decides only on every check', () => {
  it('approve: the owner, the private chat, the posted message, its nonce -> approved once, the consumer once, the offset moves on', async () => {
    const { a, f, nonce, post, text } = await posted()
    const u = click({ messageId: post.message_id, text, data: `a:${nonce}` })
    f.updates.push(u)
    expect(await telegramApprovalTick(f.deps)).toEqual([{ updateId: u.update_id, outcome: 'approved' }])
    const after = getApproval(a.id)!
    expect(after.status).toBe('approved')
    expect(after.resolved_by).toBe(`telegram_button:${OWNER}:${u.update_id}`)
    expect(consumed).toEqual([a.id])
    expect(getApprovalTelegramPost(a.id)).toMatchObject({ decision: 'approved', decided_by_update: u.update_id })
    expect(getApprovalTelegramOffset(String(BOT))).toBe(u.update_id + 1)
    expect(f.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true)
    // the same update again (a restart, a replayed poll): never read again; a direct replay is refused by the row
    expect(await telegramApprovalTick(f.deps)).toEqual([])
    expect(await handleTelegramUpdate(u, ctx(f))).toBe('post_already_used')
    expect(consumed).toEqual([a.id])
  })
  it('reject: the reject button rejects; the consumer does not run', async () => {
    const { a, f, rnonce, post, text } = await posted()
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `r:${rnonce}` }), ctx(f))).toBe('rejected')
    expect(getApproval(a.id)!.status).toBe('rejected')
    expect(consumed).toEqual([])
  })
  it('refused, the request stays pending and the post open: another user, a bot, a group, another chat, not a post, another bot\'s message, an edited post, a changed text, bad data, a wrong nonce', async () => {
    const { a, f, nonce, rnonce, post, text } = await posted()
    const ok = { messageId: post.message_id, text, data: `a:${nonce}` }
    const cases: [ReturnType<typeof click>, string][] = [
      [click({ ...ok, fromId: 555 }), 'not_owner'],
      [click({ ...ok, isBot: true }), 'not_owner'],
      [click({ ...ok, chatType: 'group', chatId: -100123 }), 'not_private'],
      [click({ ...ok, chatId: 555 }), 'not_private'],
      [click({ ...ok, chatType: 'supergroup' }), 'not_private'],
      [click({ ...ok, messageId: post.message_id + 1 }), 'not_a_post'],
      [click({ ...ok, authorId: 6000001 }), 'not_our_message'],
      [click({ ...ok, edited: true }), 'post_edited'],
      [click({ ...ok, text: text.replace('Piackutatás', 'Ártalmatlan') }), 'post_text_changed'],
      [click({ ...ok, data: `x:${nonce}` }), 'bad_data'],
      [click({ ...ok, data: 'a:' + '0'.repeat(32) }), 'nonce_mismatch'],
      // Revizor 6111 R1: the reject button's value never approves
      [click({ ...ok, data: `a:${rnonce}` }), 'nonce_mismatch'],
      [click({ ...ok, data: `r:${nonce}` }), 'nonce_mismatch'],
      // a keyboard that is not the posted one (no edit_date), or none
      [click({ ...ok, markup: { inline_keyboard: [] } }), 'post_buttons_changed'],
      [click({ ...ok, markup: null }), 'post_buttons_changed'],
    ]
    for (const [u, want] of cases) expect(await handleTelegramUpdate(u, ctx(f)), want).toBe(want)
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalTelegramPost(a.id)!.decided_at).toBeNull()
    expect(consumed).toEqual([])
  })
  it('Revizor 6111 R1: a thief who saw a lost reject click swaps the labels (no edit_date); the owner presses "Elutasítom" again: nothing is approved', async () => {
    const { a, f, nonce, rnonce, post, text, markup } = await posted()
    // the thief read the owner's reject click before the server: it carries the message's keyboard, so both values
    const seen = (markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]
    expect(seen.map((b) => b.callback_data)).toEqual([`a:${nonce}`, `r:${rnonce}`])
    // swap: the button labelled "Elutasítom" now carries the approve value, and Telegram (say) sets no edit_date
    const swapped = { inline_keyboard: [[{ text: 'Jóváhagyom', callback_data: `r:${rnonce}` }, { text: 'Elutasítom', callback_data: `a:${nonce}` }]] }
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `a:${nonce}`, markup: swapped }), ctx(f))).toBe('post_buttons_changed')
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalTelegramPost(a.id)!.decided_at).toBeNull()
    expect(consumed).toEqual([])
  })
  it('the keyboard binding does not depend on key order (Telegram may order fields differently)', async () => {
    const { a, f, nonce, post, text, markup } = await posted()
    const kb = (markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]
    const reordered = { inline_keyboard: [kb.map((b) => ({ callback_data: b.callback_data, text: b.text }))] }
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `a:${nonce}`, markup: reordered }), ctx(f))).toBe('approved')
    expect(getApproval(a.id)!.status).toBe('approved')
  })
  it('the request changed since the post: the click decides nothing, the post closes', async () => {
    const { a, f, nonce, post, text } = await posted()
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('b'.repeat(64), a.id)
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `a:${nonce}` }), ctx(f))).toBe('approved:content_changed')
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalTelegramPost(a.id)!.decision).toBe('approved:content_changed')
    expect(consumed).toEqual([])
  })
  it('timed out: an approval click does not approve', async () => {
    const { a, f, nonce, post, text } = await posted()
    getDb().prepare('UPDATE approvals SET timeout_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, a.id)
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `a:${nonce}` }), ctx(f))).toBe('approved:expired')
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(consumed).toEqual([])
  })
  it('decided elsewhere first (the dashboard): the click changes nothing', async () => {
    const { a, f, nonce, post, text } = await posted()
    getDb().prepare("UPDATE approvals SET status = 'rejected', resolved_by = 'dashboard_owner' WHERE id = ?").run(a.id)
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `a:${nonce}` }), ctx(f))).toBe('approved:not_pending')
    expect(getApproval(a.id)!.status).toBe('rejected')
    expect(consumed).toEqual([])
  })
  it('a second click on the same post after the decision: already used', async () => {
    const { a, f, nonce, rnonce, post, text } = await posted()
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `r:${rnonce}` }), ctx(f))).toBe('rejected')
    expect(await handleTelegramUpdate(click({ messageId: post.message_id, text, data: `a:${nonce}` }), ctx(f))).toBe('post_already_used')
    expect(getApproval(a.id)!.status).toBe('rejected')
  })
})

describe('one update, one decision', () => {
  it('an update id that already decided one post cannot decide another (the unique index; the second post stays open)', async () => {
    const f = fake()
    const p1 = await posted(f)
    const p2 = await posted(f)
    const u1 = click({ messageId: p1.post.message_id, text: p1.text, data: `r:${p1.rnonce}` })
    expect(await handleTelegramUpdate(u1, ctx(f))).toBe('rejected')
    const forged = { ...click({ messageId: p2.post.message_id, text: p2.text, data: `a:${p2.nonce}` }), update_id: u1.update_id }
    expect(await handleTelegramUpdate(forged, ctx(f))).toBe('post_already_used')
    expect(getApproval(p2.a.id)!.status).toBe('pending')
    expect(getApprovalTelegramPost(p2.a.id)!.decided_at).toBeNull()
    expect(consumed).toEqual([])
  })
})

describe('the poller', () => {
  it('idle while no post waits: no Telegram call at all', async () => {
    const f = fake()
    request()
    expect(await telegramApprovalTick(f.deps)).toEqual([])
    expect(f.calls).toEqual([])
  })
  it('asks with the stored offset and only for callback queries; a non-click update is skipped and never read again', async () => {
    const { f } = await posted()
    f.updates.push({ update_id: 42, message: { text: 'igen', chat: { id: Number(OWNER), type: 'private' }, from: { id: Number(OWNER) } } })
    expect(await telegramApprovalTick(f.deps)).toEqual([{ updateId: 42, outcome: 'no_callback' }])
    const gets = f.calls.filter((c) => c.method === 'getUpdates')
    expect(gets[0].params).toMatchObject({ offset: 0, allowed_updates: ['callback_query'] })
    expect(getApprovalTelegramOffset(String(BOT))).toBe(43)
    await telegramApprovalTick(f.deps)
    expect(f.calls.filter((c) => c.method === 'getUpdates')[1].params.offset).toBe(43)
  })
})

describe('the two settings (APPROVALTGBOT1128)', async () => {
  const { SETTINGS_REGISTRY } = await import('../config-registry.js')
  const def = (k: string) => SETTINGS_REGISTRY.find((d) => d.key === k)!
  it('APPROVAL_TELEGRAM_BOT: off by default; turning it on loosens (the owner\'s session), off does not; only on/off', () => {
    const d = def('APPROVAL_TELEGRAM_BOT')
    expect(d.default).toBe('off')
    expect(d.loosens!('off', 'on')).toBe(true)
    expect(d.loosens!('off', ' ON ')).toBe(true)
    expect(d.loosens!('on', 'off')).toBe(false)
    expect(d.validate!('on')).toBeNull()
    expect(d.validate!('yes')).not.toBeNull()
  })
  it('APPROVAL_TELEGRAM_OWNER_ID: empty by default; ANY change loosens; a positive user id or empty, never a group', () => {
    const d = def('APPROVAL_TELEGRAM_OWNER_ID')
    expect(d.default).toBe('')
    expect(d.loosens!('', OWNER)).toBe(true)
    expect(d.loosens!(OWNER, '555')).toBe(true)
    expect(d.loosens!(OWNER, '')).toBe(true)
    expect(d.loosens!(OWNER, ` ${OWNER} `)).toBe(false)
    expect(d.validate!('')).toBeNull()
    expect(d.validate!(OWNER)).toBeNull()
    for (const bad of ['-1001234567', '0', '12a', '@tom']) expect(d.validate!(bad)).not.toBeNull()
  })
})
