// WORKEROAUTHFILE behaviour: what the worker start actually does and does not do with its own setup-token
// setting. tmux, the host login reader and the channel alert are recorded, never run. Every token below is a
// FAKE value; no real credential is read or written.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rec = vi.hoisted(() => ({
  exec: [] as Array<[string, string[]]>,
  readLogin: 0,
  alerts: [] as string[],
  fakeHome: '',
  customProvider: false,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFileSync: vi.fn((file: string, args: string[]) => { rec.exec.push([file, args]); return '' }) }
})
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  return { ...real, homedir: () => rec.fakeHome || real.homedir() }
})
vi.mock('../web/claude-credentials.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/claude-credentials.js')>()
  return { ...real, readClaudeCodeOauthJson: vi.fn(() => { rec.readLogin++; return '{"fake":"host-login"}' }) }
})
vi.mock('../notify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../notify.js')>()
  return { ...real, notifyChannel: vi.fn(async (message: string) => { rec.alerts.push(message) }) }
})
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...real,
    buildCustomProviderLaunchEnv: vi.fn(() => (rec.customProvider
      ? { model: 'custom-model', envPrefix: 'export ANTHROPIC_BASE_URL=https://example.invalid; ', customApiKeyForApproval: null }
      : null)),
  }
})

import { makeWorkerCtx, startWorkerSessionFor, ensureWorkerReady } from '../web/agent-worker.js'

const FAKE_TOKEN = 'sk-ant-oat01-FAKE-worker-token-for-tests-only_0123456789'
let tmp: string
let ctxCounter = 0

function ownTokenFile(content = FAKE_TOKEN + '\n', mode = 0o600): string {
  const p = join(tmp, 'worker.token')
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}
function newCtx(tokenFile: string | null) {
  ctxCounter++
  return makeWorkerCtx(`test-worker-${ctxCounter}`, join(tmp, `home-${ctxCounter}`), null, tokenFile)
}
const newSessionCalls = () => rec.exec.filter(([, args]) => args[0] === 'new-session')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'worker-own-token-'))
  rec.fakeHome = join(tmp, 'fake-host-home')
  mkdirSync(join(rec.fakeHome, '.claude'), { recursive: true })
  // the host's shared login file: a worker with its own token must never see it
  writeFileSync(join(rec.fakeHome, '.claude', '.credentials.json'), '{"shared":"rotating-login"}')
  rec.exec.length = 0
  rec.alerts.length = 0
  rec.readLogin = 0
  rec.customProvider = false
  process.env.MARVEEN_ALLOW_SECOND_INSTANCE_SERVICES = '1'
  delete process.env.WEB_ONLY
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.MARVEEN_ALLOW_SECOND_INSTANCE_SERVICES
})

describe('a refused own-token setting', () => {
  it('starts NO tmux session, writes NOTHING, and raises one specific alert (not the stuck-dialog one)', () => {
    const ctx = newCtx(join(tmp, 'does-not-exist.token'))
    startWorkerSessionFor(ctx)
    expect(newSessionCalls()).toEqual([])
    expect(existsSync(ctx.home)).toBe(false)
    expect(existsSync(ctx.configDir)).toBe(false)
    expect(rec.readLogin).toBe(0)
    expect(rec.alerts).toHaveLength(1)
    expect(rec.alerts[0]).toContain('WORKER_OAUTH_TOKEN_FILE')
    expect(rec.alerts[0]).toContain('missing')
    expect(rec.alerts[0]).not.toContain('beragadt dialógus')
  })

  it('a whitespace-only setting is refused too, never read as unset (= the fleet token)', () => {
    const ctx = newCtx('   ')
    startWorkerSessionFor(ctx)
    expect(newSessionCalls()).toEqual([])
    expect(rec.alerts[0]).toContain('blank')
  })

  it('ensureWorkerReady fails fast: no 90 s readiness wait, no session, the refusal alert only', async () => {
    const ctx = newCtx(ownTokenFile(FAKE_TOKEN, 0o644)) // mode too open
    const t0 = Date.now()
    await expect(ensureWorkerReady(ctx)).resolves.toBe(false)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(newSessionCalls()).toEqual([])
    expect(rec.alerts).toHaveLength(1)
    expect(rec.alerts[0]).toContain('mode-too-open')
    expect(rec.alerts[0]).not.toContain('beragadt dialógus')
  })

  it('refuses next to a custom-provider endpoint (the token would go to the third party)', () => {
    rec.customProvider = true
    const ctx = newCtx(ownTokenFile())
    startWorkerSessionFor(ctx)
    expect(newSessionCalls()).toEqual([])
    expect(rec.alerts[0]).toContain('custom-provider')
  })
})

describe('a valid own token', () => {
  it('launches with its own file read by the shell; the host login is never copied or linked, a stale login file is removed', () => {
    const ctx = newCtx(ownTokenFile())
    // a plain login file left from an earlier (fleet-less) run must go
    mkdirSync(ctx.configDir, { recursive: true })
    writeFileSync(join(ctx.configDir, '.credentials.json'), '{"stale":"host-login"}')

    startWorkerSessionFor(ctx)

    expect(existsSync(join(ctx.configDir, '.credentials.json')) || lstatSyncOrNull(join(ctx.configDir, '.credentials.json'))).toBeFalsy()
    expect(rec.readLogin).toBe(0)
    const launches = newSessionCalls()
    expect(launches).toHaveLength(1)
    const launch = launches[0][1][launches[0][1].length - 1]
    expect(launch).toContain(`$(cat '${join(tmp, 'worker.token')}')`)
    expect(launch).not.toContain(FAKE_TOKEN)
    expect(launch).not.toContain('.claude-oauth-token') // not the fleet file
    // other shared entries may be linked, the shared login file may not
    expect(readdirSync(ctx.configDir)).not.toContain('.credentials.json')
  })

  it('CONTROL: with no setting the old path is untouched (host login seeded, no own-token export)', () => {
    const ctx = newCtx(null)
    startWorkerSessionFor(ctx)
    expect(rec.readLogin).toBeGreaterThan(0)
    const launches = newSessionCalls()
    expect(launches).toHaveLength(1)
    const launch = launches[0][1][launches[0][1].length - 1]
    expect(launch).not.toContain('_wt=')
    expect(rec.alerts).toEqual([])
  })
})

function lstatSyncOrNull(p: string) {
  try { return lstatSync(p) } catch { return null }
}
