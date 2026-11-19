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
// Spec version 1 carries what POST /api/agents takes plus the channel provider and its bot token (Samu 81152, A);
// the team rights, the invite, the pairing and the MCP servers come with a later version.
import { createHash } from 'node:crypto'
import { resolveModelId } from './agent-config.js'
import { sanitizeAgentName } from './sanitize.js'
import { resolveProfileTemplate } from './profiles.js'
import { getSecret } from './vault.js'
import { checkAgentCreatable } from './agent-create.js'
import { launchableInstallDefault } from './default-model-guard.js'

export const AGENT_SPEC_VERSION = 1
/** The channels whose setup is the bot token alone: Telegram. Slack also needs its app token and Discord a channel id,
 *  so both come with a later spec version together with those fields. */
export const SPEC_BOT_TOKEN_PROVIDERS = ['telegram'] as const
type SpecProvider = typeof SPEC_BOT_TOKEN_PROVIDERS[number]

export interface SecretRef { vault_ref: string; value_sha256: string }
export interface AgentSpecV1 {
  spec_version: 1
  name: string
  display_name: string
  description: string
  model: string
  profile: string
  custom_provider: string | null
  channel: { provider: SpecProvider; bot_token: SecretRef } | null
}

export type SpecResult = { ok: true; spec: AgentSpecV1 } | { ok: false; status: number; error: string }

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const TOP_KEYS = new Set(['spec_version', 'name', 'description', 'model', 'profile', 'customProvider', 'channel'])
const CHANNEL_KEYS = new Set(['provider', 'botToken'])
const VAULT_REF_KEYS = new Set(['vault_ref'])
const VAULT_ID_RX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

const bad = (error: string, status = 400): SpecResult => ({ ok: false, status, error })
const unknownKey = (obj: Record<string, unknown>, allowed: Set<string>): string | undefined => Object.keys(obj).find((k) => !allowed.has(k))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The request body -> the canonical spec, or the refusal. The model is resolved HERE (a request without one gets the
 * guarded install default now), so the owner approves the model that will be created, not one picked later.
 */
/**
 * Dani #2922 B1: who may name a vault entry in a spec. The requester must be one who may READ that entry: the floor
 * (never SSH material or the vault's sub-resources) and the allowlist, read strictly (the agent named by its own token,
 * or the name a shared-token caller claims, must be listed for the id; no claim, no entry). The owner's session passes.
 * A refused id and a missing one get the same answer, so the spec is not a way to learn which ids exist.
 */
export type VaultReadable = (id: string) => boolean

export async function canonicalAgentSpec(body: unknown, opts: { vaultReadable?: VaultReadable } = {}): Promise<SpecResult> {
  if (!isObj(body)) return bad('the spec must be a JSON object')
  const extra = unknownKey(body, TOP_KEYS)
  if (extra !== undefined) return bad(`unknown field: ${extra}`)
  if (body.spec_version !== AGENT_SPEC_VERSION) return bad(`spec_version must be ${AGENT_SPEC_VERSION}`)
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
  let channel: AgentSpecV1['channel'] = null
  if (body.channel !== undefined && body.channel !== null) {
    if (!isObj(body.channel)) return bad('channel must be an object')
    const ce = unknownKey(body.channel, CHANNEL_KEYS)
    if (ce !== undefined) return bad(`unknown field: channel.${ce}`)
    const provider = body.channel.provider
    if (typeof provider !== 'string' || !(SPEC_BOT_TOKEN_PROVIDERS as readonly string[]).includes(provider)) {
      return bad(`channel.provider must be one of: ${SPEC_BOT_TOKEN_PROVIDERS.join(', ')}`)
    }
    const tok = body.channel.botToken
    if (!isObj(tok)) return bad('channel.botToken must be { vault_ref }: a secret is never sent as a value')
    const te = unknownKey(tok, VAULT_REF_KEYS)
    if (te !== undefined) return bad(`unknown field: channel.botToken.${te}`)
    if (typeof tok.vault_ref !== 'string' || !VAULT_ID_RX.test(tok.vault_ref)) return bad('channel.botToken.vault_ref must be a vault id')
    const unusable = `channel.botToken.vault_ref cannot be used: ${tok.vault_ref}`
    if (!(opts.vaultReadable ?? (() => false))(tok.vault_ref)) return bad(unusable)
    const value = getSecret(tok.vault_ref)
    if (value === null || !value.trim()) return bad(unusable)
    channel = { provider: provider as SpecProvider, bot_token: { vault_ref: tok.vault_ref, value_sha256: sha256(value.trim()) } }
  }
  return { ok: true, spec: { spec_version: 1, name, display_name: displayName, description, model, profile, custom_provider: customProvider, channel } }
}

/** Sorted keys at every level, no whitespace: one byte string per spec. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function specHash(spec: AgentSpecV1): string {
  return sha256(canonicalJson(spec))
}

/**
 * The owner's text, rendered from the canonical spec and nothing else (never the requesting agent's own words beyond
 * the spec's fields). Every hashed field is a line; the secret is "set (vault: <id>)" only.
 */
export function renderAgentSpec(spec: AgentSpecV1, hash: string, lang: 'hu' | 'en'): string {
  const hu = lang === 'hu'
  const lines = [
    hu ? 'Új ügynök létrehozása, jóváhagyásra:' : 'Create a new agent, for approval:',
    `- ${hu ? 'azonosító' : 'id'}: ${spec.name}`,
    `- ${hu ? 'megjelenített név' : 'display name'}: ${spec.display_name}`,
    `- ${hu ? 'leírás' : 'description'}: ${spec.description}`,
    `- ${hu ? 'modell' : 'model'}: ${spec.model}`,
    `- ${hu ? 'biztonsági profil' : 'security profile'}: ${spec.profile}`,
    `- ${hu ? 'egyedi szolgáltató' : 'custom provider'}: ${spec.custom_provider ?? (hu ? 'nincs' : 'none')}`,
    spec.channel
      ? `- ${hu ? 'csatorna' : 'channel'}: ${spec.channel.provider}, ${hu ? 'bot-token' : 'bot token'}: ${hu ? 'beállítva' : 'set'} (vault: ${spec.channel.bot_token.vault_ref})`
      : `- ${hu ? 'csatorna' : 'channel'}: ${hu ? 'nincs' : 'none'}`,
    `- ${hu ? 'spec-verzió' : 'spec version'}: ${spec.spec_version}`,
    `- ${hu ? 'ellenőrző kód' : 'check code'}: ${hash.slice(0, 8)}`,
  ]
  return lines.join('\n')
}

/** The consumer's re-check: the stored JSON still hashes to the approved hash, and each secret still has its value. */
export function recheckStoredSpec(specJson: string, approvedHash: string): { ok: true; spec: AgentSpecV1 } | { ok: false; reason: string } {
  let spec: AgentSpecV1
  try { spec = JSON.parse(specJson) as AgentSpecV1 } catch { return { ok: false, reason: 'spec_unreadable' } }
  if (canonicalJson(spec) !== specJson) return { ok: false, reason: 'spec_not_canonical' }
  if (sha256(specJson) !== approvedHash) return { ok: false, reason: 'hash_mismatch' }
  if (spec.spec_version !== AGENT_SPEC_VERSION) return { ok: false, reason: 'spec_version' }
  if (spec.channel) {
    const value = getSecret(spec.channel.bot_token.vault_ref)
    if (value === null || sha256(value.trim()) !== spec.channel.bot_token.value_sha256) return { ok: false, reason: 'vault_value_changed' }
  }
  return { ok: true, spec }
}
