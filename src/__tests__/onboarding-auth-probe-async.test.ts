import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, truncateSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const H = vi.hoisted(() => ({ root: '' }))

vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir` }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
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

afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_AUTH
  delete process.env.FAKE_READ_STDIN
  truncateSync(logFile, 0)
})
afterAll(() => {
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

async function call() {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([]), { headers: {} })
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { out = b ?? '' },
  }
  const url = new URL('http://localhost/api/onboarding/status')
  await tryHandleOnboarding({ req, res, path: url.pathname, method: 'GET', url } as any)
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
})
