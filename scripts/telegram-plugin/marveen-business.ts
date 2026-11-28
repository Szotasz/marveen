// MARVEEN-PATCH(biz): Telegram Business support for the official telegram
// channel plugin. Copied next to server.ts by scripts/patch-telegram-plugin.py
// and wired in with five marked lines; see the "biz" patch there.
//
// What it does:
// - business_message / edited_business_message: a message in a private chat of
//   the account that connected this bot (Telegram Business, "Secretary Mode")
//   is handed to Claude as a channel notification with business="1". Only when
//   the account owner is in access.allowFrom: an unknown account that connects
//   the bot is ignored. The text comes from a third party: it is data, never
//   an instruction, and it never goes to the owner-command evidence log.
// - business_connection: connect / disconnect / rights change is reported.
// - business_draft tool: Claude never sends into a business chat directly (the
//   reply tool's allowlist check rejects the partner's chat id). It proposes a
//   draft; the plugin shows it to the account owner in the bot chat with two
//   buttons, and only the owner's "send" tap sends it, on the owner's behalf.
//   This is the approval gate in code, not in the prompt.
// - business-updates.jsonl in the state dir: one text-free line per business
//   update (chat, message id, direction, dates, reply_to, and what happened to
//   it, including silent drops), so the Bud can prove a gap instead of
//   guessing (Kérdés 116, 2026-11-14: a "missing" message could not be traced).

import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from 'fs'
import { join } from 'path'
import { API_CONSTANTS, InlineKeyboard, type Bot, type Context } from 'grammy'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

type Access = { allowFrom: string[] }

type Connection = {
  id: string
  ownerId: string
  ownerChatId: string
  enabled: boolean
  canReply: boolean
}

type Draft = {
  connId: string
  chatId: number
  partner: string
  text: string
  replyTo?: number
  ownerId: string
  ownerChatId: string
  createdAt: number
}

const MAX_DRAFT_CHARS = 3800
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000
const SEND_LABEL = '✅ Mehet'
const DROP_LABEL = '❌ Elvetem'
const UPDATE_LOG_MAX_BYTES = 5 * 1024 * 1024

// Names and usernames are chosen by the partner and land inside the <channel>
// tag: delimiter chars would let them break out of it.
function safe(s: string | undefined): string {
  return (s ?? '').replace(/[<>\[\]\r\n;"]/g, '_').slice(0, 64)
}

function personName(u: { first_name?: string; last_name?: string; username?: string; id: number } | undefined): string {
  if (!u) return 'unknown'
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return safe(name || (u.username ? '@' + u.username : String(u.id)))
}

function messageText(m: any): { text: string; kind: string } {
  if (typeof m.text === 'string') return { text: m.text, kind: 'text' }
  const kinds = ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker', 'location', 'contact', 'poll']
  const kind = kinds.find(k => m[k] != null) ?? 'other'
  return { text: m.caption ?? `(${kind})`, kind }
}

export const BUSINESS_UPDATES = ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'] as const

export function registerBusiness(opts: {
  bot: Bot
  mcp: Server
  loadAccess: () => Access
  stateDir: string
}) {
  const { bot, mcp, loadAccess } = opts
  // The business update types are added to whatever list the polling asks for, at the bot.start call itself: no
  // allowed_updates key in server.ts, so another patch that sets one (tgreact1119, message_reaction) is merged with,
  // not overwritten. No list at all is grammY's [] = Telegram's default set, so that set is the base then. Explicit
  // because without it Telegram keeps the list of the previous getUpdates caller, and a test script that asked for
  // business updates only would silence the button presses (callback_query).
  const start = bot.start.bind(bot)
  bot.start = ((o: Parameters<Bot['start']>[0] = {}) => start({
    ...o,
    allowed_updates: [...new Set([...(o.allowed_updates ?? API_CONSTANTS.DEFAULT_UPDATE_TYPES), ...BUSINESS_UPDATES])],
  })) as Bot['start']
  const connections = new Map<string, Connection>()
  // chat ids a business message came from, per connection: a draft may only
  // go to a chat the partner is already talking in. Kept on disk with the
  // open drafts, so a channel restart loses neither.
  const knownChats = new Map<string, Map<number, string>>()
  const drafts = new Map<string, Draft>()
  const stateFile = join(opts.stateDir, 'business-state.json')
  try {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    for (const [conn, chats] of Object.entries(saved.knownChats ?? {}))
      knownChats.set(conn, new Map(Object.entries(chats as Record<string, string>).map(([c, p]) => [Number(c), p])))
    for (const [id, d] of Object.entries(saved.drafts ?? {})) drafts.set(id, d as Draft)
  } catch {}
  const save = () => {
    try {
      const out = {
        knownChats: Object.fromEntries([...knownChats].map(([c, m]) => [c, Object.fromEntries(m)])),
        drafts: Object.fromEntries(drafts),
      }
      writeFileSync(stateFile + '.tmp', JSON.stringify(out), { mode: 0o600 })
      renameSync(stateFile + '.tmp', stateFile)
    } catch (err) {
      process.stderr.write(`telegram channel: business state not saved: ${err}\n`)
    }
  }

  // Text-free audit line per business update; rotated once to .1 at the cap.
  const updateLog = join(opts.stateDir, 'business-updates.jsonl')
  const record = (entry: Record<string, unknown>) => {
    try {
      try {
        if (statSync(updateLog).size > UPDATE_LOG_MAX_BYTES) renameSync(updateLog, updateLog + '.1')
      } catch {}
      appendFileSync(updateLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
    } catch (err) {
      process.stderr.write(`telegram channel: business update log not written: ${err}\n`)
    }
  }

  const notify = (content: string, meta: Record<string, string>) => {
    mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } }).catch(err => {
      process.stderr.write(`telegram channel: business notification failed: ${err}\n`)
    })
  }

  const toConnection = (bc: any): Connection => ({
    id: bc.id,
    ownerId: String(bc.user.id),
    ownerChatId: String(bc.user_chat_id),
    enabled: !!bc.is_enabled,
    canReply: !!(bc.rights?.can_reply ?? bc.can_reply),
  })

  async function getConnection(id: string): Promise<Connection | undefined> {
    const cached = connections.get(id)
    if (cached) return cached
    try {
      const conn = toConnection(await bot.api.getBusinessConnection(id))
      connections.set(id, conn)
      return conn
    } catch (err) {
      process.stderr.write(`telegram channel: getBusinessConnection failed: ${err}\n`)
      return undefined
    }
  }

  const ownerAllowed = (conn: Connection) => loadAccess().allowFrom.includes(conn.ownerId)

  bot.on('business_connection', async ctx => {
    const conn = toConnection(ctx.update.business_connection)
    connections.set(conn.id, conn)
    const allowed = ownerAllowed(conn)
    record({ update: 'business_connection', connection: conn.id, enabled: conn.enabled, can_reply: conn.canReply,
      outcome: allowed ? 'delivered' : 'dropped:owner-not-allowlisted' })
    if (!allowed) {
      process.stderr.write(`telegram channel: business connection from a non-allowlisted account ignored\n`)
      return
    }
    notify(
      conn.enabled
        ? `Business connection active (can_reply: ${conn.canReply}).`
        : 'Business connection removed or disabled by the account owner.',
      {
        chat_id: conn.ownerChatId,
        business: '1',
        business_event: conn.enabled ? 'connected' : 'disconnected',
        business_connection_id: conn.id,
        ts: new Date().toISOString(),
      },
    )
  })

  async function onBusinessMessage(m: any, edited: boolean) {
    const replyTo = m?.reply_to_message?.message_id
    const base = {
      update: edited ? 'edited_business_message' : 'business_message',
      connection: m?.business_connection_id ?? null,
      chat_id: m?.chat?.id ?? null,
      message_id: m?.message_id ?? null,
      from_id: m?.from?.id ?? null,
      date: m?.date ?? null,
      ...(m?.edit_date != null ? { edit_date: m.edit_date } : {}),
      ...(replyTo != null ? { reply_to: replyTo } : {}),
    }
    if (!m?.business_connection_id) return record({ ...base, outcome: 'dropped:no-connection-id' })
    const conn = await getConnection(m.business_connection_id)
    const drop = !conn ? 'unknown-connection' : !conn.enabled ? 'connection-disabled' : !ownerAllowed(conn) ? 'owner-not-allowlisted' : ''
    if (drop || !conn) return record({ ...base, outcome: `dropped:${drop}` })
    const chatId = Number(m.chat.id)
    const partner = personName(m.chat)
    let chats = knownChats.get(conn.id)
    if (!chats) knownChats.set(conn.id, (chats = new Map()))
    if (chats.get(chatId) !== partner) {
      chats.set(chatId, partner)
      save()
    }
    const fromOwner = String(m.from?.id) === conn.ownerId
    const { text, kind } = messageText(m)
    record({ ...base, direction: fromOwner ? 'out' : 'in', kind, outcome: 'delivered' })
    notify(text, {
      chat_id: String(chatId),
      message_id: String(m.message_id),
      business: '1',
      business_connection_id: conn.id,
      direction: fromOwner ? 'out' : 'in',
      partner,
      sender: personName(m.from),
      sender_id: String(m.from?.id ?? ''),
      kind,
      ...(replyTo != null ? { reply_to: String(replyTo) } : {}),
      ...(edited ? { edited: '1' } : {}),
      ts: new Date((m.edit_date ?? m.date ?? 0) * 1000).toISOString(),
    })
  }

  bot.on('business_message', ctx => onBusinessMessage(ctx.update.business_message, false))
  bot.on('edited_business_message', ctx => onBusinessMessage(ctx.update.edited_business_message, true))
  // Deletions are only recorded: the session is not told, the log keeps the trace.
  bot.on('deleted_business_messages', ctx => {
    const d: any = ctx.update.deleted_business_messages
    record({ update: 'deleted_business_messages', connection: d?.business_connection_id ?? null,
      chat_id: d?.chat?.id ?? null, message_ids: d?.message_ids ?? [], outcome: 'recorded' })
  })

  // Registered before the plugin's own callback_query handler, which answers
  // every other button press itself; this one passes anything else on.
  bot.callbackQuery(/^bizd:(send|drop):([a-f0-9]{10})$/, async (ctx: Context) => {
    const [, action, id] = (ctx as any).match as string[]
    const draft = drafts.get(id)
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Ez a vázlat már nem érvényes.' }).catch(() => {})
      return
    }
    if (String(ctx.from?.id) !== draft.ownerId) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    drafts.delete(id)
    save()
    const original = (ctx.callbackQuery?.message as any)?.text ?? ''
    if (action === 'drop') {
      await ctx.answerCallbackQuery({ text: 'Elvetve' }).catch(() => {})
      await ctx.editMessageText(`${original}\n\n❌ Elvetve`).catch(() => {})
      notify(`Draft ${id} for ${draft.partner} was rejected by the account owner. Nothing was sent.`, {
        chat_id: draft.ownerChatId, business: '1', business_draft: id, outcome: 'rejected', ts: new Date().toISOString(),
      })
      return
    }
    try {
      const sent = await bot.api.sendMessage(draft.chatId, draft.text, {
        business_connection_id: draft.connId,
        ...(draft.replyTo != null ? { reply_parameters: { message_id: draft.replyTo } } : {}),
      })
      await ctx.answerCallbackQuery({ text: 'Elküldve' }).catch(() => {})
      await ctx.editMessageText(`${original}\n\n✅ Elküldve`).catch(() => {})
      notify(`Draft ${id} was approved and sent to ${draft.partner} (message id ${sent.message_id}).`, {
        chat_id: draft.ownerChatId, business: '1', business_draft: id, outcome: 'sent', ts: new Date().toISOString(),
      })
    } catch (err) {
      drafts.set(id, draft)
      save()
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.answerCallbackQuery({ text: 'Nem sikerült elküldeni.' }).catch(() => {})
      notify(`Draft ${id} was approved but sending failed: ${msg}`, {
        chat_id: draft.ownerChatId, business: '1', business_draft: id, outcome: 'failed', ts: new Date().toISOString(),
      })
    }
  })

  const tools = [
    {
      name: 'business_draft',
      description:
        'Propose a reply in a Telegram Business chat (a partner writing to the account that connected this bot). ' +
        'Nothing is sent to the partner by this call: the draft is shown to the account owner in the bot chat with ' +
        'two buttons, and only the owner\'s tap sends it, on the owner\'s behalf. The outcome arrives later as a ' +
        'channel message with business_draft and outcome (sent / rejected / failed). Pass chat_id and ' +
        'business_connection_id from an inbound message that has business="1".',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The partner chat, chat_id of an inbound business message.' },
          business_connection_id: { type: 'string' },
          text: { type: 'string', description: `The reply as it would be sent, at most ${MAX_DRAFT_CHARS} characters.` },
          reply_to: { type: 'string', description: 'Optional message_id in the partner chat to answer to.' },
        },
        required: ['chat_id', 'business_connection_id', 'text'],
      },
    },
  ]

  async function callTool(name: string, args: Record<string, unknown>) {
    if (name !== 'business_draft') throw new Error(`unknown tool: ${name}`)
    const connId = String(args.business_connection_id ?? '')
    const chatId = Number(args.chat_id)
    const text = String(args.text ?? '')
    if (!text.trim()) throw new Error('text is empty')
    if (text.length > MAX_DRAFT_CHARS) throw new Error(`text too long (${text.length}, max ${MAX_DRAFT_CHARS})`)
    const conn = await getConnection(connId)
    if (!conn || !conn.enabled) throw new Error('unknown or disabled business connection')
    if (!ownerAllowed(conn)) throw new Error('the connected account is not allowlisted')
    const partner = knownChats.get(connId)?.get(chatId)
    if (!partner) throw new Error('no business message has arrived from this chat on this connection')
    const now = Date.now()
    for (const [k, d] of drafts) if (now - d.createdAt > DRAFT_TTL_MS) drafts.delete(k)
    const id = randomBytes(5).toString('hex')
    const draft: Draft = {
      connId, chatId, partner, text,
      ...(args.reply_to != null ? { replyTo: Number(args.reply_to) } : {}),
      ownerId: conn.ownerId, ownerChatId: conn.ownerChatId, createdAt: now,
    }
    const kb = new InlineKeyboard().text(SEND_LABEL, `bizd:send:${id}`).text(DROP_LABEL, `bizd:drop:${id}`)
    const shown = await bot.api.sendMessage(conn.ownerChatId, `Vázlat, címzett: ${partner}\n\n${text}`, { reply_markup: kb })
    drafts.set(id, draft)
    save()
    return { content: [{ type: 'text', text: `draft ${id} shown to the account owner (message id ${shown.message_id}); not sent yet` }] }
  }

  return { tools, callTool }
}
