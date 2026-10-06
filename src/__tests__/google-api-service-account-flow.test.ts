import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module's behaviour on the service-account path, through its exported
// functions, with the network mocked at node:https. The pure builders are
// pinned in google-api-service-account.test.ts; these pin what the module DOES
// with them: which scopes it sends, when it exchanges a new token, what it does
// after a 401 or a failed exchange, which path wins, and what it never logs.
// Review of #1673: each of these behaviours could be reverted with every test
// still green.

type Call = { url: string; method: string; headers: Record<string, string>; body: string }
type Reply = { status: number; data: string }

const calls: Call[] = []
let responder: (c: Call) => Reply = () => ({ status: 500, data: '' })

vi.mock('node:https', () => ({
  default: {
    request: (url: string, options: { method?: string; headers?: Record<string, string> }, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      let body = ''
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: () => void; write: (b: string) => void; end: () => void; destroy: (e?: Error) => void
      }
      req.setTimeout = () => {}
      req.write = (b: string) => { body += b }
      req.destroy = () => {}
      req.end = () => {
        const call = { url, method: options.method ?? 'GET', headers: options.headers ?? {}, body }
        calls.push(call)
        const reply = responder(call)
        const res = new EventEmitter() as EventEmitter & { statusCode: number }
        res.statusCode = reply.status
        queueMicrotask(() => {
          cb(res)
          res.emit('data', Buffer.from(reply.data))
          res.emit('end')
        })
      }
      return req
    },
  },
}))

const logged: unknown[] = []
vi.mock('../logger.js', () => {
  const rec = (...a: unknown[]) => { logged.push(a) }
  return { logger: { info: rec, warn: rec, error: rec, debug: rec } }
})

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const isExchange = (c: Call) => c.url === TOKEN_URL && c.body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
const isOAuthRefresh = (c: Call) => c.url === TOKEN_URL && c.body.includes('grant_type=refresh_token')
const isApi = (c: Call) => c.url.startsWith('https://www.googleapis.com/')
const bearer = (c: Call) => c.headers.Authorization

let home = ''
let issued = 0

/** Fresh module instance with HOME pointing at a temp dir (the paths are computed at import). */
async function loadModule(opts: { saMode?: number; withOAuth?: boolean } = {}) {
  home = mkdtempSync(join(tmpdir(), 'gsa-flow-'))
  vi.stubEnv('HOME', home)
  const saDir = join(home, '.config', 'marveen')
  mkdirSync(saDir, { recursive: true })
  const saPath = join(saDir, 'google-service-account.json')
  writeFileSync(saPath, JSON.stringify({ client_email: 'bot@x.iam.gserviceaccount.com', private_key: privateKey }))
  chmodSync(saPath, opts.saMode ?? 0o600)
  if (opts.withOAuth) {
    mkdirSync(join(home, '.config', 'google-calendar-mcp'), { recursive: true })
    // The file's real shape is { normal: TokenData }; a flat object would make
    // loadTokens() fail, and "the key file wins" would be tested against an
    // OAuth path that could not have won anyway.
    writeFileSync(join(home, '.config', 'google-calendar-mcp', 'tokens.json'), JSON.stringify({ normal: {
      access_token: 'OAUTH-ACCESS', refresh_token: 'OAUTH-REFRESH', expiry_date: Date.now() + 3600_000, token_type: 'Bearer', scope: '',
    } }))
    mkdirSync(join(home, '.gmail-mcp'), { recursive: true })
    writeFileSync(join(home, '.gmail-mcp', 'gcp-oauth.keys.json'), JSON.stringify({
      installed: { client_id: 'cid', client_secret: 'csecret', token_uri: TOKEN_URL },
    }))
  }
  vi.resetModules()
  return { mod: await import('../google-api.js'), saPath }
}

/** Default: token exchange answers with a new numbered token; API answers 200 with an empty list. */
function defaultResponder(api: (c: Call) => Reply = () => ({ status: 200, data: '{"items":[],"files":[]}' })) {
  responder = (c) => {
    if (isExchange(c)) { issued += 1; return { status: 200, data: JSON.stringify({ access_token: `SA-${issued}`, expires_in: 3600 }) } }
    if (isOAuthRefresh(c)) return { status: 200, data: JSON.stringify({ access_token: 'OAUTH-NEW', expires_in: 3600 }) }
    return api(c)
  }
}

function decodeAssertion(c: Call): Record<string, unknown> {
  const assertion = new URLSearchParams(c.body).get('assertion') ?? ''
  const claims = assertion.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(claims, 'base64').toString('utf-8'))
}

beforeEach(() => {
  calls.length = 0
  logged.length = 0
  issued = 0
  defaultResponder()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (home) rmSync(home, { recursive: true, force: true })
})

describe('service-account path: behaviour through the module', () => {
  it('sends EXACTLY calendar.readonly + drive.readonly in the exchanged assertion', async () => {
    const { mod } = await loadModule()
    await mod.listCalendars()
    const ex = calls.filter(isExchange)
    expect(ex).toHaveLength(1)
    expect(decodeAssertion(ex[0]).scope).toBe(
      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly',
    )
  })

  it('reuses the token, then exchanges a new one when it is within 5 minutes of expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
    const { mod } = await loadModule()
    await mod.listCalendars()
    await mod.listCalendars()
    expect(calls.filter(isExchange)).toHaveLength(1)
    vi.setSystemTime(new Date('2026-10-02T10:56:00Z')) // expires 11:00, refresh window starts 10:55
    await mod.listCalendars()
    expect(calls.filter(isExchange)).toHaveLength(2)
    expect(bearer(calls.filter(isApi).at(-1)!)).toBe('Bearer SA-2')
  })

  it('a 401 mid-call forces a NEW exchange, and the retry carries the new token', async () => {
    const { mod } = await loadModule()
    let apiCalls = 0
    defaultResponder(() => (++apiCalls === 1 ? { status: 401, data: '' } : { status: 200, data: '{"items":[]}' }))
    await mod.listCalendars()
    expect(calls.filter(isExchange)).toHaveLength(2)
    const api = calls.filter(isApi)
    expect(bearer(api[0])).toBe('Bearer SA-1')
    expect(bearer(api[1])).toBe('Bearer SA-2')
  })

  it('a failed exchange drops the cached token: the next call exchanges again', async () => {
    const { mod } = await loadModule()
    await mod.listCalendars() // SA-1 cached
    let failNext = true
    responder = (c) => {
      if (isExchange(c)) {
        if (failNext) { failNext = false; return { status: 400, data: '{"error":"invalid_grant"}' } }
        issued += 1
        return { status: 200, data: JSON.stringify({ access_token: `SA-${issued}`, expires_in: 3600 }) }
      }
      return { status: 401, data: '' } // forces the exchange path
    }
    await expect(mod.listCalendars()).rejects.toThrow()
    const before = calls.filter(isExchange).length
    defaultResponder()
    await mod.listCalendars()
    expect(calls.filter(isExchange).length).toBe(before + 1)
    expect(bearer(calls.filter(isApi).at(-1)!)).not.toBe('Bearer SA-1')
  })

  it('the key file WINS over an installed, still-valid OAuth token', async () => {
    const { mod } = await loadModule({ withOAuth: true })
    await mod.listCalendars()
    expect(calls.some(isOAuthRefresh)).toBe(false)
    expect(bearer(calls.filter(isApi)[0])).toBe('Bearer SA-1')
  })

  it('CONTROL: without the key file the same OAuth token IS used (the fixture is a working OAuth install)', async () => {
    const { mod, saPath } = await loadModule({ withOAuth: true })
    rmSync(saPath)
    await mod.listCalendars()
    expect(bearer(calls.filter(isApi)[0])).toBe('Bearer OAUTH-ACCESS')
  })

  it('a 401 on the service-account path never falls back to the OAuth refresh', async () => {
    const { mod } = await loadModule({ withOAuth: true })
    let apiCalls = 0
    defaultResponder(() => (++apiCalls === 1 ? { status: 401, data: '' } : { status: 200, data: '{"items":[]}' }))
    await mod.listCalendars()
    expect(calls.some(isOAuthRefresh)).toBe(false)
    expect(calls.filter(isExchange)).toHaveLength(2)
  })

  it('never logs the private key or the signed assertion, also on a failed exchange', async () => {
    const { mod } = await loadModule()
    await mod.listCalendars()
    responder = (c) => (isExchange(c) ? { status: 400, data: '{"error":"invalid_grant"}' } : { status: 401, data: '' })
    await expect(mod.listCalendars()).rejects.toThrow()
    const text = JSON.stringify(logged)
    const assertions = calls.filter(isExchange).map((c) => new URLSearchParams(c.body).get('assertion') ?? '')
    expect(logged.length).toBeGreaterThan(0) // the check below reads real log lines
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toContain(privateKey.split('\n')[1])
    for (const a of assertions) expect(text).not.toContain(a.split('.')[2])
  })
})

describe('key-file permissions', () => {
  it('a group- or other-readable key is refused before any network call, naming the fix', async () => {
    const { mod, saPath } = await loadModule({ saMode: 0o644 })
    await expect(mod.listCalendars()).rejects.toThrow(`chmod 600 ${saPath}`)
    expect(calls).toHaveLength(0)
  })

  it('CONTROL: mode 600 is accepted', async () => {
    const { mod } = await loadModule({ saMode: 0o600 })
    await expect(mod.listCalendars()).resolves.toEqual([])
  })

  it('a chmod after the key was cached is still noticed (chmod does not change mtime)', async () => {
    const { mod, saPath } = await loadModule({ saMode: 0o600 })
    await mod.listCalendars()
    chmodSync(saPath, 0o640)
    // force a reload: expire the cached token
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 2 * 3600 * 1000))
    await expect(mod.listCalendars()).rejects.toThrow('chmod 600')
  })
})

describe('the three list/read functions throw on an API error, never [] or null', () => {
  const fail = () => defaultResponder(() => ({ status: 500, data: '{"error":"backend"}' }))
  const failAfterRetry = () => defaultResponder(() => ({ status: 401, data: '' }))

  it('listCalendars', async () => {
    const { mod } = await loadModule()
    fail(); await expect(mod.listCalendars()).rejects.toThrow('500')
    failAfterRetry(); await expect(mod.listCalendars()).rejects.toThrow('after refresh')
  })

  it('listDriveFiles', async () => {
    const { mod } = await loadModule()
    fail(); await expect(mod.listDriveFiles()).rejects.toThrow('500')
    failAfterRetry(); await expect(mod.listDriveFiles()).rejects.toThrow('after refresh')
  })

  it('readDriveFileText', async () => {
    const { mod } = await loadModule()
    fail(); await expect(mod.readDriveFileText('f1')).rejects.toThrow('500')
    failAfterRetry(); await expect(mod.readDriveFileText('f1')).rejects.toThrow('after refresh')
  })

  it('CONTROL: a 200 with nothing in it is still an empty answer, not an error', async () => {
    const { mod } = await loadModule()
    await expect(mod.listDriveFiles()).resolves.toEqual([])
  })
})
