/**
 * TEAMSAPPROVECARD1118: an email_send approval decided with a button on a Teams Adaptive Card in the owner's 1:1 chat
 * with the bot. The customer's seven conditions, and where each one is held:
 *
 *   1. The agent is not in the way: the SERVER posts the card (postApprovalCard, through sendTeamsMessage) and the
 *      SERVER decides the click (handleTeamsCardAction). The Teams plugin only forwards the click's invoke to
 *      POST /api/approvals/teams-card-action and returns the card the server answers with; it never hands the click to
 *      the agent session (claude-channel-teams, the reserved verb APPROVAL_CARD_VERB).
 *   2. Only a Bot Framework channel token counts (bot-channel-token.ts: RS256, iss api.botframework.com, aud = the bot,
 *      serviceurl = the activity, key endorsed for msteams); the tenant of the conversation AND of the channel data is
 *      the bot's tenant; from.aadObjectId is the owner.
 *   3. No secret between the plugin and the dashboard: the dashboard checks that token itself (Samu's decision D1). The
 *      route takes no dashboard token; the shared token alone gets a 401.
 *   4. The click is bound to the card the server posted (conversation id + replyToId = the card's activity id), to a
 *      one-time nonce only the card carries (its sha256 is stored), to the request's content_hash, and decides only a
 *      pending, unexpired request, once (decideApprovalFromTeams, one transaction). The 30-minute send window after the
 *      approval is unchanged (APPROVAL_WINDOW_S, consumeApproval).
 *   5. The card is rendered here from the stored, verified envelope (verifiedEnvelope: the envelope recomputes to the
 *      content_hash). The requesting agent's own description is NOT on the card (Samu's decision D5).
 *   6. Audit: approvals.resolved_by = 'teams_card'; the card row keeps the click's activity id and the owner's object id.
 *   7. The click is answered with the updated card (Approved / Rejected / Expired / Already resolved / Not accepted),
 *      which Teams shows in place of the old one.
 *
 * Switches: APPROVAL_TEAMS_CARDS (off by default; switching it on needs the owner's session) and the explicit
 * TEAMS_OWNER_AAD_OBJECT_ID (owner's session for any change). The plugin allowlist's single entry is an alert target
 * only, never the approver (Samu's decision D2). A click that fails a check resolves nothing: the owner gets an alert
 * and the clicker a "Not accepted" card (Samu's decision D6).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { recordApprovalTeamsCard, getApprovalTeamsCard, decideApprovalFromTeams, type Approval } from '../db.js'
import { logger } from '../logger.js'
import { verifiedEnvelope, type MailEnvelope } from '../approval-envelope.js'
import { createChannelTokenVerifier, type ChannelTokenVerifier } from '../bot-channel-token.js'
import { resolveTeamsTarget, type TeamsCreds, type sendTeamsMessage } from '../teams-send.js'
import { formatDecisionTime, type ApprovalLang } from './approval-texts.js'

export const APPROVAL_CARD_VERB = 'marveen-approval'
export const CARD_TEXT_PREVIEW = 1500
const AAD_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NONCE_RX = /^[0-9a-f]{64}$/

export interface TeamsCardDeps {
  setting: (key: string) => string
  /** The main agent's Teams bot credentials (readTeamsCreds), or null when the install has none. */
  creds: () => TeamsCreds | null
  stateDir: () => string
  send: typeof sendTeamsMessage
  /** The owner's 1:1 conversation (resolveTeamsTarget unless replaced in a test). */
  resolveTarget?: typeof resolveTeamsTarget
  /** One alert line to the owner (a refused click, a changed request). */
  alert: (text: string) => void
  verifier?: (appId: string) => ChannelTokenVerifier
  now?: () => Date
}

export function teamsCardsOn(setting: TeamsCardDeps['setting']): boolean {
  return String(setting('APPROVAL_TEAMS_CARDS') ?? '').trim().toLowerCase() === 'on'
}

export function teamsCardOwner(setting: TeamsCardDeps['setting']): string | null {
  const v = String(setting('TEAMS_OWNER_AAD_OBJECT_ID') ?? '').trim().toLowerCase()
  return AAD_RX.test(v) ? v : null
}

export type CardRoute =
  | { ok: true; owner: string; creds: TeamsCreds; envelope: MailEnvelope; contentHash: string }
  | { ok: false; reason: string }

/** May [approval] go out as a Teams card? Only an email_send whose envelope the server can verify. */
export function teamsCardRoute(approval: Approval, deps: Pick<TeamsCardDeps, 'setting' | 'creds'>): CardRoute {
  if (!teamsCardsOn(deps.setting)) return { ok: false, reason: 'switch_off' }
  const owner = teamsCardOwner(deps.setting)
  if (!owner) return { ok: false, reason: 'no_explicit_owner' }
  if (approval.category !== 'email_send') return { ok: false, reason: 'not_email_send' }
  const envelope = verifiedEnvelope(approval)
  if (!envelope || !approval.content_hash) return { ok: false, reason: 'content_not_verifiable' }
  const creds = deps.creds()
  if (!creds || !creds.appId || !creds.secret || !creds.tenant) return { ok: false, reason: 'no_teams_credentials' }
  return { ok: true, owner, creds, envelope, contentHash: approval.content_hash }
}

const T = {
  hu: {
    title: 'Jóváhagyás kell: levélküldés',
    agent: 'Kérő ügynök', to: 'Címzett', cc: 'Másolat', bcc: 'Titkos másolat', account: 'Fiók', replyTo: 'Válasz erre', render: 'Megjelenítés', format: 'Formátum',
    attachment: 'Csatolmány', expires: 'Lejár', text: 'A levél szövege', anchor: 'Horgony (sha256)', none: '(nincs)',
    more: (n: number) => `(+${n} karakter: a teljes szöveg a dashboardon)`,
    approve: 'Jóváhagyom', reject: 'Elutasítom',
    fallback: (id: string) => `Jóváhagyás kell: levélküldés (${id}). Ha a kártya nem látszik, a dashboardon dönts.`,
    result: {
      approved: (w: string) => `Jóváhagyva (${w}). A levél 30 percen belül mehet ki.`,
      rejected: (w: string) => `Elutasítva (${w}).`,
      expired: 'Lejárt: erre a kérésre már nem lehet dönteni.',
      already: 'Erről a kérésről már döntöttek.',
      changed: 'A kérés tartalma a kártya óta megváltozott: itt nem dönthető el, nézd meg a dashboardon.',
      notAccepted: 'Ez a kattintás nem fogadható el; a kérésen nem változtatott. A dashboardon dönthetsz.',
      unavailable: 'Itt most nem dönthető el; a dashboardon dönthetsz.',
    },
    alertRefused: (reason: string, id: string) => `[approval] Egy Teams-kártyás kattintást nem fogadtam el (${reason}); a kérés (${id}) változatlan.`,
    alertChanged: (id: string) => `[approval] A kérés (${id}) tartalma a Teams-kártya óta megváltozott; a kattintás nem döntött.`,
  },
  en: {
    title: 'Approval needed: sending an email',
    agent: 'Requesting agent', to: 'To', cc: 'Cc', bcc: 'Bcc', account: 'Account', replyTo: 'Reply to', render: 'Rendering', format: 'Format',
    attachment: 'Attachment', expires: 'Expires', text: 'The email text', anchor: 'Anchor (sha256)', none: '(none)',
    more: (n: number) => `(+${n} characters: the full text is on the dashboard)`,
    approve: 'Approve', reject: 'Reject',
    fallback: (id: string) => `Approval needed: sending an email (${id}). If the card does not show, decide on the dashboard.`,
    result: {
      approved: (w: string) => `Approved (${w}). The email may go out within 30 minutes.`,
      rejected: (w: string) => `Rejected (${w}).`,
      expired: 'Expired: this request can no longer be decided.',
      already: 'This request has already been decided.',
      changed: 'The request changed after the card was sent: it cannot be decided here, see the dashboard.',
      notAccepted: 'This click could not be accepted; the request is unchanged. You can decide on the dashboard.',
      unavailable: 'This cannot be decided here right now; you can decide on the dashboard.',
    },
    alertRefused: (reason: string, id: string) => `[approval] A Teams card click was not accepted (${reason}); the request (${id}) is unchanged.`,
    alertChanged: (id: string) => `[approval] The request (${id}) changed after its Teams card was sent; the click decided nothing.`,
  },
}

type Card = Record<string, unknown>
const textBlock = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra })

/** The approval card, rendered from the verified envelope. Pure. */
export function renderApprovalCard(approval: Approval, env: MailEnvelope, contentHash: string, expires: string, nonce: string, lang: ApprovalLang): Card {
  const t = T[lang]
  const facts: Array<{ title: string; value: string }> = [
    { title: t.agent, value: approval.agent_id },
    { title: t.to, value: env.to.join(', ') || t.none },
    { title: t.cc, value: env.cc.join(', ') || '-' },
  ]
  if (env.bcc && env.bcc.length > 0) facts.push({ title: t.bcc, value: env.bcc.join(', ') })
  if (env.account) facts.push({ title: t.account, value: String(env.account) })
  if (env.reply_to && env.reply_to.length > 0) facts.push({ title: t.replyTo, value: env.reply_to.join(' / ') })
  if (env.render) facts.push({ title: t.render, value: env.render })
  if (env.body_format) facts.push({ title: t.format, value: env.body_format })
  if (env.html_sha256) facts.push({ title: 'HTML sha256', value: env.html_sha256 })
  if (env.attachments && env.attachments.length > 0) facts.push({ title: t.attachment, value: env.attachments.map((a) => `${a.name} (sha256 ${a.sha256})`).join(', ') })
  facts.push({ title: t.expires, value: expires })
  const preview = env.text.length > CARD_TEXT_PREVIEW ? env.text.slice(0, CARD_TEXT_PREVIEW) : env.text
  const body: unknown[] = [
    textBlock(t.title, { weight: 'Bolder', size: 'Medium' }),
    { type: 'FactSet', facts },
    textBlock(t.text, { weight: 'Bolder', spacing: 'Medium' }),
    textBlock(preview, { fontType: 'Monospace' }),
  ]
  if (env.text.length > CARD_TEXT_PREVIEW) body.push(textBlock(t.more(env.text.length - CARD_TEXT_PREVIEW), { isSubtle: true }))
  body.push(textBlock(`${t.anchor}: ${contentHash}`, { isSubtle: true, size: 'Small' }))
  const action = (decision: 'approve' | 'reject', title: string, style: string) => ({
    type: 'Action.Execute', title, verb: APPROVAL_CARD_VERB, style, data: { approvalId: approval.id, decision, nonce },
  })
  return {
    type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body,
    actions: [action('approve', t.approve, 'positive'), action('reject', t.reject, 'destructive')],
  }
}

export type ResultKind = 'approved' | 'rejected' | 'expired' | 'already' | 'changed' | 'notAccepted' | 'unavailable'

/** The card the click is answered with (it replaces the approval card). Pure. */
export function renderResultCard(kind: ResultKind, lang: ApprovalLang, when: string, approvalId?: string): Card {
  const t = T[lang].result
  const line = kind === 'approved' ? t.approved(when) : kind === 'rejected' ? t.rejected(when) : t[kind]
  const body: unknown[] = [textBlock(T[lang].title, { weight: 'Bolder' }), textBlock(line)]
  if (approvalId) body.push(textBlock(approvalId, { isSubtle: true, size: 'Small' }))
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Posts the card to the owner's 1:1 chat and records it; false when it could not go out (the caller sends the text). */
export async function postApprovalCard(approval: Approval, route: Extract<CardRoute, { ok: true }>, expires: string, lang: ApprovalLang,
  deps: Pick<TeamsCardDeps, 'send' | 'stateDir' | 'resolveTarget'>): Promise<boolean> {
  const nonce = randomBytes(32).toString('hex')
  const card = renderApprovalCard(approval, route.envelope, route.contentHash, expires, nonce, lang)
  // The owner's 1:1 chat with the bot, resolved here with the same rule sendTeamsMessage applies (resolveTeamsTarget),
  // and sent to by its conversation id, so the conversation the card is bound to is the one it went to.
  const stateDir = deps.stateDir()
  const target = (deps.resolveTarget ?? resolveTeamsTarget)(stateDir, route.owner)
  if ('reason' in target) {
    logger.warn({ approvalId: approval.id, reason: target.reason }, 'approval Teams card NOT posted: no 1:1 chat with the owner')
    return false
  }
  try {
    const r = await deps.send(route.creds, stateDir, target.conversationId, T[lang].fallback(approval.id), { card })
    if (!r.messageId) {
      logger.warn({ approvalId: approval.id, status: r.status }, 'approval Teams card sent without an activity id: it cannot be bound, the decision stays on the dashboard')
      return false
    }
    recordApprovalTeamsCard({
      approvalId: approval.id, conversationId: target.conversationId, activityId: r.messageId, ownerAad: route.owner,
      contentHash: route.contentHash, nonceSha256: sha256(nonce), cardSha256: sha256(JSON.stringify(card)), lang,
    })
    logger.info({ approvalId: approval.id }, 'approval Teams card posted')
    return true
  } catch (err) {
    logger.warn({ approvalId: approval.id, err: err instanceof Error ? err.message : String(err) }, 'approval Teams card NOT posted')
    return false
  }
}

const verifiers = new Map<string, ChannelTokenVerifier>()
function defaultVerifier(appId: string): ChannelTokenVerifier {
  let v = verifiers.get(appId)
  if (!v) { v = createChannelTokenVerifier(appId); verifiers.set(appId, v) }
  return v
}

export interface CardActionAnswer { status: number; body: { card?: Card; error?: string } }

function sameHex(a: string, b: string): boolean {
  if (!NONCE_RX.test(a) || !NONCE_RX.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/**
 * One forwarded click. The answer is what the plugin returns to Teams: 200 with a card (any decision or refusal the
 * owner should see in place), 401 without a channel token, 400 for something that is not an approval-card click.
 */
export async function handleTeamsCardAction(authHeader: string | undefined, activity: unknown, deps: TeamsCardDeps): Promise<CardActionAnswer> {
  const now = (deps.now ?? (() => new Date()))()
  const creds = deps.creds()
  if (!creds || !creds.appId || !creds.tenant) return { status: 503, body: { card: renderResultCard('unavailable', 'hu', '') } }
  const token = await (deps.verifier ?? defaultVerifier)(creds.appId)(authHeader, activity)
  if (!token.ok) {
    logger.warn({ reason: token.reason }, 'approval Teams card action REFUSED: no Bot Framework channel token')
    return { status: 401, body: { error: 'unauthorized' } }
  }
  const a = activity as {
    type?: unknown; name?: unknown; id?: unknown; replyToId?: unknown
    from?: { aadObjectId?: unknown }; conversation?: { id?: unknown; tenantId?: unknown }; channelData?: { tenant?: { id?: unknown } }
    value?: { action?: { type?: unknown; verb?: unknown; data?: { approvalId?: unknown; decision?: unknown; nonce?: unknown } } }
  }
  const action = a.value?.action
  const data = action?.data
  if (a.type !== 'invoke' || a.name !== 'adaptiveCard/action' || action?.type !== 'Action.Execute' || action.verb !== APPROVAL_CARD_VERB
    || typeof data?.approvalId !== 'string' || (data.decision !== 'approve' && data.decision !== 'reject') || typeof data.nonce !== 'string') {
    return { status: 400, body: { error: 'not an approval card action' } }
  }
  const approvalId = data.approvalId
  const row = getApprovalTeamsCard(approvalId)
  const lang: ApprovalLang = row?.lang === 'en' ? 'en' : 'hu'
  const refuse = (reason: string): CardActionAnswer => {
    logger.warn({ approvalId, reason }, 'approval Teams card action REFUSED: nothing decided')
    try { deps.alert(T[lang].alertRefused(reason, approvalId)) } catch { /* the log line stands */ }
    return { status: 200, body: { card: renderResultCard('notAccepted', lang, '', approvalId) } }
  }
  const tenant = creds.tenant.toLowerCase()
  const convTenant = typeof a.conversation?.tenantId === 'string' ? a.conversation.tenantId.toLowerCase() : ''
  const dataTenant = typeof a.channelData?.tenant?.id === 'string' ? a.channelData.tenant.id.toLowerCase() : ''
  if (convTenant !== tenant || dataTenant !== tenant) return refuse('tenant')
  if (!teamsCardsOn(deps.setting)) return refuse('switch_off')
  if (!row) return refuse('no_card')
  const from = typeof a.from?.aadObjectId === 'string' ? a.from.aadObjectId.toLowerCase() : ''
  if (!from || from !== row.owner_aad) return refuse('not_the_owner')
  if (a.conversation?.id !== row.conversation_id || a.replyToId !== row.activity_id) return refuse('not_the_posted_card')
  if (!sameHex(sha256(data.nonce), row.nonce_sha256)) return refuse('nonce')
  const status = data.decision === 'approve' ? 'approved' : 'rejected'
  const activityId = typeof a.id === 'string' ? a.id : ''
  const res = decideApprovalFromTeams({ approvalId, status, activityId, ownerAad: from })
  const when = formatDecisionTime(now, lang)
  switch (res.outcome) {
    case 'decided':
      logger.info({ approvalId, status }, 'approval decided by the owner on the Teams card')
      return { status: 200, body: { card: renderResultCard(status, lang, when, approvalId) } }
    case 'expired':
      return { status: 200, body: { card: renderResultCard('expired', lang, when, approvalId) } }
    case 'content_changed':
      logger.warn({ approvalId }, 'approval Teams card action: the request changed after the card; nothing decided')
      try { deps.alert(T[lang].alertChanged(approvalId)) } catch { /* the log line stands */ }
      return { status: 200, body: { card: renderResultCard('changed', lang, when, approvalId) } }
    default:
      return { status: 200, body: { card: renderResultCard(res.approval?.status === 'timeout' ? 'expired' : 'already', lang, when, approvalId) } }
  }
}
