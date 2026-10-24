import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../web/agent-config.js', () => ({ agentDir: (n: string) => `/x/${n}`, listAgentNames: () => [] }))
vi.mock('../web/telegram.js', () => ({
  readAgentTeamsConfig: () => ({ hasTeams: false }),
  readMarveenTeamsConfig: () => ({ hasTeams: false }),
}))
vi.mock('../web/fleet-freeze.js', () => ({ whileNotFrozen: (_l: string, fn: () => void) => fn }))

import { checkTeamsCredentials, readChannelEnv, getProvider, teamsSecretExpiry } from '../channel-provider.js'
import { createTeamsCredentialChecker } from '../web/teams-credential-monitor.js'

const env = { TEAMS_BOT_APP_ID: 'app', TEAMS_BOT_APP_PASSWORD: 'SECRETX', TEAMS_BOT_TENANT_ID: 'ten-ant.1' }
const REFUSED = 'Teams credentials refused by Entra: '

function run(status: number, body: unknown, e: Record<string, string> = env) {
  const calls: Array<[string, any]> = []
  const f = (async (url: string, init: any) => {
    calls.push([url, init])
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, p: checkTeamsCredentials(e, { fetch: f }) }
}

describe('checkTeamsCredentials', () => {
  it('succeeds', async () => {
    const { calls, p } = run(200, { access_token: 'tok' })
    expect(await p).toEqual({ ok: true, botName: 'Microsoft Teams' })
    const [url, init] = calls[0]
    expect(url).toBe('https://login.microsoftonline.com/ten-ant.1/oauth2/v2.0/token')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const b = new URLSearchParams(init.body)
    expect(b.get('grant_type')).toBe('client_credentials')
    expect(b.get('client_id')).toBe('app')
    expect(b.get('client_secret')).toBe('SECRETX')
    expect(b.get('scope')).toBe('https://api.botframework.com/.default')
  })
  it('refusal never leaks', async () => {
    const r = await run(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret SECRETX', error_codes: [7000215] }).p
    expect(r.ok).toBe(false)
    expect(r.error).toBe(REFUSED + 'invalid_client (AADSTS7000215)')
    const j = JSON.stringify(r)
    expect(j).not.toContain('SECRETX')
    expect(j).not.toContain('error_description')
  })
  it('error codes', async () => {
    expect((await run(400, { error: 'invalid_client', error_codes: [7000222] }).p).error).toBe(REFUSED + 'invalid_client (AADSTS7000222)')
    expect((await run(400, { error: 'invalid_request', error_codes: [90002] }).p).error).toBe(REFUSED + 'invalid_request (AADSTS90002)')
  })
  it('unknown shapes', async () => {
    expect((await run(500, 'not json').p).error).toBe(REFUSED + 'unknown_error')
    expect((await run(400, { error: 'Bad Value!' }).p).error).toBe(REFUSED + 'unknown_error')
    expect((await run(400, { error: 'invalid_client', error_codes: ['x'] }).p).error).toBe(REFUSED + 'invalid_client')
    expect((await run(200, {}).p).error).toBe(REFUSED + 'unknown_error')
    // A token only counts on a 200 answer.
    expect((await run(401, { access_token: 'tok', error: 'invalid_client' }).p).ok).toBe(false)
  })
  it('fetch throws', async () => {
    const f = (async () => { throw new Error('boom') }) as unknown as typeof fetch
    const r = await checkTeamsCredentials(env, { fetch: f })
    expect(r).toEqual({ ok: false, error: 'Teams credentials could not be checked (network error or timeout)' })
  })
  it('a request that does not answer in time is not taken as ok', async () => {
    // The fake fetch answers only when its signal aborts, as a real fetch does on timeout.
    const f = ((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })) as unknown as typeof fetch
    const r = await checkTeamsCredentials(env, { fetch: f, timeoutMs: 20 })
    expect(r).toEqual({ ok: false, error: 'Teams credentials could not be checked (network error or timeout)' })
  })
  it('incomplete / bad tenant', async () => {
    const f = vi.fn()
    const deps = { fetch: f as unknown as typeof fetch }
    const a = await checkTeamsCredentials({ ...env, TEAMS_BOT_APP_PASSWORD: '' }, deps)
    const b = await checkTeamsCredentials({ TEAMS_BOT_APP_ID: 'a', TEAMS_BOT_APP_PASSWORD: 'b' }, deps)
    expect(a.error).toMatch(/^Teams credentials incomplete/)
    expect(b.error).toMatch(/^Teams credentials incomplete/)
    expect(f).not.toHaveBeenCalled()
    expect((await checkTeamsCredentials({ ...env, TEAMS_BOT_TENANT_ID: 'a/b' }, deps)).error).toBe('Teams tenant id has an unexpected form')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('readChannelEnv', () => {
  it('reads anchored keys', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'teams-')), '.env')
    writeFileSync(p, '# TEAMS_BOT_APP_ID=old\nOLD_TEAMS_BOT_APP_ID=x\nTEAMS_BOT_APP_PASSWORD= pw \nTEAMS_BOT_TENANT_ID=t\n')
    expect(readChannelEnv(p, ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID']))
      .toEqual({ TEAMS_BOT_APP_PASSWORD: 'pw', TEAMS_BOT_TENANT_ID: 't' })
    expect(readChannelEnv(p + '.missing', ['TEAMS_BOT_APP_ID'])).toEqual({})
  })
})

describe('teams provider', () => {
  it('wires validateCredentials', async () => {
    const t = getProvider('teams')
    expect(typeof t.validateCredentials).toBe('function')
    expect((await t.validateToken('x')).ok).toBe(true)
  })
})

describe('createTeamsCredentialChecker', () => {
  const setup = (results: Array<any>) => {
    const alert = vi.fn()
    const warn = vi.fn()
    const check = vi.fn(async () => {
      const r = results.shift()
      if (r instanceof Error) throw r
      return r
    })
    const tick = createTeamsCredentialChecker({ check, alert, log: { warn }, agents: () => [{ name: 'bob', envPath: '/nope/.env' }] })
    return { alert, warn, tick }
  }
  const refused = { ok: false, error: REFUSED + 'invalid_client (AADSTS7000215)' }
  it('alerts once, again after recovery', async () => {
    const { alert, tick } = setup([refused, refused, { ok: true }, refused])
    await tick()
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toContain('bob')
    expect(alert.mock.calls[0][0]).toContain(refused.error)
    await tick()
    expect(alert).toHaveBeenCalledTimes(1)
    await tick()
    await tick()
    expect(alert).toHaveBeenCalledTimes(2)
  })
  it('network errors only log and keep state', async () => {
    const net = { ok: false, error: 'Teams credentials could not be checked (network error or timeout)' }
    const { alert, warn, tick } = setup([refused, net, new Error('x'), refused])
    await tick(); await tick(); await tick()
    expect(warn).toHaveBeenCalledTimes(2)
    await tick()
    expect(alert).toHaveBeenCalledTimes(1)
  })
})

describe('wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')
  it('is wired', () => {
    expect(src('web/routes/agents.ts')).toContain('channelProvider.validateCredentials(channelEnv)')
    const w = src('web.ts')
    expect(w).toContain('startTeamsCredentialMonitor()')
    expect(w).toContain('clearInterval(teamsCredentialInterval)')
  })
})

describe('teamsSecretExpiry', () => {
  const now = Date.UTC(2026, 9, 24, 12)
  it('classifies values', () => {
    for (const v of [undefined, '', '  ']) expect(teamsSecretExpiry(v, now)).toEqual({ state: 'missing' })
    for (const v of ['2026-13-01', '2026-02-30', '26-10-24', 'tomorrow']) expect(teamsSecretExpiry(v, now)).toEqual({ state: 'invalid', value: v })
    expect(teamsSecretExpiry('2027-10-24', now)).toMatchObject({ state: 'ok', daysLeft: 365 })
    expect(teamsSecretExpiry('2026-11-20', now)).toMatchObject({ state: 'soon', daysLeft: 27 })
    expect(teamsSecretExpiry('2026-10-25', now)).toMatchObject({ state: 'soon', daysLeft: 1 })
    expect(teamsSecretExpiry('2026-10-24', now)).toMatchObject({ state: 'expired', daysLeft: 0 })
    expect(teamsSecretExpiry('2026-10-01', now)).toMatchObject({ state: 'expired' })
  })
})

describe('Teams secret expiry monitor', () => {
  const DAY = 86_400_000
  const DATE = '2026-12-01'
  const expiresAt = Date.UTC(2026, 11, 1)
  function setup(extra: string | null, check: () => Promise<any> = async () => ({ ok: true })) {
    const dir = mkdtempSync(join(tmpdir(), 'teams-exp-'))
    const envPath = join(dir, '.env')
    const write = (x: string | null) => writeFileSync(envPath, 'TEAMS_BOT_APP_ID=app\n' + (x ? x + '\n' : ''))
    write(extra)
    const alerts: string[] = []
    const warns: any[] = []
    const t = { now: expiresAt - 40 * DAY }
    const fn = createTeamsCredentialChecker({
      check, agents: () => [{ name: 'bob', envPath }], alert: (x) => alerts.push(x),
      log: { warn: (o, m) => warns.push([o, m]) }, now: () => t.now,
    })
    return { fn, alerts, warns, t, write }
  }
  const at = (t: { now: number }, days: number) => { t.now = expiresAt - days * DAY }

  it('does nothing without the key', async () => {
    const s = setup(null)
    await s.fn()
    expect(s.alerts).toEqual([]); expect(s.warns).toEqual([])
  })
  it('warns once for an invalid value', async () => {
    const s = setup('TEAMS_BOT_SECRET_EXPIRES=soon')
    await s.fn(); await s.fn()
    expect(s.warns).toHaveLength(1); expect(s.alerts).toEqual([])
  })
  it('alerts at 30, 7, 1 days and on expiry', async () => {
    const s = setup(`TEAMS_BOT_SECRET_EXPIRES=${DATE}`)
    await s.fn(); expect(s.alerts).toHaveLength(0)
    at(s.t, 30); await s.fn(); await s.fn()
    expect(s.alerts).toHaveLength(1); expect(s.alerts[0]).toContain('30 nap')
    at(s.t, 7); await s.fn(); await s.fn()
    expect(s.alerts).toHaveLength(2); expect(s.alerts[1]).toContain('7 nap')
    at(s.t, 1); await s.fn()
    expect(s.alerts).toHaveLength(3); expect(s.alerts[2]).toContain('1 nap')
    at(s.t, 0); await s.fn(); await s.fn()
    expect(s.alerts).toHaveLength(4); expect(s.alerts[3]).toContain('lejárt')
    at(s.t, -3); await s.fn()
    expect(s.alerts).toHaveLength(4)
  })
  it('a late start skips the 30-day warning', async () => {
    const s = setup(`TEAMS_BOT_SECRET_EXPIRES=${DATE}`)
    at(s.t, 5); await s.fn()
    expect(s.alerts).toHaveLength(1); expect(s.alerts[0]).toContain('5 nap')
    at(s.t, 1); await s.fn()
    expect(s.alerts).toHaveLength(2); expect(s.alerts[1]).toContain('1 nap')
  })
  it('a renewed date starts over', async () => {
    const s = setup(`TEAMS_BOT_SECRET_EXPIRES=${DATE}`)
    at(s.t, 30); await s.fn()
    expect(s.alerts).toHaveLength(1)
    s.write('TEAMS_BOT_SECRET_EXPIRES=2027-01-01')
    s.t.now = Date.UTC(2027, 0, 1) - 30 * DAY; await s.fn()
    expect(s.alerts).toHaveLength(2); expect(s.alerts[1]).toContain('2027-01-01')
  })
  it('alerts after a network error but not when check throws', async () => {
    const net = setup(`TEAMS_BOT_SECRET_EXPIRES=${DATE}`, async () => ({ ok: false, error: 'Teams credentials could not be checked (network error or timeout)' }))
    at(net.t, 7); await net.fn()
    expect(net.alerts).toHaveLength(1)
    const thr = setup(`TEAMS_BOT_SECRET_EXPIRES=${DATE}`, async () => { throw new Error('x') })
    at(thr.t, 7); await thr.fn()
    expect(thr.alerts).toHaveLength(0)
  })
})

describe('Teams secret expiry wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8')
  it('is wired in route, dashboard and dictionaries', () => {
    const a = readFileSync(join(__dirname, '..', 'web/routes/agents.ts'), 'utf-8')
    // Only the Teams provider reports an expiry, and a malformed date is logged where it is refused.
    expect(a).toContain("const secretExpiry = provider === 'teams' ? teamsSecretExpiry(channelEnv[TEAMS_SECRET_EXPIRY_KEY]) : undefined")
    expect(a).toContain("logger.warn({ agent: name, value: secretExpiry.value }, 'Teams secret expiry date is not YYYY-MM-DD; ignored')")
    expect(a.split('...(secretExpiry ? { secretExpiry } : {})').length - 1).toBe(2)
    expect(src('web/app.js')).toContain('channel.toast.teams_secret_expiry_missing')
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      for (const k of ['missing', 'invalid', 'ok', 'soon', 'expired']) expect(src(f)).toContain(`channel.toast.teams_secret_expiry_${k}'`)
    }
  })
})
