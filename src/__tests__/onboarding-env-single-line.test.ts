import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// ENVINJECT1028: the onboarding routes write .env one KEY=value line at a time.
// A value carrying a line break would add a line of the caller's choosing, so
// such a value is refused before the live probe and before any write.

const H = vi.hoisted(() => ({ root: '' }))

vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, CHANNEL_PROVIDER: 'telegram' as const }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})
// The dashboard-login count the credential gate reads (0 = first run, before any login exists).
const U = vi.hoisted(() => ({ users: 0 }))
vi.mock('../db.js', async (orig) => {
  const a = await orig<typeof import('../db.js')>()
  return { ...a, countDashboardUsers: () => U.users }
})
const L = vi.hoisted(() => ({
  create: vi.fn(() => 'started' as const),
  restart: vi.fn(() => ({ ok: true })),
}))
vi.mock('../web/channel-monitor.js', async (orig) => {
  const a = await orig<typeof import('../web/channel-monitor.js')>()
  return { ...a, createMainChannelsSession: L.create, hardRestartMarveenChannels: L.restart }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'onb-envline-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'store-dir'), { recursive: true })
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })
const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
// tmux: no session, no auth in its environment.
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\ncase "$1" in show-environment) printf "HOME=/x\\n"; exit 0;; has-session) exit 1;; *) exit 0;; esac\n')
chmodSync(join(binDir, 'tmux'), 0o755)
// claude: a probe that neither succeeds nor looks like an auth failure (inconclusive).
const probeLog = join(tmpRoot, 'claude.log')
writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho probe >> "${probeLog}"\necho "something unexpected" >&2\nexit 1\n`)
chmodSync(join(binDir, 'claude'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath ?? ''}`

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' }) })
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = origPath
  rmSync(tmpRoot, { recursive: true, force: true })
})

const envFile = join(tmpRoot, '.env')
beforeEach(() => {
  writeFileSync(envFile, 'MAIN_AGENT_ID=marveen\n')
  rmSync(probeLog, { force: true })
  U.users = 0
})

async function post(path: string, body: unknown, auth: unknown = { kind: 'token' }) {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} })
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL(`http://localhost${path}`)
  await tryHandleOnboarding({ req, res, path: url.pathname, method: 'POST', url, auth } as any)
  return { status, json: out ? JSON.parse(out) : null }
}

describe('onboarding .env writes are single-line (ENVINJECT1028)', () => {
  it.each([
    ['token', { token: 'sk-ant-oat01-abc\nINJECTED_KEY=1' }],
    ['token (CR)', { token: 'sk-ant-oat01-abc\rINJECTED_KEY=1' }],
    ['apiKey', { apiKey: 'sk-ant-api03-abc\nINJECTED_KEY=1' }],
  ])('a %s with a line break is refused, nothing is probed or written', async (_name, body) => {
    const r = await post('/api/onboarding/claude-auth', body)
    expect(r.status).toBe(400)
    const env = readFileSync(envFile, 'utf-8')
    expect(env).not.toMatch(/INJECTED_KEY/)
    expect(env).toBe('MAIN_AGENT_ID=marveen\n')
    expect(existsSync(probeLog)).toBe(false)
  })
})

describe('claude-auth needs the owner once a dashboard login exists (ENVINJECT1028)', () => {
  it('the shared token alone is refused after the first login, nothing is probed or written', async () => {
    U.users = 1
    const r = await post('/api/onboarding/claude-auth', { token: 'sk-ant-oat01-abc' })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('owner_session_required')
    expect(readFileSync(envFile, 'utf-8')).toBe('MAIN_AGENT_ID=marveen\n')
    expect(existsSync(probeLog)).toBe(false)
  })

  it('the first-run wizard (no login yet) still saves with the token', async () => {
    const r = await post('/api/onboarding/claude-auth', { token: 'sk-ant-oat01-abc' })
    expect(r.status).toBe(200)
    expect(existsSync(probeLog)).toBe(true)
    expect(readFileSync(envFile, 'utf-8')).toMatch(/^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc$/m)
  })

  it('an owner session saves after the first login', async () => {
    U.users = 1
    const r = await post('/api/onboarding/claude-auth', { token: 'sk-ant-oat01-abc' }, { kind: 'session' })
    expect(r.status).toBe(200)
  })

  it('no auth context at all is refused', async () => {
    const r = await post('/api/onboarding/claude-auth', { token: 'sk-ant-oat01-abc' }, null)
    expect(r.status).toBe(403)
  })
})

describe('every onboarding .env write goes through the single-line check (ENVINJECT1028)', () => {
  it('setEnvKey checks the entry before it reads or writes the file', () => {
    const src = readFileSync(new URL('../web/routes/onboarding.ts', import.meta.url), 'utf-8')
    expect(src).toContain('function setEnvKey(key: string, value: string): void {\n  assertEnvEntry(key, value)\n')
  })

  it('assertEnvEntry refuses a line break, a NUL and a non-identifier key', async () => {
    const { assertEnvEntry } = await import('../env.js')
    expect(() => assertEnvEntry('A', 'x\ny')).toThrow()
    expect(() => assertEnvEntry('A', 'x\ry')).toThrow()
    expect(() => assertEnvEntry('A', 'x\0y')).toThrow()
    expect(() => assertEnvEntry('A B', 'x')).toThrow()
    expect(() => assertEnvEntry('OWNER_NAME', 'Kiss Anna')).not.toThrow()
  })
})
