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
  return { ok: true, post: { channel, ts: r.ts, textSha256: sha256(posted), ownerUserId, botUserId } }
}

export type Verdict =
  | { kind: 'none' }
  | { kind: 'approved' | 'rejected'; userId: string }
  | { kind: 'refused'; reason: string }

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
export async function checkPost(call: SlackCall, post: ApprovalSlackPost): Promise<Verdict> {
  const h = await call('conversations.history', { channel: post.channel, latest: post.ts, oldest: post.ts, inclusive: true, limit: 1 })
  if (h.ok !== true) return { kind: 'none' }
  const m = (h.messages as Array<Record<string, unknown>> | undefined)?.[0]
  if (!m || m.ts !== post.ts) return { kind: 'refused', reason: 'message_missing' }
  const reactors = reactorsOf(m)
  const yes = (reactors.get(APPROVE_REACTION) ?? []).includes(post.ownerUserId)
  const no = (reactors.get(REJECT_REACTION) ?? []).includes(post.ownerUserId)
  if (!yes && !no) return { kind: 'none' }
  if (yes && no) return { kind: 'refused', reason: 'both_reactions' }
  if (m.edited !== undefined) return { kind: 'refused', reason: 'message_edited' }
  if (m.user !== post.botUserId) return { kind: 'refused', reason: 'message_sender' }
  if (typeof m.text !== 'string' || sha256(m.text) !== post.textSha256) return { kind: 'refused', reason: 'message_changed' }
  const info = await call('users.info', { user: post.ownerUserId })
  const user = info.user as { id?: unknown; is_bot?: unknown; is_app_user?: unknown; deleted?: unknown } | undefined
  if (info.ok !== true || !user || user.id !== post.ownerUserId) return { kind: 'refused', reason: 'owner_unknown' }
  if (user.is_bot === true || user.is_app_user === true || user.deleted === true) return { kind: 'refused', reason: 'owner_not_human' }
  return { kind: yes ? 'approved' : 'rejected', userId: post.ownerUserId }
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
