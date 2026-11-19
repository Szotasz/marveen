// AGENTCREATEPR2B-1119: the consumer of a spec version 2 approval, end to end at the server. After the create, through
// the code the owner-session routes use: the team block, the MCP servers, the channel (app token, channel id, allowFrom),
// the invite; in that order (the channel restarts the agent). Negative controls: an MCP config changed before the
// consume (refused, nothing created) and between the create and its write (the agent stays, nothing further runs), a
// Slack app token swapped, a team name gone, a failed invite; the invite's link is never in an alert or a log line.
// The DB is in memory; the create, the team write, the server lookup and write, the channel setup and the invite are
// recorders (their own behaviour is pinned by the characterization files).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  root: '',
  steps: [] as string[],
  channelInputs: [] as Array<[string, string, Record<string, unknown>]>,
  teamInputs: [] as Array<[string, Record<string, unknown>]>,
  teamAnswer: null as null | Record<string, unknown>,
  mcp: new Map<string, unknown>(),
  mcpSource: new Map<string, string>(),
  mcpWritable: new Set<string>(),
  mcpWrites: [] as Array<[string, string, unknown]>,
  inviteAnswer: { status: 200, body: { token: 'INVITE-SECRET-TOKEN-0001', link: 'https://t.me/x?start=INVITE-SECRET-TOKEN-0001' } as Record<string, unknown> },
  alerts: [] as string[],
  logs: [] as string[],
  onCreate: null as null | (() => void),
  acl: {} as Record<string, string[]>,
  agents: ['samu', 'dani'] as string[],
}))
h.root = mkdtempSync(join(tmpdir(), 'agent-create-v2-'))
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

vi.mock('../web/vault.js', async (orig) => ({ ...(await orig<typeof import('../web/vault.js')>()), getSecret: (id: string) => h.vault.get(id) ?? null }))
vi.mock('../web/agent-config.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-config.js')>()), agentDir: (n: string) => join(h.root, n), listAgentNames: () => [...h.agents] }))
vi.mock('../web/claude-cli-version.js', async (orig) => ({ ...(await orig<typeof import('../web/claude-cli-version.js')>()), measureClaudeCliVersion: async () => ({ version: null }) }))
vi.mock('../web/default-model-guard.js', async (orig) => ({ ...(await orig<typeof import('../web/default-model-guard.js')>()), launchableInstallDefault: async () => 'claude-sonnet-5' }))
vi.mock('../web/agent-create.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-create.js')>()),
  createAgentFromSpec: async (data: Record<string, unknown>) => { h.steps.push('create'); h.onCreate?.(); return { status: 200, body: { ok: true, name: data.name } } },
}))
vi.mock('../web/routes/agents.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/agents.js')>()),
  isManagedSettingsReady: () => true,
  applyAgentTeam: (name: string, data: Record<string, unknown>) => {
    h.steps.push('team'); h.teamInputs.push([name, data])
    return h.teamAnswer ?? { ok: true, team: {}, tagline: '', warnings: { droppedSelf: [], droppedUnknown: [] }, cycleRejected: false }
  },
  setupAgentChannel: async (name: string, provider: string, data: Record<string, unknown>) => { h.steps.push('channel'); h.channelInputs.push([name, provider, data]); return { status: 200, body: { ok: true } } },
  issueAgentChannelInvite: async () => { h.steps.push('invite'); return h.inviteAnswer },
}))
vi.mock('../web/routes/connectors.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/connectors.js')>()),
  findConnectorConfig: (name: string) => h.mcp.get(name) ?? null,
  findConnectorConfigWithSource: (name: string) => (h.mcp.has(name) ? { config: h.mcp.get(name), source: h.mcpSource.get(name) ?? `agents/samu/.mcp.json`, agentWritable: h.mcpWritable.has(name) } : null),
  writeConnectorIntoAgent: (agent: string, name: string, cfg: unknown) => { h.steps.push(`mcp:${name}`); h.mcpWrites.push([agent, name, cfg]) },
}))
vi.mock('../web/vault-acl.js', async (orig) => ({ ...(await orig<typeof import('../web/vault-acl.js')>()), readVaultAcl: () => h.acl }))
vi.mock('../settings-store.js', async (orig) => ({ ...(await orig<typeof import('../settings-store.js')>()), getEffectiveSettingValue: (k: string) => (k === 'AGENT_CREATE_VIA_APPROVAL' ? 'on' : '') }))
vi.mock('../db.js', async (orig) => {
  const real = await orig<typeof import('../db.js')>()
  return { ...real, createAgentMessage: (_f: string, _t: string, text: string) => { h.alerts.push(text); return 0 as never } }
})
vi.mock('../logger.js', async (orig) => {
  const real = await orig<typeof import('../logger.js')>()
  const rec = (lvl: string) => (...a: unknown[]) => { h.logs.push(`${lvl} ${JSON.stringify(a)}`) }
  return { ...real, logger: { ...real.logger, info: rec('info'), warn: rec('warn'), error: rec('error') } }
})

const db = await import('../db.js')
const { tryHandleApprovals } = await import('../web/routes/approvals.js')
const { registerAgentCreateConsumer } = await import('../web/agent-create-approval.js')
registerAgentCreateConsumer()

const SL_BOT = ['xox', 'b-fake-bot'].join('')
const SL_APP = ['xap', 'p-fake-app'].join('')
const DC_BOT = ['MTA', 'fake.dc'].join('')
const GH = { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: ['gh', 'p_fake'].join('') } }
const OWNER = { channel: 'teams', mode: 'card' } as const
const SLACK_SPEC = {
  spec_version: 2, name: 'Kutato', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default',
  channel: { provider: 'slack', botToken: { vault_ref: 'SL-BOT' }, appToken: { vault_ref: 'SL-APP' } },
  team: { reportsTo: 'samu', trustFrom: ['samu', 'dani'], autoDelegation: true, tagline: 'piac' },
  mcp: ['github'], invite: true,
}

async function file(spec: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(spec))]) as unknown as http.IncomingMessage
  req.headers = { 'x-agent-id': 'samu' }
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const path = '/api/agent-specs'
  await tryHandleApprovals({ req, res, path, method: 'POST', url: new URL(`http://127.0.0.1:3420${path}`), auth: { kind: 'token', agent: 'samu' } } as any)
  expect(out.status).toBe(201)
  return out.body as { approvalId: string; contentHash: string }
}
const approve = async (b: { approvalId: string; contentHash: string }) => {
  expect(db.decideApproval({ approvalId: b.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: b.contentHash }).outcome).toBe('decided')
  await new Promise((r) => setTimeout(r, 20))
}
const outcome = (id: string) => (db.getDb().prepare('SELECT outcome FROM agent_create_specs WHERE approval_id = ?').get(id) as { outcome: string }).outcome

beforeEach(() => {
  db.initDatabase(':memory:')
  h.vault = new Map([['SL-BOT', SL_BOT], ['SL-APP', SL_APP], ['DC-BOT', DC_BOT]])
  h.acl = { 'SL-BOT': ['samu'], 'SL-APP': ['samu'], 'DC-BOT': ['samu'] }
  h.mcp = new Map([['github', GH]])
  h.mcpSource = new Map()
  h.mcpWritable = new Set()
  h.agents = ['samu', 'dani']
  for (const a of [h.steps, h.channelInputs, h.teamInputs, h.mcpWrites, h.alerts, h.logs]) a.length = 0
  h.teamAnswer = null
  h.onCreate = null
  h.inviteAnswer = { status: 200, body: { token: 'INVITE-SECRET-TOKEN-0001', link: 'https://t.me/x?start=INVITE-SECRET-TOKEN-0001' } }
})

describe('a version-2 approval, after the create', () => {
  it('a full Slack spec: the team, the server, the channel with both tokens, the invite, in that order; created; no alert', async () => {
    const b = await file(SLACK_SPEC)
    await approve(b)
    expect(h.steps).toEqual(['create', 'team', 'mcp:github', 'channel', 'invite'])
    expect(h.teamInputs).toEqual([['kutato', { role: 'member', reportsTo: 'samu', delegatesTo: [], autoDelegation: true, trustFrom: ['samu', 'dani'], tagline: 'piac' }]])
    expect(h.mcpWrites).toEqual([['kutato', 'github', GH]])
    expect(h.channelInputs).toEqual([['kutato', 'slack', { botToken: SL_BOT, appToken: SL_APP }]])
    expect(outcome(b.approvalId)).toBe('created')
    expect(h.alerts).toEqual([])
  })
  it('the invite\'s token and link are in no alert and no log line', async () => {
    const b = await file(SLACK_SPEC)
    await approve(b)
    expect(h.steps).toContain('invite')
    for (const line of [...h.alerts, ...h.logs]) expect(line).not.toContain('INVITE-SECRET-TOKEN-0001')
    expect(h.logs.some((l) => l.includes('the approved invite was issued'))).toBe(true)
  })
  it('Discord: the channel id and the allowFrom list reach the channel setup; no team block, no team write', async () => {
    const b = await file({ ...SLACK_SPEC, channel: { provider: 'discord', botToken: { vault_ref: 'DC-BOT' }, channelId: '123456789012345678', allowFrom: ['42'] }, team: undefined, mcp: undefined, invite: false })
    await approve(b)
    expect(h.steps).toEqual(['create', 'channel'])
    expect(h.channelInputs).toEqual([['kutato', 'discord', { botToken: DC_BOT, channelId: '123456789012345678', allowFrom: ['42'] }]])
    expect(outcome(b.approvalId)).toBe('created')
  })
  it('an MCP config changed after the approval, before the consume: refused, nothing created, alerted', async () => {
    const b = await file(SLACK_SPEC)
    h.mcp.set('github', { ...GH, command: 'curl' })
    await approve(b)
    expect(h.steps).toEqual([])
    expect(outcome(b.approvalId)).toBe('refused:mcp_config_changed:github')
    expect(h.alerts).toHaveLength(1)
  })
  it('an MCP config changed between the create and its write: the agent stays, no server, no channel, no invite, alerted', async () => {
    const b = await file(SLACK_SPEC)
    h.onCreate = () => { h.mcp.set('github', { ...GH, args: ['other'] }) }
    await approve(b)
    expect(h.steps).toEqual(['create', 'team'])
    expect(outcome(b.approvalId)).toBe('created_mcp_refused:github')
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).not.toContain(String(GH.env.GITHUB_TOKEN))
  })
  it('the Slack app token swapped between the consume and the channel: no channel, no invite, refused, alerted', async () => {
    const b = await file(SLACK_SPEC)
    h.onCreate = () => { h.vault.set('SL-APP', SL_APP + 'x') }
    await approve(b)
    expect(h.steps).toEqual(['create', 'team', 'mcp:github'])
    expect(outcome(b.approvalId)).toBe('created_channel_refused:vault_value_changed')
    expect(h.alerts[0]).toContain('SL-APP')
    expect(h.alerts[0]).not.toContain(SL_APP)
  })
  it('a team write that is not what was approved (a peer gone since): the agent stays, nothing further, alerted', async () => {
    const b = await file(SLACK_SPEC)
    h.teamAnswer = { ok: true, team: {}, tagline: '', warnings: { droppedSelf: [], droppedUnknown: ['dani'] }, cycleRejected: false }
    await approve(b)
    expect(h.steps).toEqual(['create', 'team'])
    expect(outcome(b.approvalId)).toBe('created_team_changed')
    expect(h.alerts).toHaveLength(1)
  })
  it('a peer deleted after the approval, before the consume: refused, nothing created', async () => {
    const b = await file(SLACK_SPEC)
    h.agents = ['samu']
    await approve(b)
    expect(h.steps).toEqual([])
    expect(outcome(b.approvalId)).toBe('refused:team_changed')
  })
  it('an invite that cannot be issued: the agent and its channel stay, the outcome names it, alerted', async () => {
    h.inviteAnswer = { status: 500, body: { error: 'Failed to create invite' } }
    const b = await file(SLACK_SPEC)
    await approve(b)
    expect(h.steps).toEqual(['create', 'team', 'mcp:github', 'channel', 'invite'])
    expect(outcome(b.approvalId)).toBe('created_invite_failed:500')
    expect(h.alerts).toHaveLength(1)
  })
})
