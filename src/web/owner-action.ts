// OWNERACTION1123: an owner-only action an agent asks for, run by the server once the owner approved it. The same shape
// as agent_create (agent-create-approval.ts), for the two owner actions that held the work up next to creating an agent:
//   - channel_setup: POST /api/agents/:name/channels/:provider (a bot's tokens, extra: true, allowFrom),
//   - channel_approve: POST /api/agents/:name/channels/:provider/approve (a pairing code -> an allowed sender).
// Three parts, as there:
//   1. fileOwnerActionRequest: an agent (the shared token too) files a request. Nothing runs here: the server validates
//      it, binds what it will do (a secret by its vault id and the value's sha256; a pairing code by the sender it names
//      now), stores the canonical request, and opens an owner_action approval bound to its hash. The owner's text is the
//      SERVER's rendering of the stored request, never the requester's words. Off unless OWNER_ACTION_VIA_APPROVAL=on.
//   2. consumeOwnerAction, the owner_action consumer: after the decision committed, ONE transaction consumes the approval
//      (approved -> consumed, the same hash, once), stamps the row and re-checks the stored request. Only then, outside
//      the transaction, it runs the action through the code the owner-session route runs (setupAgentChannel,
//      approveChannelPairing), with the values the owner approved: a vault value swapped since, or a code that now names
//      another sender, is refused. Every outcome is written on the row and goes to the owner and the main agent.
//   3. sweepOwnerActionOnStart: an approval decided while the server was down is consumed now; a crash between the
//      consume and the outcome is alerted, never re-run.
// LIMIT (T2, said in the PR too): this closes the API path (an agent with the shared token can only ASK). It is NOT a
// boundary against an agent that runs commands as the same OS user as the dashboard: such a process can write the
// database (an approved row, a session row) or click in the owner's open browser on this machine. Only separate OS users
// for the dashboard and the agents close that.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { getSecret } from './vault.js'
import { agentDir } from './agent-config.js'
import { setupAgentChannel, approveChannelPairing, readPendingPairing } from './routes/agents.js'
import { getDb, createApproval, consumeApproval, registerApprovalConsumer, createAgentMessage, type Approval } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { sendOwnerMessage } from '../notify.js'
import { canonicalJson, secretRef, type SecretRef, type VaultReadable } from './agent-create-spec.js'
import type { ChannelProviderType } from '../channel-provider.js'

export const OWNER_ACTION_CATEGORY = 'owner_action'
export const OWNER_ACTION_TIMEOUT_S = 3600
export const OWNER_ACTION_CONSUME_WINDOW_S = 7 * 86400
export const OWNER_ACTION_MAX_OPEN_PER_REQUESTER = 3
export const OWNER_ACTION_MAX_OPEN = 20
/** The providers whose setup takes a bot token (and Slack an app token) and whose pairing writes access.json. */
export const OWNER_ACTION_PROVIDERS = ['telegram', 'slack', 'discord'] as const
export const OWNER_ACTION_KINDS = ['channel_setup', 'channel_approve'] as const

export function ownerActionViaApprovalOn(setting: (key: string) => string): boolean {
  return String(setting('OWNER_ACTION_VIA_APPROVAL') ?? '').trim().toLowerCase() === 'on'
}

export interface ChannelSetupRequest {
  kind: 'channel_setup'
  agent: string
  provider: ChannelProviderType
  bot_token: SecretRef
  app_token: SecretRef | null
  channel_id: string | null
  extra: boolean
  allow_from: string[]
}
export interface ChannelApproveRequest {
  kind: 'channel_approve'
  agent: string
  provider: ChannelProviderType
  code: string
  sender_id: string
  chat_id: string | null
}
export type OwnerActionRequest = ChannelSetupRequest | ChannelApproveRequest
export type RequestResult = { ok: true; request: OwnerActionRequest } | { ok: false; status: number; error: string }

const AGENT_RX = /^[a-z0-9_-]{1,64}$/
const ID_RX = /^[A-Za-z0-9_-]{1,64}$/
const SETUP_KEYS = new Set(['kind', 'agent', 'provider', 'botToken', 'appToken', 'channelId', 'extra', 'allowFrom'])
const APPROVE_KEYS = new Set(['kind', 'agent', 'provider', 'code'])
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bad = (error: string, status = 400): RequestResult => ({ ok: false, status, error })
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

function agentExists(name: string): boolean {
  return name === MAIN_AGENT_ID || existsSync(agentDir(name))
}

/** The request body -> the canonical request the owner approves, or the refusal. Nothing is written here. */
export function canonicalOwnerAction(body: unknown, opts: { vaultReadable?: VaultReadable } = {}): RequestResult {
  if (!isObj(body)) return bad('the request must be a JSON object')
  const kind = body.kind
  if (typeof kind !== 'string' || !(OWNER_ACTION_KINDS as readonly string[]).includes(kind)) return bad(`kind must be one of: ${OWNER_ACTION_KINDS.join(', ')}`)
  const allowed = kind === 'channel_setup' ? SETUP_KEYS : APPROVE_KEYS
  const unknown = Object.keys(body).find((k) => !allowed.has(k))
  if (unknown !== undefined) return bad(`unknown field: ${unknown}`)
  const agent = body.agent
  if (typeof agent !== 'string' || !AGENT_RX.test(agent)) return bad('agent must be an agent id')
  if (!agentExists(agent)) return bad('Agent not found', 404)
  const provider = body.provider
  if (typeof provider !== 'string' || !(OWNER_ACTION_PROVIDERS as readonly string[]).includes(provider)) return bad(`provider must be one of: ${OWNER_ACTION_PROVIDERS.join(', ')}`)
  const p = provider as ChannelProviderType

  if (kind === 'channel_approve') {
    const code = body.code
    if (typeof code !== 'string' || !ID_RX.test(code.trim())) return bad('code must be a pairing code')
    const pending = readPendingPairing(agent, p, code.trim())
    if (!pending) return bad('Invalid or expired code', 404)
    return { ok: true, request: { kind: 'channel_approve', agent, provider: p, code: code.trim(), sender_id: pending.senderId, chat_id: pending.chatId } }
  }

  // channel_setup: the main agent's channel is the launcher's (channels.sh); it stays a dashboard action.
  if (agent === MAIN_AGENT_ID) return bad('the main agent\'s channel is set up on the dashboard, not through a request', 403)
  const readable = opts.vaultReadable ?? (() => false)
  const bot = secretRef('botToken', body.botToken, readable)
  if ('ok' in bot) return bad(bot.error, bot.status)
  let app: SecretRef | null = null
  if (body.appToken !== undefined && body.appToken !== null) {
    const a = secretRef('appToken', body.appToken, readable)
    if ('ok' in a) return bad(a.error, a.status)
    app = a
  }
  if (p === 'slack' && !app) return bad('a Slack channel needs appToken ({ vault_ref })')
  if (p !== 'slack' && app) return bad('appToken is for a Slack channel only')
  let channelId: string | null = null
  if (body.channelId !== undefined && body.channelId !== null) {
    if (typeof body.channelId !== 'string' || !ID_RX.test(body.channelId)) return bad('channelId must be a channel id')
    channelId = body.channelId
  }
  if (p === 'discord' && !channelId) return bad('a Discord channel needs channelId')
  if (body.extra !== undefined && typeof body.extra !== 'boolean') return bad('extra must be true or false')
  let allowFrom: string[] = []
  if (body.allowFrom !== undefined) {
    if (!Array.isArray(body.allowFrom) || body.allowFrom.length === 0 || !body.allowFrom.every((v) => typeof v === 'string' && ID_RX.test(v))) {
      return bad('allowFrom must be a non-empty array of user ids')
    }
    allowFrom = [...new Set(body.allowFrom as string[])]
  }
  return { ok: true, request: { kind: 'channel_setup', agent, provider: p, bot_token: bot, app_token: app, channel_id: channelId, extra: body.extra === true, allow_from: allowFrom } }
}

export function ownerActionHash(r: OwnerActionRequest): string {
  return sha256(canonicalJson(r))
}

/** The owner's text, rendered from the canonical request and nothing else. A secret is "set (vault: <id>)" only. */
export function renderOwnerAction(r: OwnerActionRequest, hash: string, requestedBy: string, lang: 'hu' | 'en'): string {
  const hu = lang === 'hu'
  const L: string[] = []
  if (r.kind === 'channel_setup') {
    L.push(hu ? 'Tulajdonosi művelet: csatorna beállítása' : 'Owner action: set up a channel')
    L.push(`${hu ? 'Ügynök' : 'Agent'}: ${r.agent}`)
    L.push(`${hu ? 'Csatorna' : 'Channel'}: ${r.provider} (${r.extra ? (hu ? 'a meglévő csatorna MELLÉ' : 'NEXT TO the existing channel') : (hu ? 'az elsődleges csatorna HELYÉRE' : 'REPLACES the primary channel')})`)
    L.push(`${hu ? 'Bot-token' : 'Bot token'}: ${hu ? 'beállítva' : 'set'} (vault: ${r.bot_token.vault_ref})`)
    if (r.app_token) L.push(`${hu ? 'App-token' : 'App token'}: ${hu ? 'beállítva' : 'set'} (vault: ${r.app_token.vault_ref})`)
    if (r.channel_id) L.push(`${hu ? 'Csatorna-azonosító' : 'Channel id'}: ${r.channel_id}`)
    L.push(r.allow_from.length
      ? `${hu ? 'Írhat neki (csak ők)' : 'May message it (only these)'}: ${r.allow_from.join(', ')}`
      : (hu ? 'Írhat neki: párosítás után, akit külön jóváhagysz' : 'May message it: after pairing, whoever you approve'))
    L.push(hu ? 'Az ügynök a mentés után újraindul.' : 'The agent restarts after the save.')
  } else {
    L.push(hu ? 'Tulajdonosi művelet: párosítás jóváhagyása' : 'Owner action: approve a pairing')
    L.push(`${hu ? 'Ügynök' : 'Agent'}: ${r.agent}`)
    L.push(`${hu ? 'Csatorna' : 'Channel'}: ${r.provider}`)
    L.push(`${hu ? 'Párosító kód' : 'Pairing code'}: ${r.code}`)
    L.push(`${hu ? 'Küldő azonosítója' : 'Sender id'}: ${r.sender_id}${r.chat_id ? ` (chat: ${r.chat_id})` : ''}`)
    L.push(hu ? 'Ezzel ez a küldő írhat az ügynöknek.' : 'This sender may then message the agent.')
  }
  L.push(`${hu ? 'Kérte' : 'Requested by'}: ${requestedBy}`)
  L.push(`${hu ? 'Ellenőrző kód' : 'Check code'}: ${hash.slice(0, 8)}`)
  return L.join('\n')
}

export interface FileResult { status: number; body: Record<string, unknown> }

export function fileOwnerActionRequest(body: unknown, requestedBy: string, deps: { setting: (k: string) => string; lang: 'hu' | 'en'; vaultReadable: VaultReadable }): FileResult {
  if (!ownerActionViaApprovalOn(deps.setting)) {
    return { status: 403, body: { error: 'Owner actions by approval are off (OWNER_ACTION_VIA_APPROVAL).' } }
  }
  const r = canonicalOwnerAction(body, { vaultReadable: deps.vaultReadable })
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  const json = canonicalJson(r.request)
  const hash = ownerActionHash(r.request)
  const text = renderOwnerAction(r.request, hash, requestedBy, deps.lang)
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // The count and the insert in one synchronous transaction (the agent_create lesson: a count before an await let 30
  // parallel requests through).
  const filed = getDb().transaction((): boolean => {
    const open = getDb().prepare(`
      SELECT agent_id FROM approvals WHERE category = ? AND status = 'pending' AND (timeout_at IS NULL OR timeout_at > ?)
    `).all(OWNER_ACTION_CATEGORY, now) as Array<{ agent_id: string }>
    if (open.length >= OWNER_ACTION_MAX_OPEN || open.filter((o) => o.agent_id === requestedBy).length >= OWNER_ACTION_MAX_OPEN_PER_REQUESTER) return false
    createApproval({ id, agent_id: requestedBy, category: OWNER_ACTION_CATEGORY, action_description: text, action_payload: null, timeout_at: now + OWNER_ACTION_TIMEOUT_S, content_hash: hash })
    getDb().prepare(`
      INSERT INTO owner_action_requests (approval_id, kind, request_json, content_hash, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, r.request.kind, json, hash, requestedBy, now)
    return true
  })()
  if (!filed) return { status: 429, body: { error: 'Too many open owner_action requests; wait for the owner to decide the open ones.' } }
  logger.info({ approvalId: id, requestedBy, kind: r.request.kind, agent: r.request.agent }, 'owner_action request filed; waiting for the owner')
  return { status: 201, body: { ok: true, approvalId: id, contentHash: hash } }
}

/** The stored request, re-read and re-hashed: anything but the approved bytes is refused. */
export function recheckStoredRequest(json: string, approvedHash: string): { ok: true; request: OwnerActionRequest } | { ok: false; reason: string } {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return { ok: false, reason: 'stored_request_unparseable' } }
  if (!isObj(parsed) || canonicalJson(parsed) !== json) return { ok: false, reason: 'stored_request_not_canonical' }
  if (sha256(json) !== approvedHash) return { ok: false, reason: 'stored_request_hash_mismatch' }
  if (parsed.kind !== 'channel_setup' && parsed.kind !== 'channel_approve') return { ok: false, reason: 'stored_request_unknown_kind' }
  return { ok: true, request: parsed as unknown as OwnerActionRequest }
}

/** Where the outcome is told: the owner (one line) and the main agent. A seam for the tests. */
export const outcomeNotice = {
  owner: (text: string): void => { void sendOwnerMessage(text).catch((err) => logger.error({ err }, 'owner_action outcome to the owner failed')) },
  main: (text: string): void => {
    try { createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.error({ err }, 'owner_action outcome to the main agent failed') }
  },
}
function tell(text: string): void { outcomeNotice.owner(text); outcomeNotice.main(text) }

function setOutcome(approvalId: string, outcome: string): void {
  getDb().prepare('UPDATE owner_action_requests SET outcome = ?, outcome_at = ? WHERE approval_id = ?').run(outcome, Math.floor(Date.now() / 1000), approvalId)
}

export type ConsumeStep = { go: true; request: OwnerActionRequest } | { go: false; reason: string }

/** The transaction: consume, stamp, re-check. */
export function consumeOwnerActionStep(approvalId: string): ConsumeStep {
  const db = getDb()
  return db.transaction((): ConsumeStep => {
    const row = db.prepare('SELECT request_json, content_hash FROM owner_action_requests WHERE approval_id = ?').get(approvalId) as { request_json: string; content_hash: string } | undefined
    if (!row) return { go: false, reason: 'no_request' }
    const c = consumeApproval({ id: approvalId, contentHash: row.content_hash, consumer: OWNER_ACTION_CATEGORY, messageId: approvalId, windowSeconds: OWNER_ACTION_CONSUME_WINDOW_S, category: OWNER_ACTION_CATEGORY })
    if (!c.ok) {
      // Revizor M3: a refusal other than already_consumed (e.g. expired: approved but not consumed within the window) is
      // final. Its outcome is written once, so the start-up sweep (outcome IS NULL) does not pick it up and alert again.
      if (c.reason !== 'already_consumed') setOutcome(approvalId, `refused:consume_${c.reason}`)
      return { go: false, reason: `consume_refused:${c.reason}` }
    }
    const stamped = db.prepare('UPDATE owner_action_requests SET consumed_at = ? WHERE approval_id = ? AND consumed_at IS NULL').run(Math.floor(Date.now() / 1000), approvalId).changes
    if (stamped !== 1) throw new Error('owner_action request already consumed while its approval was not')
    const re = recheckStoredRequest(row.request_json, row.content_hash)
    if (!re.ok) { setOutcome(approvalId, `refused:${re.reason}`); return { go: false, reason: re.reason } }
    return { go: true, request: re.request }
  })()
}

/** A secret read from the vault now, or null when it is not the value the owner approved. */
const approvedSecret = (r: SecretRef): string | null => {
  const value = getSecret(r.vault_ref)?.trim() ?? null
  return value !== null && sha256(value) === r.value_sha256 ? value : null
}

/** After the consume: the action itself, through the owner-session route's own code. Resolves when the outcome is written. */
export async function runConsumedOwnerAction(approvalId: string, r: OwnerActionRequest): Promise<void> {
  const what = r.kind === 'channel_setup' ? `${r.agent} ${r.provider} csatornájának beállítása` : `${r.agent} ${r.provider} párosítása (küldő: ${r.sender_id})`
  try {
    if (!agentExists(r.agent)) {
      setOutcome(approvalId, 'refused:agent_gone')
      tell(`A jóváhagyott tulajdonosi művelet (${what}) NEM futott le: az ügynök már nem létezik (${approvalId}).`)
      return
    }
    let res: { status: number; body: Record<string, unknown> }
    if (r.kind === 'channel_setup') {
      const botToken = approvedSecret(r.bot_token)
      const appToken = r.app_token ? approvedSecret(r.app_token) : null
      if (botToken === null || (r.app_token && appToken === null)) {
        const ref = botToken === null ? r.bot_token.vault_ref : r.app_token!.vault_ref
        setOutcome(approvalId, 'refused:vault_value_changed')
        tell(`A jóváhagyott tulajdonosi művelet (${what}) NEM futott le: a token értéke a vaultban (${ref}) megváltozott a jóváhagyás óta (${approvalId}).`)
        return
      }
      const input: Record<string, unknown> = { botToken }
      if (appToken !== null) input.appToken = appToken
      if (r.channel_id) input.channelId = r.channel_id
      if (r.extra) input.extra = true
      if (r.allow_from.length) input.allowFrom = r.allow_from
      res = await setupAgentChannel(r.agent, r.provider, input)
    } else {
      res = approveChannelPairing(r.agent, r.provider, r.code, r.sender_id)
    }
    if (res.status !== 200 || res.body.ok !== true) {
      setOutcome(approvalId, `failed:${res.status}:${String(res.body.error ?? '')}`)
      tell(`A jóváhagyott tulajdonosi művelet (${what}) NEM sikerült: ${res.status} ${String(res.body.error ?? '')} (${approvalId}).`)
      return
    }
    setOutcome(approvalId, 'done')
    logger.info({ approvalId, kind: r.kind, agent: r.agent, provider: r.provider }, 'owner_action run after the owner approved it')
    tell(`Kész: ${what}, a jóváhagyásod szerint (${approvalId}).`)
  } catch (err) {
    setOutcome(approvalId, `failed:exception:${err instanceof Error ? err.message : String(err)}`)
    tell(`A jóváhagyott tulajdonosi művelet (${what}) hibával megállt: ${err instanceof Error ? err.message : String(err)} (${approvalId}). Nézd meg, mi változott.`)
  }
}

export function consumeOwnerAction(approval: Approval): Promise<void> {
  const step = consumeOwnerActionStep(approval.id)
  if (!step.go) {
    if (!step.reason.startsWith('consume_refused:already_consumed')) {
      outcomeNotice.main(`A jóváhagyott tulajdonosi művelet (${approval.id}) nem futott le: ${step.reason}. Semmi nem változott.`)
    }
    return Promise.resolve()
  }
  return runConsumedOwnerAction(approval.id, step.request)
}

let registered = false
export function registerOwnerActionConsumer(): void {
  if (registered) return
  registerApprovalConsumer(OWNER_ACTION_CATEGORY, (a) => { void consumeOwnerAction(a) })
  registered = true
}

/** At server start: an approved, unconsumed request is consumed now; one consumed without an outcome is alerted, never re-run. */
export async function sweepOwnerActionOnStart(): Promise<{ consumed: number; interrupted: number }> {
  const db = getDb()
  const pending = db.prepare(`
    SELECT a.* FROM approvals a JOIN owner_action_requests r ON r.approval_id = a.id
    WHERE a.category = ? AND a.status = 'approved' AND a.consumed_at IS NULL AND r.consumed_at IS NULL AND r.outcome IS NULL
  `).all(OWNER_ACTION_CATEGORY) as Approval[]
  const interrupted = db.prepare('SELECT approval_id FROM owner_action_requests WHERE consumed_at IS NOT NULL AND outcome IS NULL').all() as Array<{ approval_id: string }>
  for (const r of interrupted) {
    setOutcome(r.approval_id, 'interrupted')
    outcomeNotice.main(`A jóváhagyott tulajdonosi művelet (${r.approval_id}) a fogyasztás után megszakadt (újraindulás). Nem futtatom újra: nézd meg, mi változott, és ha kell, kérd újra.`)
  }
  for (const a of pending) await consumeOwnerAction(a)
  return { consumed: pending.length, interrupted: interrupted.length }
}
