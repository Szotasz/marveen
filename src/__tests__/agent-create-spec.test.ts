// AGENTCREATEPR2-1119: the agent_create spec. Validated before anything is stored (unknown fields, types, the create's
// own refusals, the profile, the vault reference), canonical and versioned, hashed, and rendered for the owner from the
// SAME object: every hashed field is in the text, and the secret only as "set (vault: <id>)". The consumer's re-check
// catches a changed spec and a swapped vault value. The vault, the CLI probe and the agent directory are stand-ins.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({ vault: new Map<string, string>(), root: '' }))
h.root = mkdtempSync(join(tmpdir(), 'agent-spec-'))
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

vi.mock('../web/vault.js', async (orig) => ({
  ...(await orig<typeof import('../web/vault.js')>()),
  getSecret: (id: string) => h.vault.get(id) ?? null,
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  agentDir: (name: string) => join(h.root, name),
}))
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null }),
}))
vi.mock('../web/default-model-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/default-model-guard.js')>()),
  launchableInstallDefault: async () => 'claude-sonnet-5',
}))

const { canonicalAgentSpec, canonicalJson, specHash, renderAgentSpec, recheckStoredSpec } = await import('../web/agent-create-spec.js')
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const TOKEN = ['123456', ':AAH', 'fakefakefakefakefakefake'].join('')
const base = { spec_version: 1, name: 'Új Ügynök', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default' }

beforeEach(() => { h.vault = new Map([['TG-BOT-UJ', TOKEN]]) })
// the requester may read every id here except the ones named NEM-OLVASHATO (the route builds the real rule)
const READ = { vaultReadable: (id: string) => id !== 'NEM-OLVASHATO' }

describe('canonicalAgentSpec: validated before anything is stored', () => {
  it('a full spec: the id, the display name, the resolved model, the defaults, and the secret as a reference with its sha256', async () => {
    const r = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT-UJ' } } }, READ)
    expect(r).toEqual({ ok: true, spec: {
      spec_version: 1, name: 'uj-ugynok', display_name: 'Új Ügynök', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default',
      custom_provider: null, channel: { provider: 'telegram', bot_token: { vault_ref: 'TG-BOT-UJ', value_sha256: sha(TOKEN) } },
    } })
  })

  it('no model: the guarded install default is resolved now, so the owner approves the model that will be created', async () => {
    const r = await canonicalAgentSpec({ spec_version: 1, name: 'x1', description: 'd' }, READ)
    expect(r.ok && r.spec.model).toBe('claude-sonnet-5')
  })

  it.each([
    [{ ...base, invite: 'x' }, 'unknown field: invite'],
    [{ ...base, spec_version: 3 }, 'spec_version must be one of: 1, 2'],
    [{ ...base, spec_version: undefined }, 'spec_version must be one of: 1, 2'],
    [{ ...base, team: {} }, 'unknown field: team'],
    [{ ...base, mcp: [] }, 'unknown field: mcp'],
    [{ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT' }, allowFrom: ['1'] } }, 'unknown field: channel.allowFrom'],
    [{ ...base, name: 7 }, 'name must be a string'],
    [{ ...base, model: 5 }, 'model must be a string'],
    [{ ...base, channel: { provider: 'telegram', botToken: TOKEN } }, 'channel.botToken must be { vault_ref }: a secret is never sent as a value'],
    [{ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT-UJ', value: TOKEN } } }, 'unknown field: channel.botToken.value'],
    [{ ...base, channel: { provider: 'teams', botToken: { vault_ref: 'TG-BOT-UJ' } } }, 'channel.provider must be one of: telegram'],
    [{ ...base, channel: { provider: 'slack', botToken: { vault_ref: 'TG-BOT-UJ' } } }, 'channel.provider must be one of: telegram'],
    [{ ...base, channel: { provider: 'discord', botToken: { vault_ref: 'TG-BOT-UJ' } } }, 'channel.provider must be one of: telegram'],
    [{ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'NINCS-ILYEN' } } }, 'channel.botToken.vault_ref cannot be used: NINCS-ILYEN'],
    [{ ...base, channel: { provider: 'telegram', botToken: { vault_ref: '../x' } } }, 'channel.botToken.vault_ref must be a vault id'],
    [{ ...base, channel: { provider: 'telegram', allowFrom: ['x'], botToken: { vault_ref: 'TG-BOT-UJ' } } }, 'unknown field: channel.allowFrom'],
    [{ ...base, profile: 'nincs-ilyen-profil' }, 'unknown security profile: nincs-ilyen-profil'],
    [{ ...base, description: '' }, 'Description is required'],
    [{ ...base, name: '' }, 'Name is required'],
  ])('refused with 400: %j', async (body, error) => {
    const r = await canonicalAgentSpec(body, READ)
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(400); expect(r.error).toBe(error) }
  })

  it('a create refusal keeps its own status (the main agent id: 409)', async () => {
    const { MAIN_AGENT_ID } = await import('../config.js')
    const r = await canonicalAgentSpec({ ...base, name: MAIN_AGENT_ID }, READ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })

  it('an id the requester may not read gets exactly the answer a missing id gets; no reader rule at all refuses every id', async () => {
    h.vault.set('NEM-OLVASHATO', TOKEN)
    const r = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'NEM-OLVASHATO' } } }, READ)
    expect(r).toEqual({ ok: false, status: 400, error: 'channel.botToken.vault_ref cannot be used: NEM-OLVASHATO' })
    const m = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'NINCS-ILYEN' } } }, READ)
    expect(m).toEqual({ ok: false, status: 400, error: 'channel.botToken.vault_ref cannot be used: NINCS-ILYEN' })
    const none = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT-UJ' } } })
    expect(none.ok).toBe(false)
  })

  it('an empty vault value is refused like a missing one', async () => {
    h.vault.set('URES', '  ')
    const r = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'URES' } } }, READ)
    expect(r).toEqual({ ok: false, status: 400, error: 'channel.botToken.vault_ref cannot be used: URES' })
  })
})

describe('canonical JSON, the hash and the owner text come from one object', () => {
  it('canonicalJson sorts keys at every level: the same spec in any key order is one byte string', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}')
  })

  it('every hashed field is in the text; the secret only as "set (vault: <id>)", never its value or sha256', async () => {
    const r = await canonicalAgentSpec({ ...base, customProvider: null, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT-UJ' } } }, READ)
    if (!r.ok) throw new Error(r.error)
    const hash = specHash(r.spec)
    for (const lang of ['hu', 'en'] as const) {
      const text = renderAgentSpec(r.spec, hash, lang)
      for (const v of [r.spec.name, r.spec.display_name, r.spec.description, r.spec.model, r.spec.profile, r.spec.channel!.provider, `vault: ${r.spec.channel!.bot_token.vault_ref}`, hash.slice(0, 8), String(r.spec.spec_version)]) {
        expect(text).toContain(v)
      }
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(r.spec.channel!.bot_token.value_sha256)
      expect(text).not.toContain(r.spec.channel!.bot_token.value_sha256.slice(0, 8))
    }
    expect(renderAgentSpec(r.spec, hash, 'hu')).toContain('bot-token: beállítva (vault: TG-BOT-UJ)')
    expect(renderAgentSpec(r.spec, hash, 'en')).toContain('bot token: set (vault: TG-BOT-UJ)')
  })

  it('the text has one line per spec field (a new field without a line fails here)', async () => {
    const r = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT-UJ' } } }, READ)
    if (!r.ok) throw new Error(r.error)
    expect(Object.keys(r.spec).sort()).toEqual(['channel', 'custom_provider', 'description', 'display_name', 'model', 'name', 'profile', 'spec_version'])
    expect(renderAgentSpec(r.spec, specHash(r.spec), 'hu').split('\n').filter((l) => l.startsWith('- '))).toHaveLength(Object.keys(r.spec).length + 1)
  })

  it('the hash is the sha256 of the canonical JSON; any field change changes it', async () => {
    const r = await canonicalAgentSpec(base, READ)
    if (!r.ok) throw new Error(r.error)
    expect(specHash(r.spec)).toBe(sha(canonicalJson(r.spec)))
    expect(specHash({ ...r.spec, profile: 'other' })).not.toBe(specHash(r.spec))
  })
})

describe('recheckStoredSpec: the consumer\'s re-check', () => {
  async function stored() {
    const r = await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT-UJ' } } }, READ)
    if (!r.ok) throw new Error(r.error)
    const json = canonicalJson(r.spec)
    return { json, hash: sha(json) }
  }
  it('passes on the stored spec and its hash', async () => {
    const s = await stored()
    expect(recheckStoredSpec(s.json, s.hash).ok).toBe(true)
  })
  it('a changed spec, a non-canonical one, or another hash: refused', async () => {
    const s = await stored()
    expect(recheckStoredSpec(s.json.replace('"default"', '"admin"'), s.hash)).toEqual({ ok: false, reason: 'hash_mismatch' })
    expect(recheckStoredSpec(JSON.stringify(JSON.parse(s.json), null, 1), s.hash)).toEqual({ ok: false, reason: 'spec_not_canonical' })
    expect(recheckStoredSpec('{', s.hash)).toEqual({ ok: false, reason: 'spec_unreadable' })
  })
  it('a vault value swapped after the approval: refused; a removed one too', async () => {
    const s = await stored()
    h.vault.set('TG-BOT-UJ', TOKEN + 'x')
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'vault_value_changed' })
    h.vault.delete('TG-BOT-UJ')
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'vault_value_changed' })
  })
})
