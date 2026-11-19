import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// The hard-lock notice must never reach a real channel from a test.
const notifyOwner = vi.fn(async (_text: string) => true)
vi.mock('../notify.js', () => ({
  notifyOwner: (text: string) => notifyOwner(text),
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
}))

import { getDb, initDatabase, listSupportConsents } from '../db.js'
import { _clearSessionCacheForTest, resolveSession } from '../web/auth-sessions.js'
import { parseCookies, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { _resetThrottleForTest } from '../web/login-throttle.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import {
  handleSupportAccess,
  SUPPORT_ENABLE_ROUTE_ON,
  tryHandleSupportAccess,
  type SupportAccessDeps,
} from '../web/routes/support-access.js'
import type { RouteContext } from '../web/routes/types.js'
import { supportPasswordGate } from '../web/support-password.js'
import { runSupportReconcile, takeSupportAccessDown } from '../web/support-standby-runtime.js'
import type { KitRunResult } from '../support-kit-loader.js'
import { writeGroupRecord } from '../support-group-record.js'
import type { StandbyDeps } from '../support-standby-enable.js'
import type { SupportStatusDeps } from '../support-standby.js'
import { TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

// TEST ONLY values.
const GOOD_PW = 'super-secret-pw'
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const GRANT2 = '3f2504e0-4f89-41d3-9a0c-0305e82c3302'
const SESSION: RouteContext['auth'] = { kind: 'session', user: 'alice' }

let bodyReads = 0
function mkReq(body?: unknown, headers: Record<string, string> = {}): http.IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const r = Readable.from(
    (function* () {
      bodyReads += 1
      yield* payload
    })(),
  ) as unknown as http.IncomingMessage
  r.headers = headers
  return r
}

async function callWith(
  handler: (ctx: RouteContext) => Promise<boolean>,
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth']; headers?: Record<string, string> } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const res = mkRes()
  const ctx: RouteContext = {
    req: mkReq(opts.body, opts.headers),
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  }
  const handled = await handler(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

describe('/api/support-access', () => {
  let root: string
  let supportDir: string
  let sshDir: string
  let runs: { args: readonly string[]; stdin?: string; supportDir: string }[]
  let runAnswer: (n: number) => KitRunResult

  const standbyDeps = (): StandbyDeps => ({
    supportDir,
    sshDir,
    pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
    probeSshd: async () => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys'], listenPorts: [22], hostKeyFiles: [] }),
    readHostKey: async () => ({ kind: 'ok', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ' }),
    redeemTransport: async () => ({ status: 500, body: '' }),
    now: () => new Date(),
    newGrantId: () => GRANT,
    startedFromKit: false,
  })
  const statusDeps = (): SupportStatusDeps => ({
    nodeVersion: 'v22.12.0',
    pins: { keys: [], fromCidrs: [] },
    probeSshd: async () => {
      throw new Error('not asked with empty pins')
    },
    isExecutable: () => false,
    readKeysFile: () => null,
    readStandbyFiles: () => ({ token: 'missing', record: { kind: 'missing' } }),
  })
  const deps = (over: Partial<SupportAccessDeps> = {}): SupportAccessDeps => ({
    enableOn: true,
    runKit: async (input) => {
      runs.push({ args: input.args, stdin: input.stdin, supportDir: input.supportDir })
      return runAnswer(runs.length)
    },
    standbyDeps,
    statusDeps,
    passwordGate: supportPasswordGate,
    ...over,
  })
  const call = (method: string, path: string, opts: { body?: unknown; auth?: RouteContext['auth']; headers?: Record<string, string> } = {}, over: Partial<SupportAccessDeps> = {}) =>
    callWith((ctx) => handleSupportAccess(ctx, deps(over)), method, path, { auth: SESSION, ...opts })
  const enable = (password = GOOD_PW, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/support-access/enable', { body: { consentVersion: 2, locale: 'hu', password, code: CODE, ...extra } })

  // What the kit's routine does on a successful enable, as far as the route can see: the record, and its answer.
  const enabledBy = (grantId: string, consentVersion = 2) => (): KitRunResult => {
    writeGroupRecord(supportDir, {
      grantId,
      consentVersion,
      consentAt: '2026-11-15T07:40:00Z',
      keys: TEST_ONLY_KEYS.map((k) => ({ name: k.name, fingerprint: k.fingerprint })),
      fromCidrs: [...TEST_ONLY_FROM],
      dispatchPath: join(supportDir, 'kit', 'support-dispatch.sh'),
      sshd: { major: 9, minor: 6 },
    })
    return { ok: true, code: 0, stdout: 'standby=on\nstandby_keys=key1,key2\nsupport_lines=2\nlogins=refused_by_this_release\n', stderr: '' }
  }
  const refused = (code: string): (() => KitRunResult) => () => ({ ok: true, code: 1, stdout: '', stderr: 'enable: refused: ' + code + '\n' })

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  beforeEach(async () => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM support_consents; DELETE FROM support_password_state')
    _clearSessionCacheForTest()
    _resetThrottleForTest()
    notifyOwner.mockClear()
    bodyReads = 0
    runs = []
    runAnswer = enabledBy(GRANT)
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-routes-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    sshDir = join(root, 'home', '.ssh')
    mkdirSync(supportDir, { recursive: true, mode: 0o700 })
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(sshDir, 'authorized_keys'), '', { mode: 0o600 })
    const seeded = await callWith(tryHandleAuth, 'POST', '/api/auth/users', { auth: { kind: 'token' }, body: { username: 'alice', password: GOOD_PW } })
    expect(seeded.res.statusCode).toBe(201)
    bodyReads = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('the shipped switch is OFF: enable refuses with its own code before it reads the body or asks for the password', async () => {
    expect(SUPPORT_ENABLE_ROUTE_ON).toBe(false)
    const r = await callWith(tryHandleSupportAccess, 'POST', '/api/support-access/enable', {
      auth: SESSION,
      body: { consentVersion: 1, password: 'wrong', code: CODE },
    })
    expect(r.res.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: 'support_enable_not_available' })
    expect(bodyReads).toBe(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM support_password_state').get()).toEqual({ n: 0 })
  })

  it('with the switch off nothing runs, whatever the body', async () => {
    for (const body of [{ consentVersion: 1, password: GOOD_PW, code: CODE }, { x: 1 }]) {
      const r = await call('POST', '/api/support-access/enable', { body }, { enableOn: false })
      expect([r.res.statusCode, r.json()]).toEqual([403, { error: 'support_enable_not_available' }])
    }
    expect(runs).toEqual([])
    expect(bodyReads).toBe(0)
  })

  it('needs the owner: a bare token is refused, an operator key is not even an owner lane', async () => {
    const bare = await call('POST', '/api/support-access/disable', { auth: { kind: 'token' } })
    expect(bare.res.statusCode).toBe(403)
    expect(bare.json().error).not.toBe('Forbidden for this credential type')
    const operator = await call('GET', '/api/support-access', { auth: { kind: 'device', scope: 'operator' } as unknown as RouteContext['auth'] })
    expect(operator.res.statusCode).toBe(403)
    expect(operator.json()).toEqual({ error: 'Forbidden for this credential type' })
    expect(runs).toEqual([])
  })

  it('accepts only consentVersion, locale, password and code', async () => {
    const r = await enable(GOOD_PW, { keys: ['x'] })
    expect(r.res.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'field_not_accepted' })
    expect(runs).toEqual([])
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['a consent version as text', { consentVersion: '1' }, 'consent_invalid'],
    ['a locale that is not one', { locale: 'hu; rm' }, 'locale_invalid'],
    ['no password', { password: '' }, 'password_required'],
    ['no code', { code: '' }, 'code_required'],
  ])('refuses %s before the password is checked', async (_label, over, error) => {
    const r = await call('POST', '/api/support-access/enable', { body: { consentVersion: 1, password: GOOD_PW, code: CODE, ...over } })
    expect(r.res.statusCode).toBe(400)
    expect(r.json()).toEqual({ error })
    expect(runs).toEqual([])
  })

  it('a wrong password is 401 and runs nothing; the fifth locks, and then the right one gets the same 429', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await enable('wrong-' + i)
      expect(r.res.statusCode).toBe(401)
      expect(r.json()).toEqual({ error: 'invalid_password' })
    }
    expect((await enable('wrong-5')).res.statusCode).toBe(401)
    const locked = await enable(GOOD_PW)
    expect(locked.res.statusCode).toBe(429)
    expect(locked.json()).toEqual({ error: 'support_password_locked' })
    expect(locked.res.headers['Retry-After']).toBe(String(15 * 60))
    const lockedWrong = await enable('wrong-6')
    expect([lockedWrong.res.statusCode, lockedWrong.res.body]).toEqual([locked.res.statusCode, locked.res.body])
    expect(runs).toEqual([])
  })

  // Dani's review of #2781, F1: measured before the fix, 30 parallel wrong passwords gave 30 checked 401s.
  it('a burst of parallel wrong passwords is checked one at a time: five 401s, the rest the lock', async () => {
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => enable('wrong-' + i)))
    const codes = answers.map((a) => a.res.statusCode)
    expect(codes.filter((c) => c === 401)).toHaveLength(5)
    expect(codes.filter((c) => c === 429)).toHaveLength(25)
    expect((await enable(GOOD_PW)).res.statusCode).toBe(429)
    expect(runs).toEqual([])
  })

  it('a right password clears the wrong ones before it', async () => {
    for (let i = 0; i < 4; i++) expect((await enable('wrong-' + i)).res.statusCode).toBe(401)
    expect((await enable(GOOD_PW)).res.statusCode).toBe(200)
    for (let i = 0; i < 4; i++) expect((await enable('wrong-again-' + i)).res.statusCode).toBe(401)
    expect((await enable(GOOD_PW)).res.statusCode).toBe(200)
  })

  it('the bucket is not the login\'s: wrong support passwords do not lock the login', async () => {
    for (let i = 0; i < 5; i++) await enable('wrong-' + i)
    const login = await callWith(tryHandleAuth, 'POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(login.res.statusCode).toBe(200)
  })

  it('the third lock of a day holds until the owner\'s next login, with one notice to the owner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T08:00:00Z'))
    for (let lock = 0; lock < 3; lock++) {
      for (let i = 0; i < 5; i++) expect((await enable('wrong-' + i)).res.statusCode).toBe(401)
      if (lock < 2) vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000))
    }
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date(Date.now() + 48 * 60 * 60 * 1000))
    const still = await enable(GOOD_PW)
    expect(still.res.statusCode).toBe(429)
    expect(still.res.headers['Retry-After']).toBeUndefined()
    expect(runs).toEqual([])
    const login = await callWith(tryHandleAuth, 'POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(login.res.statusCode).toBe(200)
    expect((await enable(GOOD_PW)).res.statusCode).toBe(200)
  })

  it('enables through the kit\'s routine: the code on standard input only, one consent row copied from the record', async () => {
    const r = await enable()
    expect(r.res.statusCode).toBe(200)
    expect(r.json()).toEqual({
      state: 'standby',
      status: { standby: 'on', standby_keys: 'key1,key2', support_lines: '2', logins: 'refused_by_this_release' },
    })
    expect(runs).toEqual([{ args: ['enable', '--consent', '2'], stdin: CODE, supportDir }])
    const rows = listSupportConsents()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      grant_id: GRANT,
      consent_version: 2,
      // which text: the language the owner used (locale hu) and that text's sha256, the marveen.io value for '2:hu'
      consent_lang: 'hu',
      consent_sha256: '1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b',
      consent_at: '2026-11-15T07:40:00Z',
      locale: 'hu',
      key_names: 'key1,key2',
      created_via: 'button',
      actor: 'session:alice',
      revoked_at: null,
      revoked_via: null,
    })
    expect(JSON.stringify(rows) + r.res.body).not.toContain(CODE)
    expect(JSON.stringify(rows) + r.res.body).not.toContain(TEST_ONLY_FROM[0])
  })

  it('an English dashboard stores en and the English text\'s sha256; an unknown locale stores neither', async () => {
    expect((await enable(GOOD_PW, { locale: 'en' })).res.statusCode).toBe(200)
    expect(listSupportConsents().map((row) => [row.consent_lang, row.consent_sha256])).toEqual([['en', '77decc75121d9a0aaf22a0a63983488574dd122320def7d363a2ecce04a80703']])
    getDb().exec('DELETE FROM support_consents')
    runAnswer = enabledBy(GRANT2)
    expect((await enable(GOOD_PW, { locale: 'de' })).res.statusCode).toBe(200)
    expect(listSupportConsents().map((row) => [row.consent_lang, row.consent_sha256])).toEqual([[null, null]])
  })

  it('a row whose recorded version has no approved text stores no sha256 (NULL)', async () => {
    runAnswer = enabledBy(GRANT, 1)
    expect((await enable()).res.statusCode).toBe(200)
    expect(listSupportConsents().map((row) => [row.consent_version, row.consent_sha256])).toEqual([[1, null]])
  })

  it('a second enable closes the open row as replaced', async () => {
    await enable()
    runAnswer = enabledBy(GRANT2)
    expect((await enable()).res.statusCode).toBe(200)
    const rows = listSupportConsents()
    expect(rows.map((row) => [row.grant_id, row.revoked_via])).toEqual([
      [GRANT2, null],
      [GRANT, 'replaced'],
    ])
  })

  it.each<[string, () => KitRunResult, number, string]>([
    ['the service refused the code', refused('code_rejected'), 400, 'code_rejected'],
    ['the service is unreachable', refused('service_unavailable'), 502, 'code_exchange_unavailable'],
    ['the service limits', refused('rate_limited'), 429, 'rate_limited'],
    ['sshd is not ready', refused('sshd_too_old'), 409, 'sshd_too_old'],
    ['standby is on already (Dani F1)', refused('already_on'), 409, 'already_on'],
    ['the write failed', refused('enable_write_failed'), 500, 'enable_write_failed'],
    ['an answer that names no reason', () => ({ ok: true, code: 1, stdout: '', stderr: 'enable: refused: Bad Code\n' }), 500, 'enable_failed'],
    ['another exit code', () => ({ ok: true, code: 3, stdout: '', stderr: 'enable: refused: code_rejected\n' }), 500, 'enable_failed'],
    ['the kit is missing', () => ({ ok: false, problem: 'kit_missing' }), 409, 'kit_missing'],
    ['the routine did not run', () => ({ ok: false, problem: 'kit_run_failed' }), 500, 'kit_run_failed'],
  ])('maps a refusal: %s', async (_label, answer, status, error) => {
    runAnswer = answer
    const r = await enable()
    expect(r.res.statusCode).toBe(status)
    expect(r.json()).toEqual({ error })
    expect(listSupportConsents()).toEqual([])
  })

  // Dani's review of #2786, R1: one standby change at a time in this process.
  it('a security teardown waits for an enable that is running, and runs after it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const order: string[] = []
    const enabling = call('POST', '/api/support-access/enable', { body: { consentVersion: 1, password: GOOD_PW, code: CODE } }, {
      runKit: async () => {
        order.push('enable started')
        await gate
        order.push('enable done')
        return { ok: true, code: 1, stdout: '', stderr: 'enable: refused: code_rejected\n' }
      },
    })
    while (!order.includes('enable started')) await new Promise((r) => setTimeout(r, 5))
    const teardown = takeSupportAccessDown('password_change').then(() => order.push('teardown'))
    try {
      await new Promise((r) => setTimeout(r, 50))
      expect(order).toEqual(['enable started'])
    } finally {
      release()
    }
    await enabling
    await teardown
    expect(order).toEqual(['enable started', 'enable done', 'teardown'])
  })

  it('the reconcile waits for an enable that is running, too', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const order: string[] = []
    const enabling = call('POST', '/api/support-access/enable', { body: { consentVersion: 1, password: GOOD_PW, code: CODE } }, {
      runKit: async () => {
        order.push('enable started')
        await gate
        order.push('enable done')
        return { ok: true, code: 1, stdout: '', stderr: 'enable: refused: code_rejected\n' }
      },
    })
    while (!order.includes('enable started')) await new Promise((r) => setTimeout(r, 5))
    const reconciling = runSupportReconcile({ standby: standbyDeps(), transport: async () => ({ status: 200, body: '' }) }).then((o) => order.push('reconcile ' + o))
    try {
      await new Promise((r) => setTimeout(r, 50))
      expect(order).toEqual(['enable started'])
    } finally {
      release()
    }
    await enabling
    await reconciling
    expect(order).toEqual(['enable started', 'enable done', 'reconcile off'])
  })

  // Samu's review of #2786, N1: the old sessions go BEFORE the teardown, which may wait for the lock.
  it('a password change revokes the other sessions at once, even while the support lock is held', async () => {
    const other = await callWith(tryHandleAuth, 'POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const otherToken = parseCookies(String(other.res.headers['Set-Cookie']).split(';')[0])[SESSION_COOKIE_NAME] ?? ''
    expect(resolveSession(otherToken)).not.toBeNull()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let started = false
    const enabling = call('POST', '/api/support-access/enable', { body: { consentVersion: 1, password: GOOD_PW, code: CODE } }, {
      runKit: async () => {
        started = true
        await gate
        return { ok: true, code: 1, stdout: '', stderr: 'enable: refused: code_rejected\n' }
      },
    })
    while (!started) await new Promise((r) => setTimeout(r, 5))
    let changed = false
    const change = callWith(tryHandleAuth, 'POST', '/api/auth/password', {
      auth: { kind: 'session', user: 'alice' },
      body: { current_password: GOOD_PW, new_password: 'brand-new-pass-1' },
    }).then((r) => {
      changed = true
      return r
    })
    try {
      // The password change runs the KDF first: on a slow runner that alone takes far more than a moment. Wait for the
      // revoke itself (bounded), then check that the answer is still held by the support lock.
      const until = Date.now() + 20_000
      while (resolveSession(otherToken) !== null && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
      expect(resolveSession(otherToken)).toBeNull()
      expect(changed).toBe(false)
    } finally {
      // Always let the enable finish: a lock left held would stall every later test of this file.
      release()
    }
    await enabling
    expect((await change).res.statusCode).toBe(200)
  })

  it('disables without a password and closes the open rows', async () => {
    await enable()
    const r = await call('POST', '/api/support-access/disable', { body: {} })
    expect(r.res.statusCode).toBe(200)
    expect(r.json()).toEqual({ state: 'off', removed_lines: 0 })
    expect(listSupportConsents().map((row) => row.revoked_via)).toEqual(['button'])
  })

  it('a disable that cannot finish says so and keeps the rows open', async () => {
    await enable()
    rmSync(join(sshDir, 'authorized_keys'))
    mkdirSync(join(sshDir, 'authorized_keys'))
    const r = await call('POST', '/api/support-access/disable')
    expect(r.res.statusCode).toBe(500)
    expect(r.json()).toEqual({ error: 'disable_incomplete', problem: 'lines_remain', removed_lines: 0 })
    expect(listSupportConsents().map((row) => row.revoked_via)).toEqual([null])
  })

  it('GET is the owner\'s too: the shared token alone is refused (Dani\'s review of #2781, N1)', async () => {
    const r = await call('GET', '/api/support-access', { auth: { kind: 'token' } })
    expect(r.res.statusCode).toBe(403)
    expect(r.json().error).not.toBe('Forbidden for this credential type')
  })

  it('GET only reports: the status lines and whether enable is offered, nothing written', async () => {
    const r = await call('GET', '/api/support-access', {}, { enableOn: false })
    expect(r.res.statusCode).toBe(200)
    const body = r.json()
    expect(body.enable_available).toBe(false)
    expect(body.consent_version).toBe(2)
    expect(body.status).toMatchObject({ pins: 'support_keys_unset', sshd: 'not_asked', standby: 'off' })
    expect(runs).toEqual([])
    expect(listSupportConsents()).toEqual([])
  })
})
