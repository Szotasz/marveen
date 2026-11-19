// AGENTCREATEPR2B-1119: spec version 2 (Samu 81360). The Slack and Discord channel, the allowFrom list (the pairing of a
// spec), the team block, MCP servers already on the install, the invite. Validated before anything is stored (a request
// the owner should not be asked about is refused, never trimmed in silence), canonical, hashed, rendered from the same
// object (every hashed field is in the text; secrets only as "set (vault: <id>)", an MCP server's environment and
// headers by key only), and re-checked by the consumer (a swapped app token, a changed MCP config, a team name gone).
// The vault, the agent directory, the agent list, the managed settings and the MCP lookup are stand-ins.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(), root: '', agents: [] as string[], managed: true,
  mcp: new Map<string, unknown>(),
  mcpSource: new Map<string, string>(),
  mcpWritable: new Set<string>(),
}))
h.root = mkdtempSync(join(tmpdir(), 'agent-spec-v2-'))
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

vi.mock('../web/vault.js', async (orig) => ({
  ...(await orig<typeof import('../web/vault.js')>()),
  getSecret: (id: string) => h.vault.get(id) ?? null,
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  agentDir: (name: string) => join(h.root, name),
  listAgentNames: () => [...h.agents],
}))
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null }),
}))
vi.mock('../web/default-model-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/default-model-guard.js')>()),
  launchableInstallDefault: async () => 'claude-sonnet-5',
}))
vi.mock('../web/routes/agents.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/agents.js')>()),
  isManagedSettingsReady: () => h.managed,
}))
vi.mock('../web/routes/connectors.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/connectors.js')>()),
  findConnectorConfig: (name: string) => h.mcp.get(name) ?? null,
  findConnectorConfigWithSource: (name: string) => (h.mcp.has(name) ? { config: h.mcp.get(name), source: h.mcpSource.get(name) ?? `agents/samu/.mcp.json`, agentWritable: h.mcpWritable.has(name) } : null),
}))

const { canonicalAgentSpec, canonicalJson, specHash, renderAgentSpec, recheckStoredSpec } = await import('../web/agent-create-spec.js')
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const SLACK_BOT = ['xox', 'b-1-fake-fake-fake'].join('')
const SLACK_APP = ['xap', 'p-1-fake-fake-fake'].join('')
const DISCORD = ['MTA', 'fake.fake.fake'].join('')
const MCP_ENV_VALUE = ['sk', '-mcp-fake-value'].join('')
const GH = { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: MCP_ENV_VALUE } }
const WEB = { type: 'http', url: 'https://mcp.example.invalid/x', headers: { Authorization: 'Bearer ' + MCP_ENV_VALUE } }
const base = { spec_version: 2, name: 'Új Ügynök', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default' }
const READ = { vaultReadable: (id: string) => id !== 'NEM-OLVASHATO' }
const slack = { provider: 'slack', botToken: { vault_ref: 'SL-BOT' }, appToken: { vault_ref: 'SL-APP' } }
const discord = { provider: 'discord', botToken: { vault_ref: 'DC-BOT' }, channelId: '123456789012345678' }
const team = (t: Record<string, unknown>) => ({ ...base, team: t })

beforeEach(() => {
  h.vault = new Map([['SL-BOT', SLACK_BOT], ['SL-APP', SLACK_APP], ['DC-BOT', DISCORD], ['TG-BOT', '1:fake']])
  h.agents = ['samu', 'dani', 'geri']
  h.managed = true
  h.mcp = new Map<string, unknown>([['github', GH], ['web', WEB]])
  h.mcpSource = new Map()
  h.mcpWritable = new Set()
  rmSync(h.root, { recursive: true, force: true })
  mkdirSync(h.root, { recursive: true })
})
const ok = async (body: unknown) => {
  const r = await canonicalAgentSpec(body, READ)
  if (!r.ok) throw new Error(`${r.status} ${r.error}`)
  if (r.spec.spec_version !== 2) throw new Error('not v2')
  return r.spec
}

describe('spec version 2: the canonical object', () => {
  it('a full Slack spec: both tokens as SecretRefs, allowFrom sorted and de-duplicated, team, MCP entries sorted by name, invite off', async () => {
    const spec = await ok({ ...base, channel: { ...slack, allowFrom: ['U2', 'U1', 'U2'] }, team: { role: 'member', reportsTo: 'samu', delegatesTo: ['dani'], autoDelegation: true, trustFrom: ['samu', 'dani'], tagline: ' piac ' }, mcp: ['web', 'github'] })
    expect(spec.channel).toEqual({ provider: 'slack', bot_token: { vault_ref: 'SL-BOT', value_sha256: sha(SLACK_BOT) }, app_token: { vault_ref: 'SL-APP', value_sha256: sha(SLACK_APP) }, channel_id: null, allow_from: ['U1', 'U2'] })
    expect(spec.team).toEqual({ role: 'member', reports_to: 'samu', delegates_to: ['dani'], auto_delegation: true, trust_from: ['samu', 'dani'], tagline: 'piac' })
    expect(spec.mcp.map((m) => m.name)).toEqual(['github', 'web'])
    expect(spec.mcp[0]).toEqual({ name: 'github', type: 'stdio', command: 'npx', arg_count: 2, url: null, env_keys: ['GITHUB_TOKEN'], header_keys: [], source: 'agents/samu/.mcp.json', source_agent_writable: false, config_sha256: sha(canonicalJson(GH)) })
    expect(spec.mcp[1]).toMatchObject({ name: 'web', type: 'http', command: null, url: WEB.url, env_keys: [], header_keys: ['Authorization'] })
    expect(spec.invite).toBe(false)
  })
  it('Discord: the channel id is kept; no team block and no MCP give null and []', async () => {
    const spec = await ok({ ...base, channel: discord })
    expect(spec.channel).toMatchObject({ provider: 'discord', channel_id: '123456789012345678', app_token: null, allow_from: [] })
    expect(spec.team).toBeNull()
    expect(spec.mcp).toEqual([])
  })
  it('a team block with only some fields gets explicit defaults (the agent is new: nothing to keep)', async () => {
    expect((await ok(team({ role: 'leader' }))).team).toEqual({ role: 'leader', reports_to: null, delegates_to: [], auto_delegation: false, trust_from: [], tagline: null })
  })
  it('an invite on Telegram or Slack without allowFrom', async () => {
    expect((await ok({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT' } }, invite: true })).invite).toBe(true)
    expect((await ok({ ...base, channel: slack, invite: true })).invite).toBe(true)
  })
})

describe('spec version 2: refused before anything is stored', () => {
  it.each([
    [{ ...base, channel: { provider: 'slack', botToken: { vault_ref: 'SL-BOT' } } }, 400, 'channel.appToken is required for slack'],
    [{ ...base, channel: { ...slack, appToken: { vault_ref: 'NEM-OLVASHATO' } } }, 400, 'channel.appToken.vault_ref cannot be used: NEM-OLVASHATO'],
    [{ ...base, channel: { ...slack, appToken: { vault_ref: 'NINCS' } } }, 400, 'channel.appToken.vault_ref cannot be used: NINCS'],
    [{ ...base, channel: { ...slack, appToken: SLACK_APP } }, 400, 'channel.appToken must be { vault_ref }: a secret is never sent as a value'],
    [{ ...base, channel: { provider: 'discord', botToken: { vault_ref: 'DC-BOT' } } }, 400, 'channel.channelId is required for discord'],
    [{ ...base, channel: { ...discord, channelId: 'general' } }, 400, null],
    [{ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT' }, appToken: { vault_ref: 'SL-APP' } } }, 400, 'channel.appToken is for slack only'],
    [{ ...base, channel: { ...slack, channelId: '123456789012345678' } }, 400, 'channel.channelId is for discord only'],
    [{ ...base, channel: { ...slack, allowFrom: ['ok', 'not ok'] } }, 400, 'channel.allowFrom must be an array of user ids'],
    [{ ...base, channel: { ...slack, allowFrom: 'U1' } }, 400, 'channel.allowFrom must be an array of user ids'],
    [{ ...base, channel: { provider: 'teams', botToken: { vault_ref: 'TG-BOT' } } }, 400, 'channel.provider must be one of: telegram, slack, discord'],
    [team({ role: 'boss' }), 400, 'team.role must be member or leader'],
    [team({ reportsTo: 'ghost' }), 400, 'team: unknown agent(s): ghost'],
    [team({ trustFrom: ['samu', 'ghost'] }), 400, 'team: unknown agent(s): ghost'],
    [team({ delegatesTo: ['uj-ugynok'] }), 400, 'team: the agent cannot name itself (delegatesTo)'],
    [team({ delegatesTo: 'samu' }), 400, 'team.delegatesTo must be an array of strings'],
    [team({ secret: 1 }), 400, 'unknown field: team.secret'],
    [{ ...base, mcp: ['nincs-ilyen'] }, 400, 'mcp: no MCP server named nincs-ilyen on this install (a new server is added on the owner\'s dashboard)'],
    [{ ...base, mcp: ['plugin:slack'] }, 400, 'mcp: plugin:slack is a plugin connector, global to every agent: nothing to assign'],
    [{ ...base, mcp: 'github' }, 400, 'mcp must be an array of strings'],
    [{ ...base, invite: true }, 400, 'invite needs a channel'],
    [{ ...base, channel: discord, invite: true }, 400, 'invite is available on: telegram, slack'],
    [{ ...base, channel: { ...slack, allowFrom: ['U1'] }, invite: true }, 400, 'invite and channel.allowFrom do not go together: an invite opens pairing'],
    [{ ...base, invite: 'yes' }, 400, 'invite must be a boolean'],
  ])('%j -> %i', async (body, status, error) => {
    const r = await canonicalAgentSpec(body, READ)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(status)
    if (error !== null) expect(r.error).toBe(error)
  })
  it('Slack without the managed settings on this machine: 409 before the owner is asked', async () => {
    h.managed = false
    const r = await canonicalAgentSpec({ ...base, channel: slack }, READ)
    expect(r).toMatchObject({ ok: false, status: 409 })
    h.managed = true
    expect((await canonicalAgentSpec({ ...base, channel: { provider: 'telegram', botToken: { vault_ref: 'TG-BOT' } } }, READ)).ok).toBe(true)
  })
  it('a reportsTo that would make a reporting cycle', async () => {
    mkdirSync(join(h.root, 'samu'), { recursive: true })
    writeFileSync(join(h.root, 'samu', 'agent-config.json'), JSON.stringify({ team: { role: 'member', reportsTo: 'uj-ugynok' } }))
    const r = await canonicalAgentSpec(team({ reportsTo: 'samu' }), READ)
    expect(r).toEqual({ ok: false, status: 400, error: 'team: reportsTo samu would make a reporting cycle' })
  })
})

describe('spec version 2: the owner\'s text and the hash', () => {
  const full = { ...base, channel: { ...slack, allowFrom: ['U1'] }, team: { role: 'leader', reportsTo: 'samu', delegatesTo: ['dani'], autoDelegation: true, trustFrom: ['geri'], tagline: 'piac' }, mcp: ['github', 'web'] }
  it('every hashed field is in the text; no secret value, no secret sha, no MCP env or header value', async () => {
    const spec = await ok(full)
    const hash = specHash(spec)
    for (const lang of ['hu', 'en'] as const) {
      const text = renderAgentSpec(spec, hash, lang)
      for (const v of ['slack', 'vault: SL-BOT', 'vault: SL-APP', 'U1', 'leader', 'samu', 'dani', 'geri', 'piac', 'github', 'npx (2 ', 'GITHUB_TOKEN', 'web', WEB.url, 'Authorization', 'agents/samu/.mcp.json', spec.mcp[0].config_sha256.slice(0, 8), hash.slice(0, 8)]) {
        expect(text, `${lang}: ${v}`).toContain(v)
      }
      for (const secret of [SLACK_BOT, SLACK_APP, MCP_ENV_VALUE, spec.channel!.bot_token.value_sha256.slice(0, 8), spec.channel!.app_token!.value_sha256.slice(0, 8)]) {
        expect(text).not.toContain(secret)
      }
    }
    expect(renderAgentSpec(spec, hash, 'hu')).toContain('FIGYELEM: a vezető szerep tágabb biztonsági profilt ad')
    expect(renderAgentSpec(spec, hash, 'en')).toContain('NOTE: the leader role gives a wider security profile')
  })
  it('the text says when no code pairing was done, and that the invite link is on the dashboard only', async () => {
    const hu = renderAgentSpec(await ok({ ...base, channel: slack, invite: true }), 'x'.repeat(64), 'hu')
    expect(hu).toContain('kódos párosítás nem történt')
    expect(hu).toContain('a link csak a dashboardon látszik')
  })
  it('the hash changes with each v2 field', async () => {
    const spec = await ok(full)
    const h0 = specHash(spec)
    for (const changed of [
      { ...spec, invite: true },
      { ...spec, mcp: spec.mcp.slice(1) },
      { ...spec, team: { ...spec.team!, trust_from: [] } },
      { ...spec, channel: { ...spec.channel!, allow_from: [] } },
      { ...spec, channel: { ...spec.channel!, app_token: { vault_ref: 'SL-APP', value_sha256: sha('other') } } },
      { ...spec, mcp: [{ ...spec.mcp[0], config_sha256: sha('other') }, spec.mcp[1]] },
      { ...spec, mcp: [{ ...spec.mcp[0], source: 'agents/dani/projects/p/.mcp.json' }, spec.mcp[1]] },
    ]) expect(specHash(changed)).not.toBe(h0)
  })
})

describe('Dani #2940 B1/n1: an MCP server\'s secrets reach neither the stored spec nor the text', () => {
  const QS = ['qsec', 'ret-value'].join(''), AS = ['asec', 'ret-value'].join(''), UP = ['upa', 'ss'].join(''), FR = ['frag', 'sec'].join('')
  const LEAKY = { type: 'http', url: `https://user:${UP}@mcp.example.invalid/v1/sse?api_key=${QS}#${FR}`, command: 'node', args: ['--token', AS, 'server.js'], env: { NODE_OPTIONS: AS } }
  it('the URL keeps its origin and path only, the arguments are counted, env and header values are absent', async () => {
    h.mcp.set('leaky', LEAKY)
    const spec = await ok({ ...base, mcp: ['leaky'] })
    expect(spec.mcp[0]).toMatchObject({ url: 'https://mcp.example.invalid/v1/sse', arg_count: 3, command: 'node', env_keys: ['NODE_OPTIONS'] })
    const stored = canonicalJson(spec)
    for (const lang of ['hu', 'en'] as const) {
      const text = renderAgentSpec(spec, specHash(spec), lang)
      for (const secret of [QS, AS, UP, FR, 'api_key', 'user:']) {
        expect(stored, `stored: ${secret}`).not.toContain(secret)
        expect(text, `${lang}: ${secret}`).not.toContain(secret)
      }
    }
    expect(renderAgentSpec(spec, 'x'.repeat(64), 'hu')).toContain('env (az értékek rejtve): NODE_OPTIONS')
    expect(renderAgentSpec(spec, 'x'.repeat(64), 'en')).toContain('env (values hidden): NODE_OPTIONS')
  })
  it('a key in the URL path (hosted MCP services: /s/<key>/mcp) is masked in the stored spec and the text; short segments stay', async () => {
    const PK = ['pk', 'AbCdEf0123456789_-xyz'].join('')
    h.mcp.set('hosted', { type: 'http', url: `https://mcp.example.invalid/api/mcp/s/${PK}/mcp` })
    const spec = await ok({ ...base, mcp: ['hosted'] })
    expect(spec.mcp[0].url).toBe('https://mcp.example.invalid/api/mcp/s/***/mcp')
    expect(canonicalJson(spec)).not.toContain(PK)
    for (const lang of ['hu', 'en'] as const) expect(renderAgentSpec(spec, specHash(spec), lang)).not.toContain(PK)
    // a 15-character segment is not a key by this rule, and stays readable
    h.mcp.set('short', { type: 'http', url: 'https://mcp.example.invalid/v1/abcdefghijklmno/sse' })
    expect((await ok({ ...base, mcp: ['short'] })).mcp[0].url).toBe('https://mcp.example.invalid/v1/abcdefghijklmno/sse')
  })
  it('the source file is in the text, marked when an agent can write it', async () => {
    h.mcpSource.set('github', 'agents/dani/projects/p/.mcp.json')
    h.mcpWritable.add('github')
    const spec = await ok({ ...base, mcp: ['github'] })
    expect(spec.mcp[0]).toMatchObject({ source: 'agents/dani/projects/p/.mcp.json', source_agent_writable: true })
    expect(renderAgentSpec(spec, 'x'.repeat(64), 'hu')).toContain('forrás: agents/dani/projects/p/.mcp.json (EZT A FÁJLT ÜGYNÖK IS ÍRHATJA)')
    expect(renderAgentSpec(spec, 'x'.repeat(64), 'en')).toContain('source: agents/dani/projects/p/.mcp.json (AN AGENT CAN WRITE THIS FILE)')
    h.mcpWritable.clear()
    expect(renderAgentSpec(await ok({ ...base, mcp: ['github'] }), 'x'.repeat(64), 'hu')).not.toContain('ÍRHATJA')
  })
})

describe('spec version 2: the consumer\'s re-check', () => {
  const stored = async (body: unknown) => { const spec = await ok(body); const json = canonicalJson(spec); return { json, hash: sha(json) } }
  it('unchanged: ok', async () => {
    const s = await stored({ ...base, channel: slack, team: { trustFrom: ['samu'] }, mcp: ['github'] })
    expect(recheckStoredSpec(s.json, s.hash)).toMatchObject({ ok: true })
  })
  it('a swapped Slack app token: vault_value_changed', async () => {
    const s = await stored({ ...base, channel: slack })
    h.vault.set('SL-APP', 'xapp-swapped')
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'vault_value_changed' })
  })
  it('an MCP server whose config changed, or that is gone: mcp_config_changed', async () => {
    const s = await stored({ ...base, mcp: ['github'] })
    h.mcp.set('github', { ...GH, command: 'curl' })
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'mcp_config_changed:github' })
    h.mcp.delete('github')
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'mcp_config_changed:github' })
    // the same config, now found in another file first (a shadow server): refused too
    h.mcp.set('github', GH)
    h.mcpSource.set('github', 'agents/dani/projects/p/.mcp.json')
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'mcp_config_changed:github' })
  })
  it('a trusted peer deleted since the approval: team_changed', async () => {
    const s = await stored(team({ trustFrom: ['geri'] }))
    h.agents = ['samu', 'dani']
    expect(recheckStoredSpec(s.json, s.hash)).toEqual({ ok: false, reason: 'team_changed' })
  })
})
