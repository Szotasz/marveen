// AGENTCREATEPR2-1119: the spec behind an agent_create approval. An agent (with the shared token too) files a REQUEST;
// nothing is created until the owner approves it in a channel and the server's consumer runs. The owner approves what
// the server stored, so the stored spec is canonical, versioned and hashed:
//   - the request is validated before anything is stored: an unknown field, a wrong type, a name, model, provider or
//     description createAgentFromSpec would refuse, an unknown security profile, or a vault reference that does not
//     resolve is answered with 400, and no approval is asked for;
//   - the canonical object is the ONE source of both the owner's text and the hash: every hashed field is in the text;
//   - a secret field is never a value: { vault_ref, value_sha256 }. The hash binds the value's sha256 too, so a vault
//     value swapped between the approval and the creation is caught when the consumer recomputes it. The text shows
//     only "set (vault: <id>)" for it: no value, prefix or length.
// Spec version 1 carries what POST /api/agents takes plus a Telegram channel and its bot token (Samu 81152, A).
// AGENTCREATEPR2B-1119, spec version 2 (Samu 81360), adds what the owner's dashboard session sets up today:
//   - the channel on Slack (bot and app token) and Discord (bot token and channel id), and an allowFrom list (the
//     "pairing" of a spec: the ids let in; a code pairing needs a live bot and stays on the dashboard);
//   - the team block (role, reports-to, delegates, auto-delegation, trusted peers, tagline); a name dropped by the
//     team sanitizer or a reporting cycle is refused here, never dropped in silence;
//   - MCP servers ALREADY on this install, by name; the server's config is bound by its sha256. Neither the stored spec
//     (agents can read it) nor the text holds its arguments, a URL's query, fragment or user info, or any env or header
//     value (Dani #2940 B1): the text shows the type, the command and how many arguments, the URL's origin and path, the
//     keys of its environment and headers, and the file it came from, marked when an agent can write that file (n1);
//   - an invite: the consumer issues it after the channel; its link is shown only on the owner's dashboard.
// Version 1 requests stay accepted exactly as before; a version-2 field in a version-1 request is an unknown field.
import { createHash } from 'node:crypto'
import { resolveModelId } from './agent-config.js'
import { sanitizeAgentName } from './sanitize.js'
import { resolveProfileTemplate } from './profiles.js'
import { getSecret } from './vault.js'
import { checkAgentCreatable } from './agent-create.js'
import { launchableInstallDefault } from './default-model-guard.js'
import { readAgentTeam, reportsToCreatesCycle, sanitizeTeamConfig } from './agent-team.js'
import { MAIN_AGENT_ID } from '../config.js'
import { isManagedSettingsReady, validateDiscordChannelId } from './routes/agents.js'
import { findConnectorConfigWithSource } from './routes/connectors.js'

export const AGENT_SPEC_VERSION = 2
export const AGENT_SPEC_VERSIONS = [1, 2] as const
/** Version 1: the channels whose setup is the bot token alone (Telegram). */
export const SPEC_BOT_TOKEN_PROVIDERS = ['telegram'] as const
/** Version 2: Slack also takes its app token, Discord its channel id. */
export const SPEC_V2_PROVIDERS = ['telegram', 'slack', 'discord'] as const
/** The providers an invite can be issued on (the invite monitor approves on these two). */
export const SPEC_INVITE_PROVIDERS = ['telegram', 'slack'] as const
type SpecProvider = typeof SPEC_BOT_TOKEN_PROVIDERS[number]
type SpecV2Provider = typeof SPEC_V2_PROVIDERS[number]

export interface SecretRef { vault_ref: string; value_sha256: string }
interface SpecBase {
  name: string
  display_name: string
  description: string
  model: string
  profile: string
  custom_provider: string | null
}
export interface AgentSpecV1 extends SpecBase {
  spec_version: 1
  channel: { provider: SpecProvider; bot_token: SecretRef } | null
}
export interface SpecTeam {
  role: 'member' | 'leader'
  reports_to: string | null
  delegates_to: string[]
  auto_delegation: boolean
  trust_from: string[]
  tagline: string | null
}
export interface SpecMcp {
  name: string
  type: string
  command: string | null
  arg_count: number
  url: string | null
  env_keys: string[]
  header_keys: string[]
  source: string
  source_agent_writable: boolean
  config_sha256: string
}

/** A server URL without what can carry a secret: user info, query and fragment dropped (origin and path only), and a
 *  path segment that looks like a key (16+ characters of [A-Za-z0-9_-], as hosted MCP services put it: /s/<key>/mcp)
 *  shown as *** (Dani #2940 delta). */
export function displayUrl(u: string): string {
  try {
    const x = new URL(u)
    const path = x.pathname.split('/').map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) ? '***' : seg)).join('/')
    return `${x.origin}${path}`
  } catch {
    return '(unreadable URL)'
  }
}
export interface AgentSpecV2 extends SpecBase {
  spec_version: 2
  channel: { provider: SpecV2Provider; bot_token: SecretRef; app_token: SecretRef | null; channel_id: string | null; allow_from: string[] } | null
  team: SpecTeam | null
  mcp: SpecMcp[]
  invite: boolean
}
export type AgentSpec = AgentSpecV1 | AgentSpecV2

export type SpecResult = { ok: true; spec: AgentSpec } | { ok: false; status: number; error: string }

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const TOP_KEYS = new Set(['spec_version', 'name', 'description', 'model', 'profile', 'customProvider', 'channel'])
const TOP_KEYS_V2 = new Set([...TOP_KEYS, 'team', 'mcp', 'invite'])
const CHANNEL_KEYS = new Set(['provider', 'botToken'])
const CHANNEL_KEYS_V2 = new Set([...CHANNEL_KEYS, 'appToken', 'channelId', 'allowFrom'])
const TEAM_KEYS = new Set(['role', 'reportsTo', 'delegatesTo', 'autoDelegation', 'trustFrom', 'tagline'])
const VAULT_REF_KEYS = new Set(['vault_ref'])
const VAULT_ID_RX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const ALLOW_FROM_RX = /^[A-Za-z0-9_-]{1,64}$/

const bad = (error: string, status = 400): SpecResult => ({ ok: false, status, error })
type Bad = { ok: false; status: number; error: string }
const unknownKey = (obj: Record<string, unknown>, allowed: Set<string>): string | undefined => Object.keys(obj).find((k) => !allowed.has(k))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isBad = (v: unknown): v is Bad => isObj(v) && v.ok === false

/**
 * Dani #2922 B1: who may name a vault entry in a spec. The requester must be one who may READ that entry: the floor
 * (never SSH material or the vault's sub-resources) and the allowlist, read strictly (the agent named by its own token,
 * or the name a shared-token caller claims, must be listed for the id; no claim, no entry). The owner's session passes.
 * A refused id and a missing one get the same answer, so the spec is not a way to learn which ids exist.
 */
export type VaultReadable = (id: string) => boolean

/** A { vault_ref } field -> its SecretRef (the value's sha256 at this moment), or the refusal. */
function secretRef(field: string, v: unknown, vaultReadable: VaultReadable): SecretRef | Bad {
  if (!isObj(v)) return { ok: false, status: 400, error: `${field} must be { vault_ref }: a secret is never sent as a value` }
  const te = unknownKey(v, VAULT_REF_KEYS)
  if (te !== undefined) return { ok: false, status: 400, error: `unknown field: ${field}.${te}` }
  if (typeof v.vault_ref !== 'string' || !VAULT_ID_RX.test(v.vault_ref)) return { ok: false, status: 400, error: `${field}.vault_ref must be a vault id` }
  const unusable: Bad = { ok: false, status: 400, error: `${field}.vault_ref cannot be used: ${v.vault_ref}` }
  if (!vaultReadable(v.vault_ref)) return unusable
  const value = getSecret(v.vault_ref)
  if (value === null || !value.trim()) return unusable
  return { vault_ref: v.vault_ref, value_sha256: sha256(value.trim()) }
}

const stringList = (field: string, v: unknown): string[] | Bad => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return { ok: false, status: 400, error: `${field} must be an array of strings` }
  return [...new Set(v as string[])]
}

/** An MCP server of this install, by name -> what the owner sees and the hash binds, or the refusal. */
export function specMcpEntry(name: string): SpecMcp | Bad {
  if (name.startsWith('plugin:')) return { ok: false, status: 400, error: `mcp: ${name} is a plugin connector, global to every agent: nothing to assign` }
  const found = findConnectorConfigWithSource(name)
  const cfg = found?.config
  if (!found || !isObj(cfg)) return { ok: false, status: 400, error: `mcp: no MCP server named ${name} on this install (a new server is added on the owner's dashboard)` }
  const str = (x: unknown) => (typeof x === 'string' ? x : null)
  return {
    name,
    type: str(cfg.type) ?? (typeof cfg.url === 'string' ? 'http' : 'stdio'),
    command: str(cfg.command),
    arg_count: Array.isArray(cfg.args) ? cfg.args.length : 0,
    url: typeof cfg.url === 'string' ? displayUrl(cfg.url) : null,
    env_keys: isObj(cfg.env) ? Object.keys(cfg.env).sort() : [],
    header_keys: isObj(cfg.headers) ? Object.keys(cfg.headers).sort() : [],
    source: found.source,
    source_agent_writable: found.agentWritable,
    config_sha256: sha256(canonicalJson(cfg)),
  }
}

/** The team block of a v2 spec, for the agent `name`: explicit values (no "keep the current one": the agent is new);
 *  a name the sanitizer would drop, or a reporting cycle, is refused. */
function specTeam(name: string, v: unknown): SpecTeam | Bad {
  if (!isObj(v)) return { ok: false, status: 400, error: 'team must be an object' }
  const tk = unknownKey(v, TEAM_KEYS)
  if (tk !== undefined) return { ok: false, status: 400, error: `unknown field: team.${tk}` }
  if (v.role !== undefined && v.role !== 'member' && v.role !== 'leader') return { ok: false, status: 400, error: 'team.role must be member or leader' }
  if (v.reportsTo !== undefined && v.reportsTo !== null && typeof v.reportsTo !== 'string') return { ok: false, status: 400, error: 'team.reportsTo must be a string or null' }
  if (v.autoDelegation !== undefined && typeof v.autoDelegation !== 'boolean') return { ok: false, status: 400, error: 'team.autoDelegation must be a boolean' }
  if (v.tagline !== undefined && v.tagline !== null && typeof v.tagline !== 'string') return { ok: false, status: 400, error: 'team.tagline must be a string or null' }
  const delegates = v.delegatesTo === undefined ? [] : stringList('team.delegatesTo', v.delegatesTo)
  if (isBad(delegates)) return delegates
  const trust = v.trustFrom === undefined ? [] : stringList('team.trustFrom', v.trustFrom)
  if (isBad(trust)) return trust
  const reportsTo = typeof v.reportsTo === 'string' ? (v.reportsTo.trim() || null) : null
  const team: SpecTeam = {
    role: v.role === 'leader' ? 'leader' : 'member',
    reports_to: reportsTo,
    delegates_to: delegates,
    auto_delegation: v.autoDelegation === true,
    trust_from: trust,
    tagline: typeof v.tagline === 'string' && v.tagline.trim() ? v.tagline.trim() : null,
  }
  const check = specTeamProblem(name, team)
  return check ? { ok: false, status: 400, error: check } : team
}

/** Why a spec's team block would not be written as the owner approved it (a dropped name, a cycle), or null. The
 *  consumer asks again before the create: a peer deleted in between refuses the create. */
export function specTeamProblem(name: string, team: SpecTeam): string | null {
  const { warnings } = sanitizeTeamConfig(name, { role: team.role, reportsTo: team.reports_to, delegatesTo: team.delegates_to, autoDelegation: team.auto_delegation, trustFrom: team.trust_from })
  if (warnings.droppedSelf.length) return `team: the agent cannot name itself (${warnings.droppedSelf.join(', ')})`
  if (warnings.droppedUnknown.length) return `team: unknown agent(s): ${warnings.droppedUnknown.join(', ')}`
  if (team.reports_to && reportsToCreatesCycle(name, team.reports_to, readAgentTeam, MAIN_AGENT_ID)) return `team: reportsTo ${team.reports_to} would make a reporting cycle`
  return null
}

/**
 * The request body -> the canonical spec, or the refusal. The model is resolved HERE (a request without one gets the
 * guarded install default now), so the owner approves the model that will be created, not one picked later.
 */
export async function canonicalAgentSpec(body: unknown, opts: { vaultReadable?: VaultReadable } = {}): Promise<SpecResult> {
  if (!isObj(body)) return bad('the spec must be a JSON object')
  const v2 = body.spec_version === 2
  const extra = unknownKey(body, v2 ? TOP_KEYS_V2 : TOP_KEYS)
  if (extra !== undefined) return bad(`unknown field: ${extra}`)
  if (!(AGENT_SPEC_VERSIONS as readonly unknown[]).includes(body.spec_version)) return bad(`spec_version must be one of: ${AGENT_SPEC_VERSIONS.join(', ')}`)
  for (const k of ['name', 'description'] as const) if (typeof body[k] !== 'string') return bad(`${k} must be a string`)
  for (const k of ['model', 'profile'] as const) if (body[k] !== undefined && typeof body[k] !== 'string') return bad(`${k} must be a string`)
  if (body.customProvider !== undefined && body.customProvider !== null && typeof body.customProvider !== 'string') return bad('customProvider must be a string or null')
  const displayName = (body.name as string).trim()
  const name = sanitizeAgentName(displayName)
  const description = (body.description as string)
  const rawModel = typeof body.model === 'string' ? body.model : ''
  const model = resolveModelId(rawModel || await launchableInstallDefault('agent-create', { fresh: true }))
  const profile = (typeof body.profile === 'string' ? body.profile : 'default').trim() || 'default'
  const customProvider = typeof body.customProvider === 'string' && body.customProvider.trim() ? body.customProvider.trim() : null
  // the same refusals, in the same order, that the create itself answers (agent-create.ts)
  const refusal = await checkAgentCreatable(name, model, customProvider, { requireDescription: true, description })
  if (refusal) return bad(String((refusal.body as { error?: unknown }).error ?? 'refused'), refusal.status)
  // an unknown profile would fall back to another one, which can widen the agent's permissions: refused here
  if (resolveProfileTemplate(profile).fallbackReason) return bad(`unknown security profile: ${profile}`)
  const readable = opts.vaultReadable ?? (() => false)
  const base: SpecBase = { name, display_name: displayName, description, model, profile, custom_provider: customProvider }
  if (!v2) {
    let channel: AgentSpecV1['channel'] = null
    if (body.channel !== undefined && body.channel !== null) {
      if (!isObj(body.channel)) return bad('channel must be an object')
      const ce = unknownKey(body.channel, CHANNEL_KEYS)
      if (ce !== undefined) return bad(`unknown field: channel.${ce}`)
      const provider = body.channel.provider
      if (typeof provider !== 'string' || !(SPEC_BOT_TOKEN_PROVIDERS as readonly string[]).includes(provider)) {
        return bad(`channel.provider must be one of: ${SPEC_BOT_TOKEN_PROVIDERS.join(', ')}`)
      }
      const tok = secretRef('channel.botToken', body.channel.botToken, readable)
      if (isBad(tok)) return tok
      channel = { provider: provider as SpecProvider, bot_token: tok }
    }
    return { ok: true, spec: { spec_version: 1, ...base, channel } }
  }

  let channel: AgentSpecV2['channel'] = null
  if (body.channel !== undefined && body.channel !== null) {
    const c = body.channel
    if (!isObj(c)) return bad('channel must be an object')
    const ce = unknownKey(c, CHANNEL_KEYS_V2)
    if (ce !== undefined) return bad(`unknown field: channel.${ce}`)
    const provider = c.provider
    if (typeof provider !== 'string' || !(SPEC_V2_PROVIDERS as readonly string[]).includes(provider)) {
      return bad(`channel.provider must be one of: ${SPEC_V2_PROVIDERS.join(', ')}`)
    }
    if (provider !== 'slack' && c.appToken !== undefined) return bad('channel.appToken is for slack only')
    if (provider !== 'discord' && c.channelId !== undefined) return bad('channel.channelId is for discord only')
    let channelId: string | null = null
    if (provider === 'discord') {
      if (typeof c.channelId !== 'string') return bad('channel.channelId is required for discord')
      const cid = validateDiscordChannelId(c.channelId)
      if (!cid.ok) return bad(`channel.channelId: ${cid.error ?? 'invalid'}`)
      channelId = c.channelId.trim()
    }
    // Slack's channel plugin needs the managed settings the owner installs with sudo: a request is refused before it
    // reaches the owner, never approved into a create that cannot set its channel up (Samu 81360, A)
    if (provider === 'slack' && !isManagedSettingsReady()) return bad('the Slack channel needs the managed settings set up on this machine first (the dashboard\'s Slack setup shows the command)', 409)
    let allowFrom: string[] = []
    if (c.allowFrom !== undefined) {
      if (!Array.isArray(c.allowFrom) || !c.allowFrom.every((x) => typeof x === 'string' && ALLOW_FROM_RX.test(x))) return bad('channel.allowFrom must be an array of user ids')
      allowFrom = [...new Set(c.allowFrom as string[])].sort()
    }
    const tok = secretRef('channel.botToken', c.botToken, readable)
    if (isBad(tok)) return tok
    let app: SecretRef | null = null
    if (provider === 'slack') {
      if (c.appToken === undefined) return bad('channel.appToken is required for slack')
      const a = secretRef('channel.appToken', c.appToken, readable)
      if (isBad(a)) return a
      app = a
    }
    channel = { provider: provider as SpecV2Provider, bot_token: tok, app_token: app, channel_id: channelId, allow_from: allowFrom }
  }
  let team: SpecTeam | null = null
  if (body.team !== undefined && body.team !== null) {
    const t = specTeam(name, body.team)
    if (isBad(t)) return t
    team = t
  }
  let mcp: SpecMcp[] = []
  if (body.mcp !== undefined) {
    const names = stringList('mcp', body.mcp)
    if (isBad(names)) return names
    const entries: SpecMcp[] = []
    for (const n of [...names].sort()) {
      const e = specMcpEntry(n)
      if (isBad(e)) return e
      entries.push(e)
    }
    mcp = entries
  }
  if (body.invite !== undefined && typeof body.invite !== 'boolean') return bad('invite must be a boolean')
  const invite = body.invite === true
  if (invite) {
    if (!channel) return bad('invite needs a channel')
    if (!(SPEC_INVITE_PROVIDERS as readonly string[]).includes(channel.provider)) return bad(`invite is available on: ${SPEC_INVITE_PROVIDERS.join(', ')}`)
    // an invite turns the channel's policy to pairing, which would widen an explicit allowFrom list
    if (channel.allow_from.length) return bad('invite and channel.allowFrom do not go together: an invite opens pairing')
  }
  return { ok: true, spec: { spec_version: 2, ...base, channel, team, mcp, invite } }
}

/** Sorted keys at every level, no whitespace: one byte string per spec. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function specHash(spec: AgentSpec): string {
  return sha256(canonicalJson(spec))
}

/**
 * The owner's text, rendered from the canonical spec and nothing else (never the requesting agent's own words beyond
 * the spec's fields). Every hashed field is a line; a secret is "set (vault: <id>)" only, an MCP server's environment
 * and headers by their keys only.
 */
export function renderAgentSpec(spec: AgentSpec, hash: string, lang: 'hu' | 'en'): string {
  const hu = lang === 'hu'
  const none = hu ? 'nincs' : 'none'
  const set = (r: SecretRef) => `${hu ? 'beállítva' : 'set'} (vault: ${r.vault_ref})`
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : none)
  const lines = [
    hu ? 'Új ügynök létrehozása, jóváhagyásra:' : 'Create a new agent, for approval:',
    `- ${hu ? 'azonosító' : 'id'}: ${spec.name}`,
    `- ${hu ? 'megjelenített név' : 'display name'}: ${spec.display_name}`,
    `- ${hu ? 'leírás' : 'description'}: ${spec.description}`,
    `- ${hu ? 'modell' : 'model'}: ${spec.model}`,
    `- ${hu ? 'biztonsági profil' : 'security profile'}: ${spec.profile}`,
    `- ${hu ? 'egyedi szolgáltató' : 'custom provider'}: ${spec.custom_provider ?? none}`,
  ]
  if (spec.spec_version === 1) {
    lines.push(spec.channel
      ? `- ${hu ? 'csatorna' : 'channel'}: ${spec.channel.provider}, ${hu ? 'bot-token' : 'bot token'}: ${set(spec.channel.bot_token)}`
      : `- ${hu ? 'csatorna' : 'channel'}: ${none}`)
  } else {
    const c = spec.channel
    if (!c) lines.push(`- ${hu ? 'csatorna' : 'channel'}: ${none}`)
    else {
      lines.push(`- ${hu ? 'csatorna' : 'channel'}: ${c.provider}, ${hu ? 'bot-token' : 'bot token'}: ${set(c.bot_token)}`)
      if (c.app_token) lines.push(`- ${hu ? 'Slack app-token' : 'Slack app token'}: ${set(c.app_token)}`)
      if (c.channel_id) lines.push(`- ${hu ? 'Discord-csatorna' : 'Discord channel'}: ${c.channel_id}`)
      lines.push(c.allow_from.length
        ? `- ${hu ? 'beengedett azonosítók (kódos párosítás nélkül)' : 'ids let in (no code pairing)'}: ${c.allow_from.join(', ')}`
        : `- ${hu ? 'beengedett azonosítók' : 'ids let in'}: ${none}${hu ? ' (kódos párosítás nem történt; a dashboardon párosítható)' : ' (no code pairing done; pair on the dashboard)'}`)
    }
    const t = spec.team
    if (!t) lines.push(`- ${hu ? 'csapat' : 'team'}: ${hu ? 'alapértelmezett (tag, senkinek nem jelent, nincs megbízott társ)' : 'default (member, reports to nobody, no trusted peers)'}`)
    else {
      lines.push(`- ${hu ? 'csapat-szerep' : 'team role'}: ${t.role}`)
      if (t.role === 'leader') lines.push(`- ${hu ? 'FIGYELEM: a vezető szerep tágabb biztonsági profilt ad' : 'NOTE: the leader role gives a wider security profile'}`)
      lines.push(`- ${hu ? 'kinek jelent' : 'reports to'}: ${t.reports_to ?? none}`)
      lines.push(`- ${hu ? 'kiknek delegálhat' : 'delegates to'}: ${list(t.delegates_to)}`)
      lines.push(`- ${hu ? 'automatikus delegálás' : 'auto-delegation'}: ${t.auto_delegation ? (hu ? 'be' : 'on') : (hu ? 'ki' : 'off')}`)
      lines.push(`- ${hu ? 'megbízott társak (kiknek az üzenetét fogadja el)' : 'trusted peers (whose messages it accepts)'}: ${list(t.trust_from)}`)
      lines.push(`- ${hu ? 'mottó' : 'tagline'}: ${t.tagline ?? none}`)
    }
    if (!spec.mcp.length) lines.push(`- ${hu ? 'MCP-szerverek' : 'MCP servers'}: ${none}`)
    for (const m of spec.mcp) {
      const what = m.url ?? (m.command ? `${m.command}${m.arg_count ? ` (${m.arg_count} ${hu ? 'argumentum, rejtve' : (m.arg_count === 1 ? 'argument, hidden' : 'arguments, hidden')})` : ''}` : none)
      const parts = [
        `- MCP: ${m.name} (${m.type}): ${what}`,
        m.env_keys.length ? `env (${hu ? 'az értékek rejtve' : 'values hidden'}): ${m.env_keys.join(', ')}` : null,
        m.header_keys.length ? `header (${hu ? 'az értékek rejtve' : 'values hidden'}): ${m.header_keys.join(', ')}` : null,
        `${hu ? 'forrás' : 'source'}: ${m.source}${m.source_agent_writable ? (hu ? ' (EZT A FÁJLT ÜGYNÖK IS ÍRHATJA)' : ' (AN AGENT CAN WRITE THIS FILE)') : ''}`,
        `${hu ? 'konfig' : 'config'} ${m.config_sha256.slice(0, 8)}`,
      ]
      lines.push(parts.filter(Boolean).join('; '))
    }
    lines.push(`- ${hu ? 'meghívó' : 'invite'}: ${spec.invite ? (hu ? 'kiállítva a létrehozás után; a link csak a dashboardon látszik' : 'issued after the create; the link is shown on the dashboard only') : none}`)
  }
  lines.push(`- ${hu ? 'spec-verzió' : 'spec version'}: ${spec.spec_version}`)
  lines.push(`- ${hu ? 'ellenőrző kód' : 'check code'}: ${hash.slice(0, 8)}`)
  return lines.join('\n')
}

const secretUnchanged = (r: SecretRef): boolean => {
  const value = getSecret(r.vault_ref)
  return value !== null && sha256(value.trim()) === r.value_sha256
}

/** The consumer's re-check: the stored JSON still hashes to the approved hash, and each secret still has its value. */
export function recheckStoredSpec(specJson: string, approvedHash: string): { ok: true; spec: AgentSpec } | { ok: false; reason: string } {
  let spec: AgentSpec
  try { spec = JSON.parse(specJson) as AgentSpec } catch { return { ok: false, reason: 'spec_unreadable' } }
  if (canonicalJson(spec) !== specJson) return { ok: false, reason: 'spec_not_canonical' }
  if (sha256(specJson) !== approvedHash) return { ok: false, reason: 'hash_mismatch' }
  if (!(AGENT_SPEC_VERSIONS as readonly unknown[]).includes(spec.spec_version)) return { ok: false, reason: 'spec_version' }
  if (spec.channel) {
    if (!secretUnchanged(spec.channel.bot_token)) return { ok: false, reason: 'vault_value_changed' }
    if (spec.spec_version === 2 && spec.channel.app_token && !secretUnchanged(spec.channel.app_token)) return { ok: false, reason: 'vault_value_changed' }
  }
  if (spec.spec_version === 2) {
    for (const m of spec.mcp) {
      const now = specMcpEntry(m.name)
      if (isBad(now) || now.config_sha256 !== m.config_sha256 || now.source !== m.source) return { ok: false, reason: `mcp_config_changed:${m.name}` }
    }
    if (spec.team) {
      const p = specTeamProblem(spec.name, spec.team)
      if (p) return { ok: false, reason: 'team_changed' }
    }
  }
  return { ok: true, spec }
}
