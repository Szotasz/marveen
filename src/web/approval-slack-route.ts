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
 */
import { resolveApproval, recordApprovalSlackPost, pendingApprovalSlackPosts, markApprovalSlackPostDecided, markApprovalSlackPostChecked, type Approval } from '../db.js'
import { logger } from '../logger.js'
import { verifiedEnvelope, envelopeText } from '../approval-envelope.js'
import { postApprovalPrompt, sweepOnce, slackCaller, type SlackCall, type ApprovalSlackPost, type Verdict } from '../approval-slack.js'

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
}

export type Route = { ok: true; ownerUserId: string; token: string; text: string; channel: string | null } | { ok: false; reason: string }

export function reactionsOn(setting: RouteDeps['setting']): boolean {
  return String(setting('APPROVAL_SLACK_REACTIONS') ?? '').trim().toLowerCase() === 'on'
}

/** The reaction DM's text: the content the owner decides on, then how to decide. */
export function reactionText(approval: Approval, content: string, expires: string, pageUrl: string): string {
  return [
    `[JÓVÁHAGYÁS KELL] ${approval.agent_id} | ${approval.category}`,
    content,
    `Lejárat: ${expires}`,
    'Döntés: reagálj erre az üzenetre ✅ (jóváhagyás) vagy ❌ (elutasítás) reakcióval. Csak a te reakciód számít, és csak amíg ez az üzenet változatlan.',
    `Vagy a dashboardon: ${pageUrl} (id: ${approval.id})`,
  ].join('\n')
}

/** May [approval] take the reaction path, and with what text? */
export async function reactionRoute(approval: Approval, serverFiled: boolean, deps: RouteDeps, expires: string, pageUrl: string): Promise<Route> {
  if (!reactionsOn(deps.setting)) return { ok: false, reason: 'switch_off' }
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
  if (serverFiled) {
    content = approval.action_description
  } else {
    const env = verifiedEnvelope(approval)
    if (!env || !approval.content_hash) return { ok: false, reason: 'content_not_verifiable' }
    content = envelopeText(env, approval.content_hash)
  }
  const text = reactionText(approval, content, expires, pageUrl)
  if (text.length > deps.chunk) return { ok: false, reason: 'too_long_for_one_message' }
  return { ok: true, ownerUserId: owner, token, text, channel }
}

/** The line a normal DM carries while the switch is on but this request cannot take the reaction path. */
export function dashboardOnlyLine(reason: string): string {
  return `Erre a kérésre a reakciós jóváhagyás nem érhető el (${reason}); a döntés a dashboardon.`
}

/** Posts the reaction DM and records it; false when Slack refused (the caller then sends the normal DM). */
export async function postReactionPrompt(approval: Approval, route: Extract<Route, { ok: true }>, call: SlackCall = slackCaller(route.token)): Promise<boolean> {
  const r = await postApprovalPrompt(call, route.ownerUserId, route.text, route.channel)
  if (!r.ok) {
    logger.warn({ approvalId: approval.id, error: r.error }, 'approval reaction prompt NOT posted')
    return false
  }
  recordApprovalSlackPost({ approvalId: approval.id, ...r.post })
  logger.info({ approvalId: approval.id, channel: r.post.channel }, 'approval reaction prompt posted')
  return true
}

const RESULT_TEXT: Record<'approved' | 'rejected', string> = { approved: 'Jóváhagyva', rejected: 'Elutasítva' }

/**
 * Records ONE decision for [post]: the row closes first (a later reaction change finds it closed and only logs), then
 * the approval is resolved and the DM thread says what happened. A refused check is a rejection with an alert.
 */
export async function decide(call: SlackCall, post: ApprovalSlackPost, v: Exclude<Verdict, { kind: 'none' }>, alert: (text: string) => void): Promise<void> {
  const label = v.kind === 'refused' ? `refused:${v.reason}` : v.kind
  if (!markApprovalSlackPostDecided(post.approvalId, label)) {
    logger.info({ approvalId: post.approvalId, verdict: label }, 'approval reaction after the decision: logged only')
    return
  }
  const status = v.kind === 'approved' ? 'approved' : 'rejected'
  const by = v.kind === 'refused' ? `slack_reaction_refused:${v.reason}` : `slack_reaction:${v.userId}`
  const changed = resolveApproval(post.approvalId, status, by)
  const when = new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  const reply = v.kind === 'refused'
    ? `Elutasítva (${when}): a reakció nem fogadható el (${v.reason}). Ha jóvá akartad hagyni, kérd újra.`
    : `${RESULT_TEXT[v.kind]} (${when}, Slack-reakció).`
  try { await call('chat.postMessage', { channel: post.channel, thread_ts: post.ts, text: reply }) } catch { /* the decision stands */ }
  if (v.kind === 'refused') {
    logger.warn({ approvalId: post.approvalId, reason: v.reason }, 'approval reaction REFUSED: rejected instead')
    alert(`[FIGYELEM] Egy Slack-reakciós jóváhagyás nem volt elfogadható (${v.reason}), a kérés elutasítva (id: ${post.approvalId}).`)
  } else {
    logger.info({ approvalId: post.approvalId, status, changed }, 'approval decided by the owner\'s Slack reaction')
  }
}

export const SWEEP_EVERY_MS = 15_000

/** One sweeper round over the DB: the least recently checked pending posts, each checked one stamped, decisions awaited. */
export async function sweepRound(call: SlackCall, alert: (t: string) => void): Promise<{ checked: number; waitS: number }> {
  const posts: ApprovalSlackPost[] = pendingApprovalSlackPosts().map((r) => ({
    approvalId: r.approval_id, channel: r.channel, ts: r.ts, textSha256: r.text_sha256, ownerUserId: r.owner_user_id, botUserId: r.bot_user_id,
  }))
  const decisions: Array<Promise<void>> = []
  const r = await sweepOnce(call, posts, (p, v) => { decisions.push(decide(call, p, v, alert)) }, (p) => markApprovalSlackPostChecked(p.approvalId))
  await Promise.all(decisions)
  return r
}

/** The sweeper: every SWEEP_EVERY_MS, while the switch is on, one bounded round; a 429 pauses it for its Retry-After. */
export function startApprovalSlackSweeper(deps: { setting: RouteDeps['setting']; token: RouteDeps['token']; alert: (t: string) => void; call?: (token: string) => SlackCall }): NodeJS.Timeout {
  let running = false
  let pausedUntil = 0
  return setInterval(() => {
    if (running || Date.now() < pausedUntil || !reactionsOn(deps.setting)) return
    const token = deps.token()
    if (!token) return
    running = true
    void (async () => {
      try {
        const r = await sweepRound((deps.call ?? slackCaller)(token), deps.alert)
        if (r.waitS > 0) pausedUntil = Date.now() + r.waitS * 1000
      } catch (err) {
        logger.warn({ err }, 'approval Slack sweep failed')
      } finally {
        running = false
      }
    })()
  }, SWEEP_EVERY_MS)
}
