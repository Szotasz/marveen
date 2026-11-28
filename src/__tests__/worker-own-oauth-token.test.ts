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

import { buildCustomProviderLaunchEnv } from '../web/agent-process.js'
import { makeWorkerCtx, startWorkerSessionFor, ensureWorkerReady, seedWorkerCredentials, workerAuthFailureResult } from '../web/agent-worker.js'

const FAKE_TOKEN = 'sk-ant-oat01-FAKE-worker-token-for-tests-only_0123456789'
let tmp: string
let ctxCounter = 0

function ownTokenFile(content = FAKE_TOKEN + '\n', mode = 0o600): string {
  const p = join(tmp, 'worker.token')
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}
function newCtx(tokenFile: string | null, settingName = 'WORKER_OAUTH_TOKEN_FILE') {
  ctxCounter++
  return makeWorkerCtx(`test-worker-${ctxCounter}`, join(tmp, `home-${ctxCounter}`), null, tokenFile, settingName)
}
const providerCalls = () => vi.mocked(buildCustomProviderLaunchEnv).mock.calls.length
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
  vi.mocked(buildCustomProviderLaunchEnv).mockClear()
  process.env.MARVEEN_ALLOW_SECOND_INSTANCE_SERVICES = '1'
  delete process.env.WEB_ONLY
})
afterEach(() => {
  vi.useRealTimers()
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
    expect(rec.alerts[0]).not.toContain('_FAST')
  })

  it('the FAST worker alert names WORKER_OAUTH_TOKEN_FILE_FAST, the slow one the plain name', () => {
    const fast = newCtx(join(tmp, 'nope.token'), 'WORKER_OAUTH_TOKEN_FILE_FAST')
    startWorkerSessionFor(fast)
    expect(rec.alerts[0]).toContain('WORKER_OAUTH_TOKEN_FILE_FAST')
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

  it('CONTROL: with no setting the old path is untouched (host login seeded, the launch line is the old one)', () => {
    const ctx = newCtx(null)
    startWorkerSessionFor(ctx)
    expect(rec.readLogin).toBeGreaterThan(0)
    const launches = newSessionCalls()
    expect(launches).toHaveLength(1)
    const launch = launches[0][1][launches[0][1].length - 1]
    // no fleet token in this test root: the old line starts with the config-dir export, nothing own-token before it
    expect(launch.startsWith('export CLAUDE_CONFIG_DIR=')).toBe(true)
    expect(launch).not.toMatch(/_wt=|unset /)
    expect(rec.alerts).toEqual([])
  })

  it('N1: an UNSET setting causes no extra custom-provider resolution (it reads the vault and writes a launch-secret file): same count as before the feature', () => {
    startWorkerSessionFor(newCtx(null))
    expect(providerCalls()).toBe(1) // the launch's own resolution, as it always was
    vi.mocked(buildCustomProviderLaunchEnv).mockClear()
    startWorkerSessionFor(newCtx(''))
    expect(providerCalls()).toBe(1)
  })

  it('an own token adds exactly one more resolution (the decision), and not on a refused path', () => {
    startWorkerSessionFor(newCtx(ownTokenFile()))
    expect(providerCalls()).toBe(2)
    vi.mocked(buildCustomProviderLaunchEnv).mockClear()
    startWorkerSessionFor(newCtx(join(tmp, 'gone.token')))
    expect(providerCalls()).toBe(1) // only the decision, after the path check passed; no launch
  })

  it('the launch strips inherited API credentials ahead of the own token (they would outrank it)', () => {
    startWorkerSessionFor(newCtx(ownTokenFile()))
    const [, args] = newSessionCalls()[0]
    const launch = args[args.length - 1]
    expect(launch.startsWith('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; _wt=')).toBe(true)
  })
})

describe('the recovery path (seedWorkerCredentials, called by runViaWorker after an auth failure)', () => {
  it('with an own token it neither reads the host login nor writes a login file, and removes a stale one', () => {
    const ctx = newCtx(ownTokenFile())
    mkdirSync(ctx.configDir, { recursive: true })
    writeFileSync(join(ctx.configDir, '.credentials.json'), '{"stale":"host-login"}')
    expect(seedWorkerCredentials(ctx)).toBe(false)
    expect(rec.readLogin).toBe(0)
    expect(lstatSyncOrNull(join(ctx.configDir, '.credentials.json'))).toBeNull()
  })

  it('with a REFUSED setting it does not seed either (fail closed)', () => {
    const ctx = newCtx(join(tmp, 'gone.token'))
    expect(seedWorkerCredentials(ctx)).toBe(false)
    expect(rec.readLogin).toBe(0)
  })

  it('CONTROL: with no setting it seeds the host login as before', () => {
    const ctx = newCtx(null)
    expect(seedWorkerCredentials(ctx)).toBe(true)
    expect(rec.readLogin).toBe(1)
    expect(existsSync(join(ctx.configDir, '.credentials.json'))).toBe(true)
  })
})

describe('A2: a persistent auth failure with an own token never signals the SDK fallback', () => {
  const own = { kind: 'own', path: '/x/w.token', fingerprint: 'abcd1234' } as const
  it('own or refused: an error, no authFailed (runAgent returns it instead of using other credentials)', () => {
    for (const d of [own, { kind: 'refused', path: '/x/w.token', reason: 'missing', detail: '' } as const]) {
      for (const afterRecovery of [true, false]) {
        const r = workerAuthFailureResult(d, afterRecovery)
        expect(r.authFailed).toBeUndefined()
        expect(r.text).toBeNull()
        expect(r.error).toContain('no SDK fallback')
      }
    }
  })
  it('CONTROL: unset keeps the old signal', () => {
    expect(workerAuthFailureResult({ kind: 'unset' }, true)).toMatchObject({ authFailed: true, error: 'worker auth failed (401/login) after recovery' })
    expect(workerAuthFailureResult({ kind: 'unset' }, false)).toMatchObject({ authFailed: true, error: 'worker auth failed' })
  })
})

describe('N5: the launch shell exits at once (the token file changed after the check)', () => {
  it('ensureWorkerReady says so within seconds, naming the setting, not the generic stuck-dialog alert', async () => {
    vi.useFakeTimers()
    const ctx = newCtx(ownTokenFile(), 'WORKER_OAUTH_TOKEN_FILE_FAST')
    const p = ensureWorkerReady(ctx) // the mocked tmux never lists a session: the shell "exited"
    await vi.advanceTimersByTimeAsync(10000)
    await expect(p).resolves.toBe(false)
    expect(rec.alerts).toHaveLength(1)
    expect(rec.alerts[0]).toContain('azonnal kilépett')
    expect(rec.alerts[0]).toContain('WORKER_OAUTH_TOKEN_FILE_FAST')
    expect(rec.alerts[0]).not.toContain('beragadt dialógus')
  })
})

function lstatSyncOrNull(p: string) {
  try { return lstatSync(p) } catch { return null }
}
