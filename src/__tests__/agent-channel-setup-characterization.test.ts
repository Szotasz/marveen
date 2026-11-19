// AGENTCREATEPR2-1119: characterization of POST /api/agents/:name/channels/telegram (the bot-token setup) BEFORE its
// body is lifted into setupAgentChannel, so the approved agent_create consumer sets a channel up through the same
// code. Behaviour only, through the route, with an owner session: the refusals (no token, a line break, an invalid
// token, a token another agent uses, a token busy elsewhere, a bad allowFrom), the writes (.env 0600, access.json,
// the provider, the enabled plugin), the welcome message, the restart of a running agent, and the answer bodies.
// Every channel directory (the main agent's too) is a temp folder: no real token file is read. The token check, the
// busy probe, the welcome message and the process lifecycle are recorders.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  root: '',
  calls: [] as Array<[string, ...unknown[]]>,
  validation: { ok: true, botName: 'TesztBot' } as { ok: boolean; botName?: string; error?: string },
  busy: { busy: false } as { busy: boolean; error?: string },
  agents: [] as string[],
  running: new Set<string>(),
}))
h.root = mkdtempSync(join(tmpdir(), 'channel-setup-char-'))
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })
const rec = (fn: string, ret?: unknown) => (...a: unknown[]) => { h.calls.push([fn, ...a]); return ret }

vi.mock('../channel-provider.js', async (orig) => ({
  ...(await orig<typeof import('../channel-provider.js')>()),
  channelStateDir: (p: string, dir?: string) => (dir ? join(dir, '.claude', 'channels', p) : join(h.root, '__main__', p)),
  getProvider: () => ({ validateToken: async (t: string) => { h.calls.push(['validateToken', t]); return h.validation } }),
  checkTelegramTokenBusy: async (t: string) => { h.calls.push(['checkTelegramTokenBusy', t]); return h.busy },
}))
vi.mock('../web/telegram.js', async (orig) => ({
  ...(await orig<typeof import('../web/telegram.js')>()),
  sendWelcomeMessage: (...a: unknown[]) => { h.calls.push(['sendWelcomeMessage', ...a]); return Promise.resolve() },
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  agentDir: (n: string) => join(h.root, n),
  listAgentNames: () => [...h.agents],
  writeAgentChannelProvider: rec('writeAgentChannelProvider'),
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  isAgentRunning: (n: string) => h.running.has(n),
  stopAgentProcess: async (n: string) => { h.calls.push(['stopAgentProcess', n]); return { ok: true } },
  startAgentProcess: async (n: string) => { h.calls.push(['startAgentProcess', n]); return { ok: true } },
  delay: async () => {},
}))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT } = await import('../config.js')

const TOKEN = ['7000001', ':AAF', 'fakefakefakefakefakefakefake1'].join('')
let n = 0
function agent(): string { const name = `chchar${n++}`; mkdirSync(join(h.root, name), { recursive: true }); return name }
const chDir = (name: string) => join(h.root, name, '.claude', 'channels', 'telegram')

async function setup(name: string, data: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(data))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const path = `/api/agents/${name}/channels/telegram`
  await tryHandleAgents({ req, res, path, method: 'POST', url: new URL(`http://127.0.0.1:3420${path}`), auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))
  return out
}
const names = () => h.calls.map((c) => c[0])

beforeEach(() => {
  h.calls.length = 0
  h.validation = { ok: true, botName: 'TesztBot' }
  h.busy = { busy: false }
  h.agents = []
  h.running = new Set()
})

describe('POST /api/agents/:name/channels/telegram: the refusals, before any write', () => {
  it('no token: 400', async () => {
    const a = agent()
    expect(await setup(a, {})).toEqual({ status: 400, body: { error: 'botToken is required' } })
    expect(names()).toEqual([])
  })
  it('a line break: 400, before the network check', async () => {
    const a = agent()
    expect(await setup(a, { botToken: `${TOKEN}\nX=1` })).toEqual({ status: 400, body: { error: 'A token nem tartalmazhat sortörést' } })
    expect(names()).toEqual([])
  })
  it('an allowFrom that is not a list of plain ids: 400', async () => {
    const a = agent()
    expect(await setup(a, { botToken: TOKEN, allowFrom: ['ok', 'not ok'] })).toEqual({ status: 400, body: { error: 'allowFrom must be a non-empty array of user ids' } })
  })
  it('an invalid token: 400 with the provider\'s error', async () => {
    const a = agent()
    h.validation = { ok: false, error: 'Unauthorized' }
    expect(await setup(a, { botToken: TOKEN })).toEqual({ status: 400, body: { error: 'Unauthorized' } })
    expect(existsSync(join(chDir(a), '.env'))).toBe(false)
  })
  it('a token another agent uses: 409 naming it', async () => {
    const a = agent(); const b = agent()
    h.agents = [a, b]
    mkdirSync(chDir(b), { recursive: true }); writeFileSync(join(chDir(b), '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    const r = await setup(a, { botToken: TOKEN })
    expect(r).toEqual({ status: 409, body: { error: `This bot token is already used by agent "${b}". Each agent needs its own bot token to avoid getUpdates conflicts.` } })
  })
  it('a token busy elsewhere: 409 with the probe\'s error; the probe is skipped for the token the agent already has', async () => {
    const a = agent()
    h.busy = { busy: true, error: 'busy: webhook set' }
    expect(await setup(a, { botToken: TOKEN })).toEqual({ status: 409, body: { error: 'busy: webhook set' } })
    mkdirSync(chDir(a), { recursive: true }); writeFileSync(join(chDir(a), '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    h.calls.length = 0
    expect((await setup(a, { botToken: TOKEN })).status).toBe(200)
    expect(names()).not.toContain('checkTelegramTokenBusy')
  })
})

describe('POST /api/agents/:name/channels/telegram: the writes and the answer', () => {
  it('a stopped agent: .env (0600) and a pairing access.json, the provider and the plugin, the welcome, no restart', async () => {
    const a = agent()
    const r = await setup(a, { botToken: ` ${TOKEN} ` })
    expect(r).toEqual({ status: 200, body: { ok: true, botName: 'TesztBot', restarted: false, wasRunning: false } })
    expect(readFileSync(join(chDir(a), '.env'), 'utf-8')).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    expect(statSync(join(chDir(a), '.env')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(chDir(a), 'access.json'), 'utf-8'))).toEqual({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
    expect(h.calls).toContainEqual(['writeAgentChannelProvider', a, 'telegram'])
    expect(JSON.parse(readFileSync(join(h.root, a, '.claude', 'settings.json'), 'utf-8')).enabledPlugins).toBeTruthy()
    expect(h.calls).toContainEqual(['sendWelcomeMessage', a, TOKEN])
    expect(names()).not.toContain('stopAgentProcess')
    expect(names().indexOf('validateToken')).toBeLessThan(names().indexOf('checkTelegramTokenBusy'))
  })
  it('a running agent: stopped and started again, restarted and wasRunning true', async () => {
    const a = agent()
    h.running = new Set([a])
    const r = await setup(a, { botToken: TOKEN })
    expect(r).toEqual({ status: 200, body: { ok: true, botName: 'TesztBot', restarted: true, wasRunning: true } })
    expect(names().filter((x) => x === 'stopAgentProcess' || x === 'startAgentProcess')).toEqual(['stopAgentProcess', 'startAgentProcess'])
  })
  it('an explicit allowFrom writes an allowlist, deduplicated', async () => {
    const a = agent()
    await setup(a, { botToken: TOKEN, allowFrom: ['111', '111', '222'] })
    expect(JSON.parse(readFileSync(join(chDir(a), 'access.json'), 'utf-8'))).toEqual({ dmPolicy: 'allowlist', allowFrom: ['111', '222'], groups: {}, pending: {} })
  })
  it('an unknown agent: 404', async () => {
    expect(await setup('nincs-ilyen-ugynok', { botToken: TOKEN })).toEqual({ status: 404, body: { error: 'Agent not found' } })
  })
})
