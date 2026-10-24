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

import { checkTeamsCredentials, readChannelEnv, getProvider } from '../channel-provider.js'
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
    expect(src('web/routes/agents.ts')).toContain('channelProvider.validateCredentials(readChannelEnv(envPath, channelProvider.envKeys))')
    const w = src('web.ts')
    expect(w).toContain('startTeamsCredentialMonitor()')
    expect(w).toContain('clearInterval(teamsCredentialInterval)')
  })
})
