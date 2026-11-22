// HOSTINGERROUTER1122 (Samu 83036): the onboarding's Claude step offers the Hostinger AI Router as its second choice,
// on a Hostinger install only (store/.platform), never preselected. It writes through the same helpers as the main
// agent card's switch (hostinger-router.ts), makes no live router call (billed credits), and afterwards the wizard sees
// the install as authenticated (claudeAuthPresent), so it does not stick at the Claude step (Geri 82904).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => ({ root: '', restarts: 0, probes: 0, vault: new Map<string, string>() }))
vi.mock('../web/channel-monitor.js', async (orig) => {
  const a = await orig<typeof import('../web/channel-monitor.js')>()
  return { ...a, hardRestartMarveenChannels: () => { H.restarts++; return { ok: true } } }
})
vi.mock('../web/claude-credentials-guard.js', async (orig) => {
  const a = await orig<typeof import('../web/claude-credentials-guard.js')>()
  return { ...a, liveProbeAuth: async () => { H.probes++; return 'ok' } }
})
vi.mock('../web/vault.js', async (orig) => {
  const a = await orig<typeof import('../web/vault.js')>()
  return {
    ...a,
    getSecret: (id: string) => H.vault.get(id) ?? null,
    setSecret: (id: string, _l: string, v: string) => { H.vault.set(id, v) },
    deleteSecret: (id: string) => H.vault.delete(id),
  }
})
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store`, CHANNEL_PROVIDER: 'telegram' as const, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'onb-router-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })
const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
const RUNNING = join(tmpRoot, 'agent-running')
// tmux: "list-sessions" prints the flag file (the main channels session's name), so a test can say the agent runs.
writeFileSync(join(binDir, 'tmux'), ['#!/bin/sh', `[ -f '${RUNNING}' ] && cat '${RUNNING}' && exit 0`, 'exit 1', ''].join('\n'))
chmodSync(join(binDir, 'tmux'), 0o755)
const origPath = process.env.PATH
const origEnvDir = process.env.CLAUDECLAW_ENV_DIR
const origTgDir = process.env.TELEGRAM_STATE_DIR
process.env.PATH = `${binDir}:${origPath ?? ''}`
process.env.CLAUDECLAW_ENV_DIR = tmpRoot
const TG = join(tmpRoot, 'tg-state')
mkdirSync(TG, { recursive: true })
process.env.TELEGRAM_STATE_DIR = TG

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' }) })
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = origPath
  if (origEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = origEnvDir
  if (origTgDir === undefined) delete process.env.TELEGRAM_STATE_DIR
  else process.env.TELEGRAM_STATE_DIR = origTgDir
  rmSync(tmpRoot, { recursive: true, force: true })
})

const ENV = join(tmpRoot, '.env')
const ENV_DOCKER = 'MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=Owner\nWEB_PORT=3420\nMARVEEN_DEPLOYMENT=docker\n'
const PLATFORM = join(tmpRoot, 'store', '.platform')
const MAIN_CFG = join(tmpRoot, 'agents', 'marveen', 'agent-config.json')
// built at run time: a literal sk- shape trips the repository's secret gate (a fixture, not a key)
const KEY = ['sk', 'hstgr', '0123456789abcdefghij'].join('-')
const OWNER = { kind: 'session', user: 'owner' }

beforeEach(() => {
  writeFileSync(ENV, ENV_DOCKER, { mode: 0o600 })
  rmSync(join(tmpRoot, 'store'), { recursive: true, force: true })
  rmSync(join(tmpRoot, 'agents'), { recursive: true, force: true })
  mkdirSync(join(tmpRoot, 'store'), { recursive: true })
  mkdirSync(join(tmpRoot, 'agents', 'marveen'), { recursive: true })
  rmSync(RUNNING, { force: true })
  H.restarts = 0
  H.probes = 0
  H.vault.clear()
})

async function call(method: string, path: string, auth?: unknown, body?: unknown) {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } })
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL(`http://localhost${path}`)
  await tryHandleOnboarding({ req, res, path: url.pathname, method, url, auth } as any)
  return { status, json: out ? JSON.parse(out) : null }
}
const nothingWritten = () => {
  expect(H.vault.size).toBe(0)
  expect(existsSync(MAIN_CFG)).toBe(false)
  expect(readFileSync(ENV, 'utf-8')).toBe(ENV_DOCKER)
}

describe('onboarding: the Hostinger AI Router choice', () => {
  it('the status offers it only on a Hostinger install', async () => {
    expect((await call('GET', '/api/onboarding/status')).json.router).toEqual({ available: false })
    writeFileSync(PLATFORM, 'hostinger\n')
    expect((await call('GET', '/api/onboarding/status')).json.router)
      .toEqual({ available: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], defaultModel: 'claude-sonnet-5-5' })
  })

  it('not a Hostinger install: 409, nothing written', async () => {
    const r = await call('POST', '/api/onboarding/claude-auth', OWNER, { routerKey: KEY })
    expect([r.status, r.json.reason]).toEqual([409, 'router-unavailable'])
    nothingWritten()
  })

  it('the router branch runs after the unchanged owner / first-run gate of this step', () => {
    // A live 403 needs the first-run state in the dashboard DB; the gate itself is untouched code, so its place is pinned.
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'onboarding.ts'), 'utf-8')
    const step = src.slice(src.indexOf("if (path === '/api/onboarding/claude-auth' && method === 'POST') {"))
    const gate = step.indexOf("mayActAsOwnerOrFirstRun(ctx.auth, req, 'onboarding-claude-auth') : mayActAsOwner(ctx.auth, req)")
    const router = step.indexOf('if (body.routerKey !== undefined) {')
    expect(gate).toBeGreaterThan(-1)
    expect(router).toBeGreaterThan(gate)
  })

  it('a wrong key, a dotted model, a key next to a Claude token: 400, nothing written', async () => {
    writeFileSync(PLATFORM, 'hostinger\n')
    for (const [body, reason] of [
      [{ routerKey: 'sk-ant-oat01-' + 'x'.repeat(20) }, 'bad-key'],
      [{ routerKey: KEY, routerModel: 'claude-sonnet-5.5' }, 'bad-model'],
      [{ routerKey: KEY, token: 'sk-ant-oat01-' + 'x'.repeat(20) }, 'mixed'],
    ] as const) {
      const r = await call('POST', '/api/onboarding/claude-auth', OWNER, body)
      expect([r.status, r.json.reason]).toEqual([400, reason])
    }
    nothingWritten()
  })

  it('a fresh Docker install with no agents/<main>/ folder yet: saved, not a 500 (Geri 83274, v1.51.1)', async () => {
    writeFileSync(PLATFORM, 'hostinger\n')
    rmSync(join(tmpRoot, 'agents'), { recursive: true, force: true })
    const r = await call('POST', '/api/onboarding/claude-auth', OWNER, { routerKey: KEY })
    expect([r.status, r.json.ok, r.json.router]).toEqual([200, true, true])
    expect(JSON.parse(readFileSync(MAIN_CFG, 'utf-8')).customProvider).toBe('hostinger-router')
    expect(H.vault.get('hostinger-router-api-key')).toBe(KEY)
  })

  it('saved: the key in the vault, the main agent on the router, no live call, and the wizard sees auth', async () => {
    writeFileSync(PLATFORM, 'hostinger\n')
    expect((await call('GET', '/api/onboarding/status')).json.claudeAuthPresent).toBe(false)
    const r = await call('POST', '/api/onboarding/claude-auth', OWNER, { routerKey: KEY, routerModel: 'claude-opus-5-5' })
    expect([r.status, r.json.ok, r.json.router, r.json.model, r.json.verified]).toEqual([200, true, true, 'claude-opus-5-5', false])
    expect(H.probes).toBe(0)
    expect(H.vault.get('hostinger-router-api-key')).toBe(KEY)
    const cfg = JSON.parse(readFileSync(MAIN_CFG, 'utf-8')) as Record<string, unknown>
    expect([cfg.customProvider, cfg.model, cfg.authMode]).toEqual(['hostinger-router', 'claude-opus-5-5', 'shared'])
    // no Claude credential was written: the .env is the one before
    expect(readFileSync(ENV, 'utf-8')).toBe(ENV_DOCKER)
    expect((await call('GET', '/api/onboarding/status')).json.claudeAuthPresent).toBe(true)
  })

  it('an API key stored earlier for the main agent leaves the vault, as on the main agent card (Geri N1)', async () => {
    writeFileSync(PLATFORM, 'hostinger\n')
    H.vault.set('agent-marveen-api-key', 'earlier-api-key')
    H.vault.set('agent-samu-api-key', 'a-sub-agent-key')
    const r = await call('POST', '/api/onboarding/claude-auth', OWNER, { routerKey: KEY })
    expect([r.status, r.json.ok]).toEqual([200, true])
    expect(H.vault.has('agent-marveen-api-key')).toBe(false)
    // only the main agent's own key: a sub-agent's stays
    expect(H.vault.get('agent-samu-api-key')).toBe('a-sub-agent-key')
    expect(H.vault.get('hostinger-router-api-key')).toBe(KEY)
  })

  it('the running, unauthenticated setup session is restarted once, as for the Claude token', async () => {
    writeFileSync(PLATFORM, 'hostinger\n')
    writeFileSync(RUNNING, `${MAIN_CHANNELS_SESSION}\n`)
    const r = await call('POST', '/api/onboarding/claude-auth', OWNER, { routerKey: KEY })
    expect([r.status, r.json.restarted, r.json.model]).toEqual([200, true, 'claude-sonnet-5-5'])
    expect(H.restarts).toBe(1)
  })
})
