/**
 * APPROVALSLACK1030 (2): the dashboard side of the Slack-reaction decision. Whether a request may take the reaction
 * path (reactionRoute), posting it (postReactionPrompt) and the sweeper that reads the owner's reaction and records the
 * decision (startApprovalSlackSweeper). The Slack side (one message, the checks) is src/approval-slack.ts; the letter
 * check is src/approval-envelope.ts.
 *
 * A request takes the reaction path only when ALL hold, otherwise its DM says the decision is on the dashboard:
 *   - APPROVAL_SLACK_REACTIONS is on (off by default; switching it on needs the owner's session);
 *   - SLACK_OWNER_USER_ID is set explicitly (the allowFrom fallback is the agent's own file: never an approver);
 *   - the request's content is what the server can stand behind: a request the server itself filed, or an email_send
 *     whose envelope recomputes to its content_hash (the DM then shows that envelope, Dani 65920 (4));
 *   - the text fits one Slack message (the hash must cover all of it).
 *
 * APPROVALSLACK1030 B (the owner's decision of 11-04, Samu 67693): with APPROVAL_SLACK_REPLIES on, the owner's typed
 * "mehet" / "nem" decides too (the rules: src/approval-slack.ts). That switch also lets a request whose content is only
 * the requesting agent's description take the Slack path: the owner accepted that risk (the PR's residual-risk list).
 * Never on the reply path: the standing categories (a decision there is permanent and its hash names an address the DM
 * does not show), data_delete, update_rebase (AUTOUPDATEDIVERG1110, Dani 74994: the owner approves it on the dashboard,
 * against the server's own plan, never on the requesting agent's description), and an email_send without a verifiable
 * envelope.
 */
import { recordApprovalSlackPost, pendingApprovalSlackPosts, markApprovalSlackPostChecked, decideApprovalFromSlack, setApprovalSlackNotice,
  STANDING_DECISION_CATEGORIES, type Approval } from '../db.js'
import { logger } from '../logger.js'
import { verifiedEnvelope, envelopeText } from '../approval-envelope.js'
import { postApprovalPrompt, sweepOnce, slackCaller, type SlackCall, type ApprovalSlackPost, type Verdict, type ApprovalLang } from '../approval-slack.js'
import { OWNER_TEXT, formatDecisionTime } from './approval-texts.js'
import { UPDATE_REBASE_CATEGORY } from '../update-rebase-plan.js'

/** Categories the typed reply never decides (see the header). */
export const REPLY_EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([...STANDING_DECISION_CATEGORIES, 'data_delete', UPDATE_REBASE_CATEGORY])

const USER_ID_RX = /^[UW][A-Z0-9]{6,}$/

export interface RouteDeps {
  setting: (key: string) => string
  /** The main bot's xoxb token, or null. */
  token: () => string | null
  /** The owner's Slack target (NOTIFY_SLACK_TARGET), '' when Slack is not the owner's channel. */
  ownerTarget: () => Promise<string>
  /** #2451: the confidentiality check of a raw owner DM id. */
  verdict: (channel: string, owner: string) => Promise<'ok' | 'foreign' | 'unknown'>
  /** #2451 (Dani 66036): a target changed around the route is told to the OLD target first. */
  drift: (current: string) => Promise<boolean>
  chunk: number
  /** APPROVALTAGEN1108: the install's approval-text language (approvalTextLang), read once per request by the caller. */
  lang?: () => ApprovalLang
}

export type ContentBasis = 'envelope' | 'server_filed' | 'description'
export interface Modes { reaction: boolean; reply: boolean }

export type Route =
  | { ok: true; ownerUserId: string; token: string; text: string; channel: string | null; modes: Modes; contentBasis: ContentBasis; lang: ApprovalLang }
  | { ok: false; reason: string }

export function reactionsOn(setting: RouteDeps['setting']): boolean {
  return String(setting('APPROVAL_SLACK_REACTIONS') ?? '').trim().toLowerCase() === 'on'
}

export function repliesOn(setting: RouteDeps['setting']): boolean {
  return String(setting('APPROVAL_SLACK_REPLIES') ?? '').trim().toLowerCase() === 'on'
}


/** The Slack DM's text: the content the owner decides on, then how to decide. */
export function reactionText(approval: Approval, content: string, expires: string, pageUrl: string, modes: Modes = { reaction: true, reply: false }, lang: ApprovalLang = 'hu'): string {
  const t = OWNER_TEXT[lang]
  return [
    `${t.requestTag} ${approval.agent_id} | ${approval.category}`,
    content,
    `${t.expires}: ${expires}`,
    t.decideLine[modes.reaction && modes.reply ? 'both' : modes.reply ? 'reply' : 'reaction'],
    t.orOnDashboard(pageUrl, approval.id),
  ].join('\n')
}

/** May [approval] take the reaction path, and with what text? */
export async function reactionRoute(approval: Approval, serverFiled: boolean, deps: RouteDeps, expires: string, pageUrl: string, lang: ApprovalLang = 'hu'): Promise<Route> {
  const reactions = reactionsOn(deps.setting)
  const replies = repliesOn(deps.setting)
  if (!reactions && !replies) return { ok: false, reason: 'switch_off' }
  const owner = String(deps.setting('SLACK_OWNER_USER_ID') ?? '').trim()
  if (!USER_ID_RX.test(owner)) return { ok: false, reason: 'no_explicit_owner' }
  const target = await deps.ownerTarget()
  if (!target) return { ok: false, reason: 'slack_not_owner_channel' }
  const token = deps.token()
  if (!token) return { ok: false, reason: 'no_slack_token' }
  await deps.drift(target)
  // A raw D id: posted to directly (no conversations.open), after the confidentiality check of #2451.
  const channel = /^D[A-Z0-9]{6,}$/.test(target) ? target : null
  if (channel && (await deps.verdict(channel, owner)) === 'foreign') return { ok: false, reason: 'dm_channel_foreign' }
  let content: string
  let contentBasis: ContentBasis
  if (serverFiled) {
    content = approval.action_description
    contentBasis = 'server_filed'
  } else {
    const env = verifiedEnvelope(approval)
    if (env && approval.content_hash) {
      content = envelopeText(env, approval.content_hash, lang)
      contentBasis = 'envelope'
    } else if (approval.category !== 'email_send') {
      content = approval.action_description
      contentBasis = 'description'
    } else {
      return { ok: false, reason: 'content_not_verifiable' }
    }
  }
  // The reaction keeps #2452's rule (only content the server stands behind); the typed reply takes the description too.
  const excluded = REPLY_EXCLUDED_CATEGORIES.has(approval.category)
  const modes: Modes = { reaction: reactions && contentBasis !== 'description', reply: replies && !excluded }
  if (!modes.reaction && !modes.reply) return { ok: false, reason: replies && excluded ? 'category_not_for_slack_reply' : 'content_not_verifiable' }
  const text = reactionText(approval, content, expires, pageUrl, modes, lang)
  if (text.length > deps.chunk) return { ok: false, reason: 'too_long_for_one_message' }
  return { ok: true, ownerUserId: owner, token, text, channel, modes, contentBasis, lang }
}

/** The line a normal DM carries while the switch is on but this request cannot take the reaction path. */
export function dashboardOnlyLine(reason: string, lang: ApprovalLang = 'hu'): string {
  return OWNER_TEXT[lang].dashboardOnly(reason)
}

/** Posts the reaction DM and records it; false when Slack refused (the caller then sends the normal DM). */
export async function postReactionPrompt(approval: Approval, route: Extract<Route, { ok: true }>, call: SlackCall = slackCaller(route.token)): Promise<boolean> {
  const r = await postApprovalPrompt(call, route.ownerUserId, route.text, route.channel)
  if (!r.ok) {
    logger.warn({ approvalId: approval.id, error: r.error }, 'approval reaction prompt NOT posted')
    return false
  }
  recordApprovalSlackPost({ approvalId: approval.id, ...r.post, contentBasis: route.contentBasis, reactionMode: route.modes.reaction, replyMode: route.modes.reply, lang: route.lang })
  logger.info({ approvalId: approval.id, channel: r.post.channel, modes: route.modes, contentBasis: route.contentBasis }, 'approval Slack prompt posted')
  return true
}

/** The Hungarian notice (kept as an export; a post in English gets OWNER_TEXT.en.editedNotice). */
export const OWNER_EDITED_NOTICE = OWNER_TEXT.hu.editedNotice

/** A post's language: the one it was made in (stored with it); absent = hu (every post from before it was stored). */
function postLang(post: ApprovalSlackPost): ApprovalLang {
  return post.lang === 'en' ? 'en' : 'hu'
}

/** What the DM thread says after a decision, in the post's language. Pure + exported for tests. */
export function decisionFeedback(v: Exclude<Verdict, { kind: 'none' } | { kind: 'notice' }>, changed: boolean, when: string, pageUrl: string, lang: ApprovalLang): string {
  const t = OWNER_TEXT[lang]
  if (v.kind === 'refused') return t.refusedFeedback(when, v.reason)
  if (!changed) return t.unchangedFeedback(when)
  if (v.via) return t.replyFeedback(t.result[v.kind], when, v.via.ts) + (v.kind === 'approved' && pageUrl ? t.notMeant(pageUrl) : '')
  return t.reactionFeedback(t.result[v.kind], when)
}

/**
 * Records ONE decision for [post], in one transaction (decideApprovalFromSlack): the row closes once, with the owner
 * message that decided; the request is resolved only while still pending (an approval only before its timeout). Then
 * the DM thread says what happened. A refused check is a rejection with an alert. A 'notice' decides nothing: the
 * thread gets the server's one notice (its ts is recorded, so the thread rule skips it).
 */
export async function decide(call: SlackCall, post: ApprovalSlackPost, v: Exclude<Verdict, { kind: 'none' }>, alert: (text: string) => void, pageUrl = ''): Promise<void> {
  if (v.kind === 'notice') {
    if (post.noticeTs) return
    try {
      const r = await call('chat.postMessage', { channel: post.channel, thread_ts: post.ts, text: OWNER_TEXT[postLang(post)].editedNotice })
      if (r.ok === true && typeof r.ts === 'string') { setApprovalSlackNotice(post.approvalId, r.ts); post.noticeTs = r.ts }
    } catch { /* the next round tries again */ }
    logger.info({ approvalId: post.approvalId, reason: v.reason }, 'approval Slack reply ignored: the owner edited it')
    return
  }
  const via = v.kind === 'refused' ? undefined : v.via
  const label = v.kind === 'refused' ? `refused:${v.reason}` : via ? `${v.kind}:reply` : v.kind
  const status = v.kind === 'approved' ? 'approved' : 'rejected'
  const refusedPrefix = post.replyMode === true ? 'slack_refused' : 'slack_reaction_refused'
  const by = v.kind === 'refused' ? `${refusedPrefix}:${v.reason}` : via ? `slack_reply:${v.userId}:${via.ts}` : `slack_reaction:${v.userId}`
  const res = decideApprovalFromSlack({ approvalId: post.approvalId, decision: label, status, resolvedBy: by, decidedByTs: via?.ts ?? null, binding: via?.binding ?? null })
  if (res.outcome === 'reply_already_used') {
    // One owner message decides one request; the same ts on a second request is an anomaly: close it as a rejection.
    logger.warn({ approvalId: post.approvalId, ts: via?.ts }, 'approval Slack reply REFUSED: that owner message already decided another request')
    alert(OWNER_TEXT[postLang(post)].alertReplyUsed(post.approvalId))
    decideApprovalFromSlack({ approvalId: post.approvalId, decision: 'refused:reply_already_used', status: 'rejected', resolvedBy: `${refusedPrefix}:reply_already_used` })
    return
  }
  if (res.outcome === 'already_decided') {
    logger.info({ approvalId: post.approvalId, verdict: label }, 'approval Slack signal after the decision: logged only')
    return
  }
  const reply = decisionFeedback(v, res.changed, formatDecisionTime(new Date(), postLang(post)), pageUrl, postLang(post))
  try { await call('chat.postMessage', { channel: post.channel, thread_ts: post.ts, text: reply }) } catch { /* the decision stands */ }
  if (v.kind === 'refused') {
    logger.warn({ approvalId: post.approvalId, reason: v.reason }, 'approval Slack decision REFUSED: rejected instead')
    alert(OWNER_TEXT[postLang(post)].alertRefused(v.reason, post.approvalId))
  } else {
    logger.info({ approvalId: post.approvalId, status, changed: res.changed, binding: via?.binding ?? 'reaction', replyTs: via?.ts }, 'approval decided by the owner in Slack')
  }
}

export const SWEEP_EVERY_MS = 15_000

/**
 * One sweeper round over the DB: the least recently checked pending posts, each checked one stamped, decisions awaited.
 * A post is asked only about the decisions it was offered AND whose switch is on now (a switch turned off stops its path
 * for posts already out); a post with neither is left alone.
 */
export async function sweepRound(call: SlackCall, alert: (t: string) => void, opts: { reactions: boolean; replies: boolean; pageUrl?: string } = { reactions: true, replies: false }):
Promise<{ checked: number; waitS: number }> {
  const posts: ApprovalSlackPost[] = pendingApprovalSlackPosts().map((r) => ({
    approvalId: r.approval_id, channel: r.channel, ts: r.ts, textSha256: r.text_sha256, ownerUserId: r.owner_user_id, botUserId: r.bot_user_id,
    reactionMode: opts.reactions && r.reaction_mode !== 0, replyMode: opts.replies && r.reply_mode === 1, noticeTs: r.notice_ts,
    lang: (r.lang === 'en' ? 'en' : 'hu') as ApprovalLang,
  })).filter((p) => p.reactionMode || p.replyMode)
  const decisions: Array<Promise<void>> = []
  const r = await sweepOnce(call, posts, (p, v) => { decisions.push(decide(call, p, v, alert, opts.pageUrl ?? '')) }, (p) => markApprovalSlackPostChecked(p.approvalId))
  await Promise.all(decisions)
  return r
}

/** The sweeper: every SWEEP_EVERY_MS, while either switch is on, one bounded round; a 429 pauses it for its Retry-After. */
export function startApprovalSlackSweeper(deps: { setting: RouteDeps['setting']; token: RouteDeps['token']; alert: (t: string) => void; call?: (token: string) => SlackCall; pageUrl?: string }): NodeJS.Timeout {
  let running = false
  let pausedUntil = 0
  return setInterval(() => {
    const reactions = reactionsOn(deps.setting)
    const replies = repliesOn(deps.setting)
    if (running || Date.now() < pausedUntil || (!reactions && !replies)) return
    const token = deps.token()
    if (!token) return
    running = true
    void (async () => {
      try {
        const r = await sweepRound((deps.call ?? slackCaller)(token), deps.alert, { reactions, replies, pageUrl: deps.pageUrl })
        if (r.waitS > 0) pausedUntil = Date.now() + r.waitS * 1000
      } catch (err) {
        logger.warn({ err }, 'approval Slack sweep failed')
      } finally {
        running = false
      }
    })()
  }, SWEEP_EVERY_MS)
}
