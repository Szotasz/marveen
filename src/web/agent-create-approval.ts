// AGENTCREATEPR2-1119: creating an agent through an approval. Three parts:
//   1. fileAgentSpecRequest: an agent (with the shared token too) files a spec. Only a REQUEST: the server validates
//      the spec (agent-create-spec.ts), stores it, and opens an agent_create approval bound to its hash, with the
//      owner's text rendered from the stored spec. Nothing is created here. Off unless AGENT_CREATE_VIA_APPROVAL=on.
//   2. consumeAgentCreate, the agent_create consumer (registerApprovalConsumer): it runs after the decision committed.
//      In ONE transaction it consumes the approval (approved -> consumed, the same hash, once), stamps the spec row,
//      and re-checks the stored spec (its hash, and each vault value's sha256). Only then, outside the transaction, it
//      creates the agent through createAgentFromSpec, the same code as the dashboard's create. Every outcome is
//      written on the spec row; anything but "created" also goes to the main agent as an alert.
//   3. sweepAgentCreateOnStart: an approval decided while the server was down, or a crash between the consume and
//      the outcome, is never lost silently: the first is consumed now, the second is alerted.
// The channel adapters that ask the owner and decide (Teams, Telegram, Slack, Gromzo) come in PR-3.
import { createHash, randomUUID } from 'node:crypto'
import { getSecret } from './vault.js'
import { applyAgentTeam, issueAgentChannelInvite, setupAgentChannel } from './routes/agents.js'
import { findConnectorConfig, writeConnectorIntoAgent } from './routes/connectors.js'
import { getDb, createApproval, consumeApproval, registerApprovalConsumer, createAgentMessage, type Approval } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { canonicalAgentSpec, canonicalJson, specHash, renderAgentSpec, recheckStoredSpec, type AgentSpec, type SecretRef, type VaultReadable } from './agent-create-spec.js'
import { createAgentFromSpec } from './agent-create.js'

export const AGENT_CREATE_CATEGORY = 'agent_create'
/** How long the owner has to decide (the approvals timeout). */
export const AGENT_CREATE_TIMEOUT_S = 3600
/** An approved request is consumed within this window of its decision (the start-up sweep's reach included). */
export const AGENT_CREATE_CONSUME_WINDOW_S = 7 * 86400

export function agentCreateViaApprovalOn(setting: (key: string) => string): boolean {
  return String(setting('AGENT_CREATE_VIA_APPROVAL') ?? '').trim().toLowerCase() === 'on'
}

export interface FileResult { status: number; body: Record<string, unknown> }

/** Dani #2922 n1: a request opens an owner approval, so the open ones are capped, per requester and in all. */
export const AGENT_CREATE_MAX_OPEN_PER_REQUESTER = 3
export const AGENT_CREATE_MAX_OPEN = 20

export async function fileAgentSpecRequest(body: unknown, requestedBy: string, deps: { setting: (k: string) => string; lang: 'hu' | 'en'; vaultReadable: VaultReadable }): Promise<FileResult> {
  if (!agentCreateViaApprovalOn(deps.setting)) {
    return { status: 403, body: { error: 'Agent creation by approval is off (AGENT_CREATE_VIA_APPROVAL).' } }
  }
  const r = await canonicalAgentSpec(body, { vaultReadable: deps.vaultReadable })
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  const json = canonicalJson(r.spec)
  const hash = specHash(r.spec)
  const text = renderAgentSpec(r.spec, hash, deps.lang)
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // The count and the insert in ONE synchronous transaction, nothing awaited in between (Dani 81221: counted before the
  // spec's await, 30 parallel requests all passed): better-sqlite3 runs it to the end, so in this process it is atomic.
  const filed = getDb().transaction((): boolean => {
    const open = getDb().prepare(`
      SELECT agent_id FROM approvals WHERE category = ? AND status = 'pending' AND (timeout_at IS NULL OR timeout_at > ?)
    `).all(AGENT_CREATE_CATEGORY, now) as Array<{ agent_id: string }>
    if (open.length >= AGENT_CREATE_MAX_OPEN || open.filter((o) => o.agent_id === requestedBy).length >= AGENT_CREATE_MAX_OPEN_PER_REQUESTER) return false
    createApproval({ id, agent_id: requestedBy, category: AGENT_CREATE_CATEGORY, action_description: text, action_payload: null, timeout_at: now + AGENT_CREATE_TIMEOUT_S, content_hash: hash })
    getDb().prepare(`
      INSERT INTO agent_create_specs (approval_id, spec_json, content_hash, requested_by, requested_at) VALUES (?, ?, ?, ?, ?)
    `).run(id, json, hash, requestedBy, now)
    return true
  })()
  if (!filed) return { status: 429, body: { error: 'Too many open agent_create requests; wait for the owner to decide the open ones.' } }
  logger.info({ approvalId: id, requestedBy, name: r.spec.name }, 'agent_create request filed; waiting for the owner')
  // Dani #2940 B1: the owner's text is not returned to the requester (it is the owner's view; the approval holds it)
  return { status: 201, body: { ok: true, approvalId: id, contentHash: hash } }
}

interface SpecRow { approval_id: string; spec_json: string; content_hash: string; consumed_at: number | null; outcome: string | null }

function setOutcome(approvalId: string, outcome: string, createdAgent: string | null = null): void {
  getDb().prepare('UPDATE agent_create_specs SET outcome = ?, outcome_at = ?, created_agent = COALESCE(?, created_agent) WHERE approval_id = ?')
    .run(outcome, Math.floor(Date.now() / 1000), createdAgent, approvalId)
}

function alertMain(text: string): void {
  try { createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.error({ err }, 'agent_create alert to the main agent failed') }
}

export type ConsumeStep = { go: true; spec: AgentSpec } | { go: false; reason: string }

/** The transaction: consume, stamp, re-check. Exported for the tests; the consumer and the sweep call it. */
export function consumeAgentCreateStep(approvalId: string): ConsumeStep {
  const db = getDb()
  return db.transaction((): ConsumeStep => {
    const row = db.prepare('SELECT approval_id, spec_json, content_hash, consumed_at, outcome FROM agent_create_specs WHERE approval_id = ?').get(approvalId) as SpecRow | undefined
    if (!row) return { go: false, reason: 'no_spec' }
    const c = consumeApproval({ id: approvalId, contentHash: row.content_hash, consumer: AGENT_CREATE_CATEGORY, messageId: approvalId, windowSeconds: AGENT_CREATE_CONSUME_WINDOW_S, category: AGENT_CREATE_CATEGORY })
    if (!c.ok) return { go: false, reason: `consume_refused:${c.reason}` }
    const stamped = db.prepare('UPDATE agent_create_specs SET consumed_at = ? WHERE approval_id = ? AND consumed_at IS NULL').run(Math.floor(Date.now() / 1000), approvalId).changes
    if (stamped !== 1) throw new Error('agent_create spec already consumed while its approval was not')
    const re = recheckStoredSpec(row.spec_json, row.content_hash)
    if (!re.ok) {
      setOutcome(approvalId, `refused:${re.reason}`)
      return { go: false, reason: re.reason }
    }
    return { go: true, spec: re.spec }
  })()
}

const sha256hex = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex')
/** A secret read from the vault at this moment, or null when it is not the value the owner approved (its sha256 is in
 *  the hash): a value swapped since the consume is refused. */
const approvedSecret = (r: SecretRef): string | null => {
  const value = getSecret(r.vault_ref)?.trim() ?? null
  return value !== null && sha256hex(value) === r.value_sha256 ? value : null
}

/** After the consume: the create itself, through the dashboard's own code, then (spec version 2) the team block, the
 *  MCP servers, the channel and the invite, each through the code its owner-session route uses. The team and the
 *  servers come before the channel (the channel setup restarts the agent). A step that cannot run as approved stops
 *  there: the agent exists, the outcome names the step, and the main agent is alerted. An invite's link is never in
 *  an alert or a log line: the owner sees it on the dashboard (Samu 81360, F). Resolves when the outcome is written. */
export async function createFromConsumed(approvalId: string, spec: AgentSpec): Promise<void> {
  const partial = (outcome: string, alert: string) => { setOutcome(approvalId, outcome, spec.name); alertMain(alert) }
  try {
    const r = await createAgentFromSpec({ name: spec.display_name, description: spec.description, model: spec.model, profile: spec.profile, customProvider: spec.custom_provider })
    if (r.status !== 200 || r.body.ok !== true) {
      setOutcome(approvalId, `failed:${r.status}:${String(r.body.error ?? '')}`)
      alertMain(`Az ügynök-létrehozás jóváhagyott kérése (${approvalId}, ${spec.name}) NEM hozta létre az ügynököt: ${r.status} ${String(r.body.error ?? '')}. Semmi nem jött létre.`)
      return
    }
    if (spec.spec_version === 2 && spec.team) {
      const t = spec.team
      const tr = applyAgentTeam(spec.name, { role: t.role, reportsTo: t.reports_to, delegatesTo: t.delegates_to, autoDelegation: t.auto_delegation, trustFrom: t.trust_from, ...(t.tagline !== null ? { tagline: t.tagline } : {}) })
      if (tr.cycleRejected || tr.warnings.droppedSelf.length || tr.warnings.droppedUnknown.length) {
        partial('created_team_changed', `Az ügynök (${spec.name}) létrejött, de a csapat-beállítása nem a jóváhagyott lett (egy név kiesett vagy ciklus lett belőle a jóváhagyás óta), ezért a többit (MCP, csatorna, meghívó) NEM állítottam be (${approvalId}). Nézd meg a dashboardon.`)
        return
      }
    }
    if (spec.spec_version === 2) {
      for (const m of spec.mcp) {
        const cfg = findConnectorConfig(m.name)
        if (!cfg || sha256hex(canonicalJson(cfg)) !== m.config_sha256) {
          partial(`created_mcp_refused:${m.name}`, `Az ügynök (${spec.name}) létrejött, de a(z) ${m.name} MCP-szervert NEM rendeltem hozzá: a konfigja megváltozott a jóváhagyás óta (${approvalId}). A csatornát és a meghívót sem állítottam be.`)
          return
        }
        writeConnectorIntoAgent(spec.name, m.name, cfg)
      }
    }
    if (spec.channel) {
      const botToken = approvedSecret(spec.channel.bot_token)
      const appRef = spec.spec_version === 2 ? spec.channel.app_token : null
      const appToken = appRef ? approvedSecret(appRef) : null
      if (botToken === null || (appRef && appToken === null)) {
        const ref = botToken === null ? spec.channel.bot_token.vault_ref : appRef!.vault_ref
        partial('created_channel_refused:vault_value_changed', `Az ügynök (${spec.name}) létrejött, de a csatornáját NEM állítottam be: a token értéke a vaultban (${ref}) megváltozott a jóváhagyás óta (${approvalId}).`)
        return
      }
      const input: Record<string, unknown> = { botToken }
      if (spec.spec_version === 2) {
        if (appToken !== null) input.appToken = appToken
        if (spec.channel.channel_id) input.channelId = spec.channel.channel_id
        if (spec.channel.allow_from.length) input.allowFrom = spec.channel.allow_from
      }
      const ch = await setupAgentChannel(spec.name, spec.channel.provider, input)
      if (ch.status !== 200 || ch.body.ok !== true) {
        partial(`created_channel_failed:${ch.status}:${String(ch.body.error ?? '')}`, `Az ügynök (${spec.name}) létrejött, de a csatornája (${spec.channel.provider}) nem állt be: ${ch.status} ${String(ch.body.error ?? '')} (${approvalId}).`)
        return
      }
      if (spec.spec_version === 2 && spec.invite) {
        const inv = await issueAgentChannelInvite(spec.name, spec.channel.provider)
        if (inv.status !== 200) {
          partial(`created_invite_failed:${inv.status}`, `Az ügynök (${spec.name}) létrejött a csatornájával, de a meghívót nem tudtam kiállítani (${inv.status}, ${approvalId}). A dashboardon kiállítható.`)
          return
        }
        logger.info({ approvalId, name: spec.name, provider: spec.channel.provider }, 'agent_create: the approved invite was issued (its link is on the dashboard)')
      }
    }
    setOutcome(approvalId, 'created', spec.name)
    logger.info({ approvalId, name: spec.name, channel: spec.channel?.provider ?? null }, 'agent created from an approved agent_create spec')
  } catch (err) {
    setOutcome(approvalId, `failed:exception:${err instanceof Error ? err.message : String(err)}`)
    alertMain(`Az ügynök-létrehozás jóváhagyott kérése (${approvalId}, ${spec.name}) hibával megállt: ${err instanceof Error ? err.message : String(err)}. Nézd meg, mi jött létre.`)
  }
}

/** The agent_create consumer: called by the decision core after an approval of this category committed. */
export function consumeAgentCreate(approval: Approval): Promise<void> {
  const step = consumeAgentCreateStep(approval.id)
  if (!step.go) {
    if (!step.reason.startsWith('consume_refused:already_consumed')) {
      alertMain(`Az ügynök-létrehozás jóváhagyott kérése (${approval.id}) nem futott le: ${step.reason}. Semmi nem jött létre.`)
    }
    return Promise.resolve()
  }
  return createFromConsumed(approval.id, step.spec)
}

let registered = false
/** Registers the consumer once (server start). */
export function registerAgentCreateConsumer(): void {
  if (registered) return
  registerApprovalConsumer(AGENT_CREATE_CATEGORY, (a) => { void consumeAgentCreate(a) })
  registered = true
}

/**
 * At server start: an approved, unconsumed agent_create request (decided while the consumer could not run) is consumed
 * now; one consumed without an outcome (a crash between the consume and the create) is alerted, never re-run.
 */
export async function sweepAgentCreateOnStart(): Promise<{ consumed: number; interrupted: number }> {
  const db = getDb()
  const pending = db.prepare(`
    SELECT a.* FROM approvals a JOIN agent_create_specs s ON s.approval_id = a.id
    WHERE a.category = ? AND a.status = 'approved' AND a.consumed_at IS NULL AND s.consumed_at IS NULL
  `).all(AGENT_CREATE_CATEGORY) as Approval[]
  const interrupted = db.prepare(`
    SELECT approval_id FROM agent_create_specs WHERE consumed_at IS NOT NULL AND outcome IS NULL
  `).all() as Array<{ approval_id: string }>
  for (const r of interrupted) {
    setOutcome(r.approval_id, 'interrupted')
    alertMain(`Az ügynök-létrehozás jóváhagyott kérése (${r.approval_id}) a fogyasztás után megszakadt (újraindulás). Nem futtatom újra: nézd meg, mi jött létre, és ha kell, kérd újra.`)
  }
  for (const a of pending) await consumeAgentCreate(a)
  return { consumed: pending.length, interrupted: interrupted.length }
}
