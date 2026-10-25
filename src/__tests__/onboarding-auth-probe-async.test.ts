import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, truncateSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const H = vi.hoisted(() => ({ root: '' }))

vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  // The provider is pinned: the identity case configures a telegram channel, whatever the checkout's own setting.
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, CHANNEL_PROVIDER: 'telegram' as const }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})

// The launch route must never start or restart a real fleet from a test: the
// two channel-session actions are fakes the launch-gate case can count.
const L = vi.hoisted(() => ({
  create: vi.fn(() => 'started' as const),
  restart: vi.fn(() => ({ ok: true })),
}))
vi.mock('../web/channel-monitor.js', async (orig) => {
  const a = await orig<typeof import('../web/channel-monitor.js')>()
  return { ...a, createMainChannelsSession: L.create, hardRestartMarveenChannels: L.restart }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'onb-probe-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'store-dir'), { recursive: true })
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })

const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
writeFileSync(join(binDir, 'tmux'), `#!/bin/sh
printf 'start %s\\n' "$1" >> "$FAKE_TMUX_LOG"
case "$1" in
  show-environment)
    if [ -n "$FAKE_READ_STDIN" ]; then cat > /dev/null; fi
    if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"
    if [ -n "$FAKE_AUTH" ]; then printf 'HOME=/x\\nCLAUDE_CODE_OAUTH_TOKEN=abc\\n'; else printf 'HOME=/x\\n'; fi
    exit 0 ;;
  list-sessions)
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"
    printf '%s\\n' "$FAKE_SESSION"
    exit 0 ;;
  has-session)
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"
    if [ -n "$FAKE_SESSION" ]; then exit 0; fi
    exit 1 ;;
  *)
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"
    exit 0 ;;
esac
`)
chmodSync(join(binDir, 'tmux'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath ?? ''}`
const logFile = join(tmpRoot, 'tmux.log')
process.env.FAKE_TMUX_LOG = logFile
writeFileSync(logFile, '')

const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')
process.env.FAKE_SESSION = MAIN_CHANNELS_SESSION
const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
const { channelStateDirEnvVar } = await import('../channel-provider.js')
const { CHANNEL_PROVIDER } = await import('../config.js')

// On macOS the Keychain probe answers from the host's real Claude login before
// the tmux probe runs, so every case here would read "authenticated" (#2191
// review). These cases are about the tmux probe: the route sees Linux.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(async () => {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' })
  // The first exec of a freshly written script can be slow (seen on macOS), and
  // the route's synchronous list-sessions would pay it inside the stall case:
  // run the fake once before any case, its sleep included (0 s).
  await promisify(execFile)(join(binDir, 'tmux'), ['show-environment', '-g'], { env: { ...process.env, FAKE_SLEEP: '0' } })
  truncateSync(logFile, 0)
}, 30_000)

afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_AUTH
  delete process.env.FAKE_READ_STDIN
  truncateSync(logFile, 0)
  L.create.mockClear()
  L.restart.mockClear()
})
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = origPath
  rmSync(tmpRoot, { recursive: true, force: true })
})

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}
const STALL_MAX_MS = 750

async function call(method = 'GET', path = '/api/onboarding/status') {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([]), { headers: {} })
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { out = b ?? '' },
  }
  const url = new URL(`http://localhost${path}`)
  await tryHandleOnboarding({ req, res, path: url.pathname, method, url } as any)
  return { status, json: JSON.parse(out) }
}

async function callWithBody(method: string, path: string, body: unknown) {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} })
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { out = b ?? '' },
  }
  const url = new URL(`http://localhost${path}`)
  await tryHandleOnboarding({ req, res, path: url.pathname, method, url } as any)
  return { status, json: JSON.parse(out) }
}

describe('onboarding auth probes are async', () => {
  it('instrument positive control: sync busy-wait is detected', async () => {
    const stall = await stallDuring(async () => {
      const end = Date.now() + 300
      while (Date.now() < end) { /* spin */ }
    })
    expect(stall).toBeGreaterThanOrEqual(250)
  })

  it('reports an authenticated running session without stalling', async () => {
    process.env.FAKE_AUTH = '1'
    process.env.FAKE_SLEEP = '1.5'
    let r!: Awaited<ReturnType<typeof call>>
    const stall = await stallDuring(async () => { r = await call() })
    expect(r.status).toBe(200)
    expect(r.json.claudeAuthPresent).toBe(true)
    expect(readFileSync(logFile, 'utf-8')).toContain('start show-environment')
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('reads a running session without credentials as not authenticated', async () => {
    process.env.FAKE_SLEEP = '0'
    const r = await call()
    expect(r.json.claudeAuthPresent).toBe(false)
  })

  it('closes stdin of the probe', async () => {
    process.env.FAKE_AUTH = '1'
    process.env.FAKE_READ_STDIN = '1'
    const winner = await Promise.race([call(), sleep(5000).then(() => 'timeout' as const)])
    expect(winner).not.toBe('timeout')
    expect((winner as Awaited<ReturnType<typeof call>>).json.claudeAuthPresent).toBe(true)
  })

  it('launch: without Claude auth it answers 409 no-auth and starts nothing', async () => {
    // No channels session: the fleet is not running, and there is no session env to read.
    process.env.FAKE_SESSION = ''
    try {
      const r = await call('POST', '/api/onboarding/launch')
      expect(r.status).toBe(409)
      expect(r.json.reason).toBe('no-auth')
    } finally {
      process.env.FAKE_SESSION = MAIN_CHANNELS_SESSION
    }
    expect(L.create).not.toHaveBeenCalled()
    expect(L.restart).not.toHaveBeenCalled()
  })

  it('launch: with Claude auth and no running fleet it starts the fleet instead of answering 409', async () => {
    const envFile = join(tmpRoot, '.env')
    process.env.FAKE_SESSION = ''
    writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN=abc\n')
    try {
      const r = await call('POST', '/api/onboarding/launch')
      expect(r.status).toBe(200)
      expect(r.json.ok).toBe(true)
      expect(r.json.reason).toBeUndefined()
    } finally {
      rmSync(envFile, { force: true })
      process.env.FAKE_SESSION = MAIN_CHANNELS_SESSION
    }
    expect(L.create).toHaveBeenCalledTimes(1)
    expect(L.restart).not.toHaveBeenCalled()
  })

  it('identity: a rename mid-setup (no Claude auth, owner already paired) with the fleet up restarts the channels session', async () => {
    const envVar = channelStateDirEnvVar(CHANNEL_PROVIDER)
    const prevStateDir = process.env[envVar]
    const stateDir = join(tmpRoot, 'chan-state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ allowFrom: ['1'] }))
    writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
    process.env[envVar] = stateDir
    process.env.FAKE_SESSION = MAIN_CHANNELS_SESSION
    try {
      // Missing Claude auth must be the only fresh-setup signal: the channel is configured and the owner paired.
      const s = await call('GET', '/api/onboarding/status')
      expect(s.json.claudeAuthPresent).toBe(false)
      expect(s.json.channelConfigured).toBe(true)
      expect(s.json.paired).toBe(true)
      const r = await callWithBody('POST', '/api/onboarding/identity', { agentName: 'Newname', ownerName: 'Owner' })
      expect(r.status).toBe(200)
      expect(r.json.ok).toBe(true)
      expect(r.json.restarted).toBe(true)
      expect(r.json.restartNeeded).toBeUndefined()
    } finally {
      if (prevStateDir === undefined) delete process.env[envVar]
      else process.env[envVar] = prevStateDir
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(join(tmpRoot, '.env'), { force: true })
    }
    expect(L.restart).toHaveBeenCalledTimes(1)
    expect(L.create).not.toHaveBeenCalled()
  })
})
