/**
 * The owner's Slack reaction as an approval decision (APPROVALSLACK1030 (2), the owner's decision of 10-30, Samu
 * 65935: variant B). The request goes to the owner's DM as ONE message; the dashboard server itself asks Slack who
 * reacted to exactly that message (conversations.history), and only the owner's ✅ (white_check_mark) or ❌ (x) counts.
 *
 * Why it holds against an agent (Dani 65925, in one sentence): the gate in front of the owner id is a text brake, so an
 * agent could quietly rewrite the id and approve with a Slack account it controls without the owner seeing anything;
 * hence the id is snapshotted per request, every change of it is announced to the OLD id, and the reactor must be a
 * human account. A reaction is attributed by Slack to whoever added it, and a bot token cannot add the owner's.
 *
 * What is checked at decision time, all required: the snapshot owner id reacted; that account is not a bot, not an app
 * user, not deleted; the message is still the one the server posted (same ts, sender = our bot, never edited, the text
 * sha256 unchanged). A ✅ and a ❌ together, or any mismatch, is a REJECTION with an alert, never an approval.
 *
 * APPROVALSLACK1030 B (the owner's decision of 11-04, Samu 67693): the owner's TYPED reply decides as well, read by the
 * server the same way; no agent is in the chain. For the owner nothing changes: the request arrives, they write "mehet".
 * Which request a reply belongs to, without an id or a button:
 *   - a reply in the request's THREAD belongs to it, if no message from anyone but the owner (the server's own notice
 *     aside) stands in the thread before the owner's last message;
 *   - a reply outside a thread belongs to the request only if it is the FIRST message after it in the DM (the owner's
 *     run of messages right after the request); any message by anyone else in between, and there is no binding.
 * So a "mehet" given to another question is never an approval (egm-design B1). The owner's LAST message of that place
 * decides, and only 30 s after it was written ("mehet", then "nem, várj" is not an approval). The words, after NFC and
 * whitespace folding, with only a trailing "." or "!" dropped: mehet / jóváhagyom approve, nem / elutasítom reject;
 * anything else ("mehet?", "igen", formatting) decides nothing. An edited owner message decides nothing (a notice asks
 * for a new one).
 */
import { createHash } from 'node:crypto'

/** One Slack Web API call; resolves to Slack's JSON body. A 429 throws SlackRateLimited. */
export type SlackCall = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>

export class SlackRateLimited extends Error {
  constructor(public retryAfterS: number) { super(`slack rate limited, retry after ${retryAfterS}s`) }
}

/** The posted request as the server recorded it (approval_slack_posts). */
export interface ApprovalSlackPost {
  approvalId: string
  channel: string
  ts: string
  textSha256: string
  ownerUserId: string
  botUserId: string
  /** Offered decisions (a row from before B was a reaction post). */
  reactionMode?: boolean
  replyMode?: boolean
  /** The server's own thread notice (asked for a new message after an edit), skipped by the thread rule. */
  noticeTs?: string | null
  /** The language the post was made in (APPROVALTAGEN1108); absent = hu, as every post from before it was stored. */
  lang?: ApprovalLang
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const USER_ID_RX = /^[UW][A-Z0-9]{6,}$/
export const APPROVE_REACTION = 'white_check_mark'
export const REJECT_REACTION = 'x'

/** Slack's escape for text it must show as written: the stored message text is this form. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Posts the request as ONE message into the owner's DM with the main bot and records what was posted. The text is
 * escaped (no link or mention can come out of an agent's text) and its sha256 is taken over that exact posted form.
 */
export async function postApprovalPrompt(call: SlackCall, ownerUserId: string, text: string, directChannel: string | null = null):
Promise<{ ok: true; post: Omit<ApprovalSlackPost, 'approvalId'> } | { ok: false; error: string }> {
  if (!USER_ID_RX.test(ownerUserId)) return { ok: false, error: 'bad_owner_id' }
  const auth = await call('auth.test', {})
  const botUserId = typeof auth.user_id === 'string' ? auth.user_id : ''
  if (auth.ok !== true || !botUserId) return { ok: false, error: `auth_test:${String(auth.error ?? 'no_user')}` }
  // A raw owner DM id is posted to directly: the bot has no im:write, so conversations.open fails (Marveen 66022, #2451).
  let channel: string
  if (directChannel) {
    channel = directChannel
  } else {
    const opened = await call('conversations.open', { users: ownerUserId })
    const id = (opened.channel as { id?: unknown } | undefined)?.id
    if (opened.ok !== true || typeof id !== 'string') return { ok: false, error: `dm_open:${String(opened.error ?? 'no_channel')}` }
    channel = id
  }
  const posted = slackEscape(text)
  const r = await call('chat.postMessage', { channel, text: posted, unfurl_links: false, unfurl_media: false })
  if (r.ok !== true || typeof r.ts !== 'string') return { ok: false, error: `post:${String(r.error ?? 'no_ts')}` }
  // Slack stores its own form (a bare URL becomes <url>), and checkPost compares against the stored text: hash that.
  const stored = (r.message as { text?: unknown } | undefined)?.text
  return { ok: true, post: { channel, ts: r.ts, textSha256: sha256(typeof stored === 'string' ? stored : posted), ownerUserId, botUserId } }
}

export type Binding = 'thread' | 'next_message'

export type Verdict =
  | { kind: 'none'; pending?: true }
  | { kind: 'approved' | 'rejected'; userId: string; via?: { binding: Binding; ts: string } }
  | { kind: 'refused'; reason: string }
  | { kind: 'notice'; reason: 'owner_edited' }

export const APPROVE_WORDS: ReadonlySet<string> = new Set(['mehet', 'jóváhagyom'])
export const REJECT_WORDS: ReadonlySet<string> = new Set(['nem', 'elutasítom'])
/**
 * APPROVALTAGEN1108 (Samu 73344, the narrowest consent change): a post made in English accepts these IN ADDITION to the
 * Hungarian words (backward compatible); a Hungarian post (and every post from before the language was stored) accepts
 * exactly the Hungarian set, as before. "yes" and "ok" decide nothing, as "igen" does not.
 */
export const APPROVE_WORDS_EN: ReadonlySet<string> = new Set(['approve', 'go'])
export const REJECT_WORDS_EN: ReadonlySet<string> = new Set(['reject', 'no'])
/** The language a post was made in (stored with it): the words its owner was told decide. */
export type ApprovalLang = 'hu' | 'en'
/** A typed decision counts only this long after it was written, and only if it is still the owner's last word there. */
export const REPLY_SETTLE_S = 30

/**
 * The decision a typed reply carries, or null: NFC, whitespace folded, only a trailing "." / "!" dropped. [lang] is the
 * POST's language (never the install's current one: a switch must not change the rules of a pending request).
 */
export function replyWord(text: unknown, lang: ApprovalLang): 'approved' | 'rejected' | null {
  if (typeof text !== 'string') return null
  const t = text.normalize('NFC').replace(/\s+/gu, ' ').trim().replace(/[.!]+$/u, '').trim().toLocaleLowerCase('hu-HU')
  if (APPROVE_WORDS.has(t) || (lang === 'en' && APPROVE_WORDS_EN.has(t))) return 'approved'
  if (REJECT_WORDS.has(t) || (lang === 'en' && REJECT_WORDS_EN.has(t))) return 'rejected'
  return null
}

/** Slack ts order ("1700000000.000100"), numerically, never as strings of different length. */
export function tsCompare(a: string, b: string): number {
  const [as, au = '0'] = a.split('.'); const [bs, bu = '0'] = b.split('.')
  const d = Number(as) - Number(bs)
  return d !== 0 ? Math.sign(d) : Math.sign(Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0')))
}

type Msg = Record<string, unknown>

/** A plain message the owner typed: their user id, no subtype, no bot or app behind it. */
function byOwner(m: Msg, owner: string): boolean {
  return m.user === owner && m.subtype === undefined && m.bot_id === undefined && m.app_id === undefined
}

/** What the owner's deciding message [d] gives now. */
function fromDeciding(d: Msg, post: ApprovalSlackPost, binding: Binding, nowS: number): Verdict {
  if (d.edited !== undefined) return { kind: 'notice', reason: 'owner_edited' }
  const word = replyWord(d.text, post.lang === 'en' ? 'en' : 'hu')
  if (!word || typeof d.ts !== 'string') return { kind: 'none' }
  // a decision word still inside its settle time: nothing decides yet, a reaction neither (see checkPost)
  if (Number(d.ts) > nowS - REPLY_SETTLE_S) return { kind: 'none', pending: true }
  return { kind: word, userId: post.ownerUserId, via: { binding, ts: d.ts } }
}

/**
 * The owner's typed reply to [post] ([parent] is the request message as just read), or 'none'. The thread first: if the
 * owner wrote there at all, the thread decides (or nothing does); otherwise the owner's run right after the request.
 */
async function replySignal(call: SlackCall, post: ApprovalSlackPost, parent: Msg, nowS: number): Promise<Verdict> {
  if (Number(parent.reply_count ?? 0) > 0) {
    const r = await call('conversations.replies', { channel: post.channel, ts: post.ts, limit: 200 })
    if (r.ok === true && r.has_more !== true) {
      const thread = ((r.messages as Msg[] | undefined) ?? [])
        .filter((m) => typeof m.ts === 'string' && tsCompare(m.ts, post.ts) > 0 && m.ts !== post.noticeTs)
        .sort((a, b) => tsCompare(String(a.ts), String(b.ts)))
      const owners = thread.filter((m) => byOwner(m, post.ownerUserId))
      if (owners.length > 0) {
        const last = owners[owners.length - 1]
        const interjected = thread.some((m) => !byOwner(m, post.ownerUserId) && tsCompare(String(m.ts), String(last.ts)) < 0)
        return interjected ? { kind: 'none' } : fromDeciding(last, post, 'thread', nowS)
      }
    }
  }
  const h = await call('conversations.history', { channel: post.channel, oldest: post.ts, inclusive: false, limit: 100 })
  if (h.ok !== true || h.has_more === true) return { kind: 'none' }
  const after = ((h.messages as Msg[] | undefined) ?? [])
    .filter((m) => typeof m.ts === 'string' && tsCompare(m.ts, post.ts) > 0)
    .sort((a, b) => tsCompare(String(a.ts), String(b.ts)))
  let run = 0
  while (run < after.length && byOwner(after[run], post.ownerUserId)) run++
  if (run === 0) return { kind: 'none' }
  return fromDeciding(after[run - 1], post, 'next_message', nowS)
}

/** Who reacted with what, from the message object itself (its `reactions`: name and users). */
function reactorsOf(m: Record<string, unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const x of (m.reactions as Array<{ name?: unknown; users?: unknown }> | undefined) ?? []) {
    if (typeof x.name === 'string' && Array.isArray(x.users)) out.set(x.name, x.users.filter((u): u is string => typeof u === 'string'))
  }
  return out
}

/**
 * The decision the owner's reaction on [post] gives now, after every check; 'none' while the owner has not reacted.
 * ONE conversations.history read gives the message and its reactions from the same moment, with the scope the app
 * already asks for (im:history); reactions.get would need reactions:read, which the install's scope list does not
 * name (install-macos.sh, channel-provider.ts).
 */
export async function checkPost(call: SlackCall, post: ApprovalSlackPost, nowS: number = Date.now() / 1000): Promise<Verdict> {
  const h = await call('conversations.history', { channel: post.channel, latest: post.ts, oldest: post.ts, inclusive: true, limit: 1 })
  if (h.ok !== true) return { kind: 'none' }
  const m = (h.messages as Array<Record<string, unknown>> | undefined)?.[0]
  if (!m || m.ts !== post.ts) return { kind: 'refused', reason: 'message_missing' }
  let reaction: Verdict = { kind: 'none' }
  if (post.reactionMode !== false) {
    const reactors = reactorsOf(m)
    const yes = (reactors.get(APPROVE_REACTION) ?? []).includes(post.ownerUserId)
    const no = (reactors.get(REJECT_REACTION) ?? []).includes(post.ownerUserId)
    if (yes && no) return { kind: 'refused', reason: 'both_reactions' }
    if (yes || no) reaction = { kind: yes ? 'approved' : 'rejected', userId: post.ownerUserId }
  }
  // Dani 67810 (#2489 review): a post offered BOTH reads both, so a later typed "nem" is never overridden by a reaction.
  // They disagree: a refusal (rejection + alert), as two reactions do. They agree: the reply decides (it names the
  // owner message). A reply word still settling, or an edited reply, holds the reaction back too.
  const reply: Verdict = post.replyMode === true ? await replySignal(call, post, m, nowS) : { kind: 'none' }
  let v: Verdict
  if (reply.kind === 'approved' || reply.kind === 'rejected') {
    if ((reaction.kind === 'approved' || reaction.kind === 'rejected') && reaction.kind !== reply.kind) return { kind: 'refused', reason: 'reaction_reply_conflict' }
    v = reply
  } else if (reply.kind === 'notice' || (reply.kind === 'none' && reply.pending)) {
    return reply
  } else {
    v = reaction
  }
  if (v.kind !== 'approved' && v.kind !== 'rejected') return v
  // The request message must still be the one the server posted, whichever signal decided.
  if (m.edited !== undefined) return { kind: 'refused', reason: 'message_edited' }
  if (m.user !== post.botUserId) return { kind: 'refused', reason: 'message_sender' }
  if (typeof m.text !== 'string' || sha256(m.text) !== post.textSha256) return { kind: 'refused', reason: 'message_changed' }
  const info = await call('users.info', { user: post.ownerUserId })
  const user = info.user as { id?: unknown; is_bot?: unknown; is_app_user?: unknown; deleted?: unknown } | undefined
  if (info.ok !== true || !user || user.id !== post.ownerUserId) return { kind: 'refused', reason: 'owner_unknown' }
  if (user.is_bot === true || user.is_app_user === true || user.deleted === true) return { kind: 'refused', reason: 'owner_not_human' }
  return v
}

/** How many pending requests one sweep asks about at most (Dani 65920 (6)); the rest wait for the next round. */
export const SWEEP_MAX_PER_ROUND = 5

/**
 * One sweep: up to SWEEP_MAX_PER_ROUND posts, in the order given (the DB hands them least recently checked first). A
 * rate limit stops the round and returns how long to wait (Retry-After); that post is NOT marked, so it heads the next
 * round. Any other error on one post skips just that post, and it IS marked, so a post that keeps failing cannot hold a
 * slot of every round.
 */
export async function sweepOnce(call: SlackCall, posts: ApprovalSlackPost[], decide: (post: ApprovalSlackPost, v: Exclude<Verdict, { kind: 'none' }>) => void,
  markChecked: (post: ApprovalSlackPost) => void = () => {}): Promise<{ checked: number; waitS: number }> {
  let checked = 0
  for (const post of posts.slice(0, SWEEP_MAX_PER_ROUND)) {
    try {
      const v = await checkPost(call, post)
      checked++
      markChecked(post)
      if (v.kind !== 'none') decide(post, v)
    } catch (err) {
      if (err instanceof SlackRateLimited) return { checked, waitS: Math.max(1, err.retryAfterS) }
      markChecked(post)
    }
  }
  return { checked, waitS: 0 }
}

/** The Slack Web API over fetch with a bot token; a 429 throws SlackRateLimited with its Retry-After. */
export function slackCaller(token: string, f: typeof fetch = fetch): SlackCall {
  return async (method, body) => {
    const resp = await f(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (resp.status === 429) throw new SlackRateLimited(Number(resp.headers.get('retry-after') ?? '30') || 30)
    if (!resp.ok) return { ok: false, error: `http_${resp.status}` }
    return (await resp.json()) as Record<string, unknown>
  }
}
