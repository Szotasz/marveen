import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const tmpRoot = mkdtempSync(join(tmpdir(), 'slack-smoke-'))

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: tmpRoot }))

const { tryHandleAgents } = await import('../web/routes/agents.js')

const STALL_MAX_MS = 750

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}

function makeAgent(name: string): void {
  mkdirSync(join(tmpRoot, 'agents', name, '.claude', 'channels', 'slack'), { recursive: true })
  writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), JSON.stringify({ channelProvider: 'slack' }))
  writeFileSync(join(tmpRoot, 'agents', name, '.claude', 'channels', 'slack', '.env'), 'SLACK_SMOKE_TEST_ALLOWED=true\n')
}

async function call(name: string): Promise<{ status: number; json: any }> {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([]), { headers: {} })
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { out = b ?? '' },
  }
  const url = new URL('http://localhost' + `/api/agents/${encodeURIComponent(name)}/channels/slack/smoke-test`)
  await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url } as any, tmpRoot)
  return { status, json: out ? JSON.parse(out) : null }
}

beforeAll(() => {
  mkdirSync(join(tmpRoot, 'scripts'), { recursive: true })
  writeFileSync(join(tmpRoot, 'scripts', 'smoke-test-slack-channel.sh'), [
    'if [ -n "$FAKE_READ_STDIN" ]; then cat > /dev/null; fi',
    'if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi',
    "printf 'name=%s allowed=%s\\n' \"$1\" \"$SLACK_SMOKE_TEST_ALLOWED\"",
    'if [ -n "$FAKE_FAIL" ]; then echo "to-stderr" >&2; exit 3; fi',
    'exit 0',
    '',
  ].join('\n'))
})

afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_FAIL
  delete process.env.FAKE_READ_STDIN
})

describe('slack smoke-test route', () => {
  it('instrument positive control: a synchronous busy-wait is measured', async () => {
    const stall = await stallDuring(async () => { const e = Date.now() + 300; while (Date.now() < e) { /* spin */ } })
    expect(stall).toBeGreaterThanOrEqual(250)
  })

  it('succeeds without stalling the event loop', async () => {
    makeAgent('smoke-ok')
    process.env.FAKE_SLEEP = '1.5'
    const t0 = Date.now()
    let r!: { status: number; json: any }
    const stall = await stallDuring(async () => { r = await call('smoke-ok') })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, output: 'name=smoke-ok allowed=true\n' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('reports a failing script', async () => {
    makeAgent('smoke-fail')
    process.env.FAKE_FAIL = '1'
    const r = await call('smoke-fail')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: false, output: 'name=smoke-fail allowed=true\nto-stderr\n' })
  })

  it('passes the agent name verbatim, never through a shell', async () => {
    const name = 'smoke-$(printf x)'
    makeAgent(name)
    const r = await call(name)
    expect(r.status).toBe(200)
    expect(r.json.output).toBe(`name=${name} allowed=true\n`)
  })

  it('closes stdin', async () => {
    makeAgent('smoke-stdin')
    process.env.FAKE_READ_STDIN = '1'
    const t0 = Date.now()
    const r = await call('smoke-stdin')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('keeps the guards answering before any script runs', async () => {
    expect((await call('smoke-missing')).status).toBe(404)
    makeAgent('smoke-noflag')
    writeFileSync(join(tmpRoot, 'agents', 'smoke-noflag', '.claude', 'channels', 'slack', '.env'), 'OTHER=1\n')
    expect((await call('smoke-noflag')).status).toBe(403)
  })
})
