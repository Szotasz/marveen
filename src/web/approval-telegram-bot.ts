// APPROVALTGBOT1128: the owner decides an agent_create request on Telegram, with a SEPARATE approval bot.
//
// Why a separate bot: the main bot's updates belong to the channel plugin (one getUpdates consumer per bot), and a
// decision relayed by the main agent would rest on the shared token, which agent_create refuses. Here the SERVER posts
// the request with the approval bot's own token and reads the owner's click with the same token, as the Teams card and
// the Slack reply path do: no agent is in the chain.
//
// The post: the stored spec's own text (renderAgentSpec, only while the spec still hashes to the approval), two inline
// buttons, each with its own one-time nonce in its callback data, into the private chat of the explicit owner
// (APPROVAL_TELEGRAM_OWNER_ID). A request too long for one Telegram message gets a short "decide on the dashboard"
// pointer and no post row, so no click can approve it.
//
// A click decides only when ALL hold: the update is a callback_query from the owner (not a bot); its message is in the
// owner's private chat, is the posted message of a row this bot recorded, was sent by this bot, was never edited, still
// has the text AND the inline keyboard Telegram returned at posting (a swapped button is refused, edit_date or not);
// the callback data is "a:" with the approve nonce or "r:" with the reject nonce (separate values, so a reject click
// never carries what approves). The decision
// then goes through the core against the content hash the post showed (decideApprovalFromTelegram): one click, one
// decision, and the category's consumer runs after the commit. Anything else decides nothing.
//
// The token lives in the vault (APPROVAL_TELEGRAM_BOT_VAULT_KEY), never in a log or a setting. It must not be the main
// bot's token. What a stolen token allows: posting or editing the bot's messages (a post with a changed text or
// changed buttons is refused) and reading or dropping its updates (an owner's click lost: nothing is decided, and the
// values the thief saw approve nothing on an unchanged post the owner did not press). It cannot forge the owner's
// click: Telegram signs nothing, but the server reads the update from Telegram itself, and from.id is Telegram's.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  recordApprovalTelegramPost, getApprovalTelegramPostByMessage, countPendingApprovalTelegramPosts, getApprovalTelegramOffset,
  advanceApprovalTelegramOffset, decideApprovalFromTelegram, type Approval,
} from '../db.js'
import { logger } from '../logger.js'
import { renderAgentSpec } from './agent-create-spec.js'
import { verifiedAgentSpec } from './approval-teams-card.js'
import type { ApprovalLang } from './approval-texts.js'

export const APPROVAL_TELEGRAM_BOT_VAULT_KEY = 'approval-telegram-bot-token'
/** Telegram's limit for one message's text. */
export const TELEGRAM_TEXT_LIMIT = 4096

/** One Telegram Bot API call: the result on {"ok":true}, a throw on anything else (the token is never in the error). */
export type TelegramBotApi = (token: string, method: string, params: Record<string, unknown>) => Promise<unknown>

export interface TelegramApprovalDeps {
  setting: (key: string) => string
  /** The approval bot's token from the vault, or null. */
  token: () => string | null
  /** The main bot's token (refused as the approval bot: its updates belong to the channel plugin), or null. */
  mainToken: () => string | null
  /** Every agent's own Telegram bot token (refused too: that agent's plugin would swallow the owner's clicks). */
  agentTokens: () => Array<{ agent: string; token: string }>
  /** A message to the main agent (a setup error the owner must fix). */
  alert: (text: string) => void
  api: TelegramBotApi
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** JSON with sorted keys at every level: the same keyboard hashes the same however Telegram orders its fields. */
export function canonicalJsonValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJsonValue).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJsonValue((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

export function telegramApprovalsOn(setting: (key: string) => string): boolean {
  return setting('APPROVAL_TELEGRAM_BOT').trim().toLowerCase() === 'on'
}

/** The explicit approver: a positive Telegram user id, or null (then nothing is posted and nothing decides). */
export function telegramApprovalOwner(setting: (key: string) => string): string | null {
  const v = setting('APPROVAL_TELEGRAM_OWNER_ID').trim()
  return /^[1-9][0-9]{0,19}$/.test(v) ? v : null
}

export type TelegramRoute =
  | { ok: true; token: string; owner: string }
  | { ok: false; reason: 'switch_off' | 'no_explicit_owner' | 'no_token' | 'main_bot_token' }
  | { ok: false; reason: 'agent_bot_token'; agent: string }

/** Is the approval bot usable now? The switch, the explicit owner, a vault token that is no other bot's of this
 *  install (the main bot's or any agent's: its updates belong to that bot's channel plugin, which would swallow the
 *  owner's clicks; it could never approve, but nothing would decide). */
export function telegramApprovalRoute(deps: Pick<TelegramApprovalDeps, 'setting' | 'token' | 'mainToken' | 'agentTokens'>): TelegramRoute {
  if (!telegramApprovalsOn(deps.setting)) return { ok: false, reason: 'switch_off' }
  const owner = telegramApprovalOwner(deps.setting)
  if (!owner) return { ok: false, reason: 'no_explicit_owner' }
  let token: string | null = null
  try { token = deps.token()?.trim() || null } catch { token = null }
  if (!token) return { ok: false, reason: 'no_token' }
  let main: string | null = null
  try { main = deps.mainToken()?.trim() || null } catch { main = null }
  if (main && main === token) return { ok: false, reason: 'main_bot_token' }
  let agents: Array<{ agent: string; token: string }> = []
  try { agents = deps.agentTokens() } catch { agents = [] }
  const same = agents.find((a) => (a.token ?? '').trim() === token)
  if (same) return { ok: false, reason: 'agent_bot_token', agent: same.agent }
  return { ok: true, token, owner }
}

/** The owner-facing text of a setup error (another bot's token as the approval bot), or null. */
export function telegramApprovalSetupError(route: TelegramRoute): string | null {
  if (route.ok) return null
  const fix = 'Hozz létre egy KÜLÖN botot a BotFathernél, és annak a tokenjét tedd a vaultba "approval-telegram-bot-token" néven. Addig a telegramos jóváhagyás nem működik, a kérések a dashboardon dönthetők el.'
  if (route.reason === 'main_bot_token') return `[agent_create] A jóváhagyó bot tokenje (vault: approval-telegram-bot-token) a FŐ bot tokenje. Ezt nem lehet használni, mert a fő bot üzeneteit a csatorna-plugin olvassa, és elnyelné Tom kattintását. ${fix}`
  if (route.reason === 'agent_bot_token') return `[agent_create] A jóváhagyó bot tokenje (vault: approval-telegram-bot-token) a(z) ${route.agent} ügynök saját Telegram-botjáé. Ezt nem lehet használni, mert annak az ügynöknek a pluginja olvassa a bot üzeneteit, és elnyelné Tom kattintását. ${fix}`
  return null
}

// One alert per (problem, token): the poll repeats every 10 s, the main agent hears it once.
const alerted = new Set<string>()
function reportSetupError(route: TelegramRoute, token: string | null, deps: Pick<TelegramApprovalDeps, 'alert'>): void {
  const text = telegramApprovalSetupError(route)
  if (!text || route.ok) return
  const key = `${route.reason}:${'agent' in route ? route.agent : ''}:${token ? sha256(token) : ''}`
  logger.error({ reason: route.reason, ...('agent' in route ? { agent: route.agent } : {}) }, 'agent_create: the approval bot token is another bot\'s token of this install; the Telegram approval is OFF (use a separate bot)')
  if (alerted.has(key)) return
  alerted.add(key)
  try { deps.alert(text) } catch { /* the log line stands */ }
}
export function _clearSetupAlertsForTest(): void { alerted.clear() }
function currentToken(deps: Pick<TelegramApprovalDeps, 'token'>): string | null {
  try { return deps.token()?.trim() || null } catch { return null }
}

const T = {
  hu: {
    approve: 'Jóváhagyom', reject: 'Elutasítom',
    footer: 'Döntés a lenti gombokkal. Csak ez az üzenet dönt, és csak amíg a kérés függőben van.',
    tooLong: (id: string) => `Jóváhagyás kell: új ügynök létrehozása (${id}). A leírás túl hosszú egy Telegram-üzenethez, ezért ez a kérés csak a dashboardon dönthető el.`,
    result: {
      approved: 'Jóváhagyva. Az ügynök a jóváhagyott leírás szerint jön létre.',
      rejected: 'Elutasítva. Ügynök nem jön létre.',
      not_pending: 'Erről a kérésről már döntöttek (dashboard vagy másik csatorna), vagy lejárt. Ez a kattintás nem változtatott semmin.',
      content_changed: 'A kérés tartalma a kiküldés óta megváltozott, ezért ez a kattintás nem döntött. Nézd meg a dashboardon.',
      expired: 'A kérés lejárt, ezért ez a kattintás nem hagyta jóvá. Kérd újra.',
      used: 'Erről az üzenetről már döntöttél.',
      refused: 'Ez a kattintás nem döntött (az üzenet nem a kiküldött kérés, vagy megváltozott). Nézd meg a dashboardon.',
    },
  },
  en: {
    approve: 'Approve', reject: 'Reject',
    footer: 'Decide with the buttons below. Only this message decides, and only while the request is pending.',
    tooLong: (id: string) => `Approval needed: create a new agent (${id}). The description is too long for one Telegram message, so this request can be decided on the dashboard only.`,
    result: {
      approved: 'Approved. The agent is created from the approved description.',
      rejected: 'Rejected. No agent is created.',
      not_pending: 'This request was already decided (dashboard or another channel) or has expired. This click changed nothing.',
      content_changed: 'The request changed since it was posted, so this click decided nothing. Check the dashboard.',
      expired: 'The request has expired, so this click did not approve it. Ask again.',
      used: 'You already decided on this message.',
      refused: 'This click decided nothing (the message is not the posted request, or it changed). Check the dashboard.',
    },
  },
} as const

export type TelegramPostOutcome = 'posted' | 'not_agent_create' | 'not_verifiable' | 'too_long' | 'send_failed' | 'record_failed'
  | 'switch_off' | 'no_explicit_owner' | 'no_token' | 'main_bot_token' | 'agent_bot_token'

interface SentMessage { message_id?: unknown; chat?: { id?: unknown }; from?: { id?: unknown }; text?: unknown; reply_markup?: unknown }

/** Posts an agent_create request with the approval bot. Never throws; the outcome says why it did not go out. */
export async function postAgentCreateToTelegramBot(approval: Approval, lang: ApprovalLang, deps: TelegramApprovalDeps): Promise<TelegramPostOutcome> {
  try {
    if (approval.category !== 'agent_create') return 'not_agent_create'
    const route = telegramApprovalRoute(deps)
    if (!route.ok) {
      reportSetupError(route, currentToken(deps), deps)
      return route.reason
    }
    const spec = verifiedAgentSpec(approval)
    if (!spec || !approval.content_hash) return 'not_verifiable'
    const t = T[lang]
    const text = `${renderAgentSpec(spec, approval.content_hash, lang)}\n\n${t.footer}`
    if (text.length > TELEGRAM_TEXT_LIMIT) {
      try { await deps.api(route.token, 'sendMessage', { chat_id: route.owner, text: t.tooLong(approval.id) }) } catch (err) {
        logger.warn({ approvalId: approval.id, err: errText(err) }, 'agent_create: the Telegram dashboard pointer failed')
      }
      logger.info({ approvalId: approval.id, length: text.length }, 'agent_create: too long for one Telegram message; a dashboard pointer, no post row')
      return 'too_long'
    }
    const me = await botId(route.token, deps)
    const approveNonce = randomBytes(16).toString('hex')
    const rejectNonce = randomBytes(16).toString('hex')
    let sent: SentMessage
    try {
      sent = await deps.api(route.token, 'sendMessage', {
        chat_id: route.owner, text,
        reply_markup: { inline_keyboard: [[{ text: t.approve, callback_data: `a:${approveNonce}` }, { text: t.reject, callback_data: `r:${rejectNonce}` }]] },
      }) as SentMessage
    } catch (err) {
      logger.warn({ approvalId: approval.id, err: errText(err) }, 'agent_create: the Telegram approval post failed (the dashboard decides)')
      return 'send_failed'
    }
    // What Telegram stored is what a later click is checked against: its message id, its chat, its author and its text.
    if (typeof sent?.message_id !== 'number' || String(sent.chat?.id) !== route.owner || String(sent.from?.id) !== me || typeof sent.text !== 'string'
      || !sent.reply_markup || typeof sent.reply_markup !== 'object') {
      logger.warn({ approvalId: approval.id }, 'agent_create: Telegram answered the approval post without a usable message; no post row (the dashboard decides)')
      return 'record_failed'
    }
    const recorded = recordApprovalTelegramPost({
      approvalId: approval.id, chatId: route.owner, messageId: sent.message_id, botId: me, ownerUserId: route.owner,
      textSha256: sha256(sent.text), contentHash: approval.content_hash, approveNonceSha256: sha256(approveNonce),
      rejectNonceSha256: sha256(rejectNonce), markupSha256: sha256(canonicalJsonValue(sent.reply_markup)), lang,
    })
    if (!recorded) return 'record_failed'
    logger.info({ approvalId: approval.id }, 'agent_create approval posted with the Telegram approval bot')
    return 'posted'
  } catch (err) {
    logger.error({ approvalId: approval.id, err: errText(err) }, 'agent_create: the Telegram approval post failed')
    return 'send_failed'
  }
}

// The bot's own id (getMe), cached per token hash: a click's message must have been sent by THIS bot.
const botIds = new Map<string, string>()
async function botId(token: string, deps: Pick<TelegramApprovalDeps, 'api'>): Promise<string> {
  const key = sha256(token)
  const cached = botIds.get(key)
  if (cached) return cached
  const me = await deps.api(token, 'getMe', {}) as { id?: unknown; is_bot?: unknown }
  if (typeof me?.id !== 'number' || me.is_bot !== true) throw new Error('getMe returned no bot id')
  const id = String(me.id)
  botIds.set(key, id)
  return id
}
export function _clearBotIdCacheForTest(): void { botIds.clear() }

interface CallbackQuery {
  id?: unknown
  from?: { id?: unknown; is_bot?: unknown }
  data?: unknown
  message?: { message_id?: unknown; date?: unknown; edit_date?: unknown; text?: unknown; reply_markup?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown } }
}
interface Update { update_id?: unknown; callback_query?: CallbackQuery }

export type TelegramUpdateOutcome =
  | 'no_callback' | 'not_owner' | 'not_private' | 'not_a_post' | 'not_our_message' | 'post_edited' | 'post_text_changed'
  | 'post_buttons_changed'
  | 'bad_data' | 'nonce_mismatch' | 'approved' | 'rejected' | `${'approved' | 'rejected'}:${string}` | 'post_already_used'

/** The decision rules for one update (see the header). Exported for the tests. */
export async function handleTelegramUpdate(u: Update, ctx: { token: string; owner: string; botId: string; deps: TelegramApprovalDeps }): Promise<TelegramUpdateOutcome> {
  const cq = u.callback_query
  if (!cq || typeof u.update_id !== 'number') return 'no_callback'
  const answer = (text?: string) => { void ctx.deps.api(ctx.token, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {}) }
  // A stranger's click gets no word back beyond stopping the spinner.
  if (cq.from?.is_bot !== false || String(cq.from?.id) !== ctx.owner) { answer(); return 'not_owner' }
  const m = cq.message
  if (!m || m.chat?.type !== 'private' || String(m.chat?.id) !== ctx.owner || typeof m.message_id !== 'number') { answer(); return 'not_private' }
  const post = getApprovalTelegramPostByMessage(ctx.botId, ctx.owner, m.message_id)
  if (!post || post.owner_user_id !== ctx.owner) { answer(); return 'not_a_post' }
  const t = T[post.lang === 'en' ? 'en' : 'hu']
  if (post.decided_at != null) { answer(t.result.used); return 'post_already_used' }
  if (String(m.from?.id) !== ctx.botId) { answer(t.result.refused); return 'not_our_message' }
  if (m.edit_date != null) { answer(t.result.refused); return 'post_edited' }
  if (typeof m.text !== 'string' || sha256(m.text) !== post.text_sha256) { answer(t.result.refused); return 'post_text_changed' }
  // Revizor 6111 R1: the buttons are bound too, so a button whose label and data were swapped never decides, whether
  // or not Telegram sets edit_date for a keyboard-only edit.
  if (!m.reply_markup || sha256(canonicalJsonValue(m.reply_markup)) !== post.markup_sha256) { answer(t.result.refused); return 'post_buttons_changed' }
  const match = typeof cq.data === 'string' ? /^([ar]):([0-9a-f]{32})$/.exec(cq.data) : null
  if (!match) { answer(t.result.refused); return 'bad_data' }
  const given = Buffer.from(sha256(match[2]), 'hex')
  const want = Buffer.from(match[1] === 'a' ? post.approve_nonce_sha256 : post.reject_nonce_sha256, 'hex')
  if (given.length !== want.length || !timingSafeEqual(given, want)) { answer(t.result.refused); return 'nonce_mismatch' }
  const status = match[1] === 'a' ? 'approved' as const : 'rejected' as const
  const d = decideApprovalFromTelegram({ approvalId: post.approval_id, status, updateId: u.update_id, ownerUserId: ctx.owner })
  const word = d.outcome === 'decided' ? t.result[status]
    : d.outcome === 'post_already_used' || d.outcome === 'update_already_used' ? t.result.used
    : t.result[d.outcome]
  answer(word)
  // The buttons go away and the outcome is said under the post (best effort: the decision already stands).
  void ctx.deps.api(ctx.token, 'editMessageReplyMarkup', { chat_id: ctx.owner, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
  void ctx.deps.api(ctx.token, 'sendMessage', { chat_id: ctx.owner, text: word, reply_parameters: { message_id: m.message_id } }).catch(() => {})
  logger.info({ approvalId: post.approval_id, status, outcome: d.outcome }, 'agent_create: Telegram approval bot click')
  if (d.outcome === 'decided') return status
  if (d.outcome === 'post_already_used' || d.outcome === 'update_already_used') return 'post_already_used'
  return `${status}:${d.outcome}`
}

export type TelegramTickResult = { updateId: number; outcome: TelegramUpdateOutcome }

/**
 * One poll of the approval bot: only while a post waits for the owner. Reads the updates after the stored offset,
 * decides each by the rules above, and moves the offset past each one as it is handled (an update is read once, a
 * restart included). A click that comes after its request was decided is refused when it arrives.
 */
export async function telegramApprovalTick(deps: TelegramApprovalDeps): Promise<TelegramTickResult[]> {
  const route = telegramApprovalRoute(deps)
  // a setup error is reported within one poll of the change (before the pending check), once per token
  if (!route.ok) { reportSetupError(route, currentToken(deps), deps); return [] }
  if (countPendingApprovalTelegramPosts() === 0) return []
  const me = await botId(route.token, deps)
  const offset = getApprovalTelegramOffset(me)
  const updates = await deps.api(route.token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['callback_query'] })
  if (!Array.isArray(updates)) return []
  const out: TelegramTickResult[] = []
  for (const u of updates as Update[]) {
    if (typeof u?.update_id !== 'number') continue
    let outcome: TelegramUpdateOutcome
    try { outcome = await handleTelegramUpdate(u, { token: route.token, owner: route.owner, botId: me, deps }) } catch (err) {
      logger.error({ updateId: u.update_id, err: errText(err) }, 'agent_create: a Telegram approval update failed; it is not read again')
      outcome = 'no_callback'
    }
    advanceApprovalTelegramOffset(me, u.update_id + 1)
    out.push({ updateId: u.update_id, outcome })
  }
  return out
}

function errText(err: unknown): string {
  // A fetch error can carry the URL, and the URL carries the token: never log it.
  return (err instanceof Error ? err.message : String(err)).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>')
}

/** The real Bot API call (fetch). The token is in the URL Telegram defines; the error text never repeats it. */
export const telegramBotApi: TelegramBotApi = async (token, method, params) => {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  })
  type BotApiReply = { ok?: boolean; result?: unknown; error_code?: number; description?: string }
  let data: BotApiReply | null = null
  try { data = await resp.json() as BotApiReply } catch { data = null }
  if (!resp.ok || data?.ok !== true) throw new Error(`Telegram API ${method} ${data?.error_code ?? resp.status}: ${String(data?.description ?? '').slice(0, 200)}`)
  return data.result
}

const TICK_MS = 10_000
let timer: ReturnType<typeof setTimeout> | null = null
/** Starts the poller (server start): one round every 10 s; idle while the switch is off or nothing waits. */
export function startTelegramApprovalPoller(deps: TelegramApprovalDeps): void {
  if (timer) return
  // at start: another bot's token is said right away, not at the first request
  try { const r = telegramApprovalRoute(deps); if (!r.ok) reportSetupError(r, currentToken(deps), deps) } catch { /* the poll reports it */ }
  const loop = () => {
    timer = setTimeout(async () => {
      try { await telegramApprovalTick(deps) } catch (err) { logger.warn({ err: errText(err) }, 'agent_create Telegram approval poll failed') }
      loop()
    }, TICK_MS)
    timer.unref?.()
  }
  loop()
}
export function stopTelegramApprovalPollerForTest(): void { if (timer) clearTimeout(timer); timer = null }
