// TOKENSWAPRESTART1123 (b): the claude-auth save starts the fleet restart only on a real token swap.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// ---- the route: POST /api/onboarding/claude-auth --------------------------------------------------------------------
const H = vi.hoisted(() => ({ root: '', swaps: 0, probe: 'ok' as 'ok' | 'inconclusive', notices: [] as string[] }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, CHANNEL_PROVIDER: 'telegram' as const }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})
vi.mock('../web/claude-credentials-guard.js', async (orig) => {
  const a = await orig<typeof import('../web/claude-credentials-guard.js')>()
  return { ...a, liveProbeAuth: async () => H.probe, stampTokenVerified: () => undefined }
})
vi.mock('../web/fleet-token-swap-restart.js', async (orig) => {
  const a = await orig<typeof import('../web/fleet-token-swap-restart.js')>()
  return { ...a, restartFleetAfterTokenSwap: async () => { H.swaps++; return null } }
})
vi.mock('../notify.js', async (orig) => {
  const a = await orig<typeof import('../notify.js')>()
  return { ...a, notifyOwner: async (t: string) => { H.notices.push(t); return true } }
})
vi.mock('../web/channel-monitor.js', async (orig) => {
  const a = await orig<typeof import('../web/channel-monitor.js')>()
  return { ...a, hardRestartMarveenChannels: () => ({ ok: true }) }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-swap-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'store-dir'), { recursive: true })
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })
const FLEET = join(tmpRoot, 'store-dir', '.claude-oauth-token')
const ENV = join(tmpRoot, '.env')

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' }) })
afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); rmSync(tmpRoot, { recursive: true, force: true }) })
beforeEach(() => { H.swaps = 0; H.probe = 'ok'; H.notices.length = 0 })

async function save(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ token }))]), { headers: {} })
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL('http://localhost/api/onboarding/claude-auth')
  await tryHandleOnboarding({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session', user: 'owner' } } as never)
  return { status: status || 200, body: out ? JSON.parse(out) as Record<string, unknown> : {} }
}

describe('POST /api/onboarding/claude-auth and the fleet restart', () => {
  it('a NEW token on an install that had one: the shared-token agents are restarted (in the background)', async () => {
    writeFileSync(ENV, 'MAIN_AGENT_ID=marveen\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\n')
    writeFileSync(FLEET, 'sk-ant-oat01-old')
    const r = await save('sk-ant-oat01-new')
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true)
    expect(readFileSync(FLEET, 'utf-8')).toBe('sk-ant-oat01-new')
    expect(r.body.fleetRestart, JSON.stringify(r.body)).toBe(true)
    expect(H.swaps).toBe(1)
  })
  it('the SAME token pasted again: no restart', async () => {
    writeFileSync(ENV, 'MAIN_AGENT_ID=marveen\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-same\n')
    writeFileSync(FLEET, 'sk-ant-oat01-same')
    const r = await save('sk-ant-oat01-same')
    expect(r.body.fleetRestart).toBe(false)
    expect(H.swaps).toBe(0)
  })
  it('the first token of an install (no fleet token before): no fleet restart (the existing first-auth path covers it)', async () => {
    writeFileSync(ENV, 'MAIN_AGENT_ID=marveen\n')
    rmSync(FLEET, { force: true })
    const r = await save('sk-ant-oat01-first')
    expect(r.body.fleetRestart).toBe(false)
    expect(H.swaps).toBe(0)
  })
  it('a new token the probe could NOT verify: no fleet restart, the owner is told instead (Dani F1)', async () => {
    writeFileSync(ENV, 'MAIN_AGENT_ID=marveen\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\n')
    writeFileSync(FLEET, 'sk-ant-oat01-old')
    H.probe = 'inconclusive'
    const r = await save('sk-ant-oat01-unproven')
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true)
    expect(r.body.fleetRestart).toBe(false)
    expect(H.swaps).toBe(0)
    await new Promise((res) => setTimeout(res, 0))
    expect(H.notices.some((n) => n.includes('NEM indítottam újra'))).toBe(true)
  })
})
