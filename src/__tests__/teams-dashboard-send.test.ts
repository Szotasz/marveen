// Behavioural suite for the Teams direct dashboard send (src/teams-send.ts,
// wired through teamsProvider.sendMessage). No network: fetch is injected (or
// stubbed globally at the provider level), the login and Bot Framework
// endpoints answer from a per-URL table, and every request is recorded so the
// tests can pin URLs, headers, bodies and -- above all -- the ORDER: a missing
// or foreign serviceUrl must fail before any token is requested or sent.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from '../logger.js'
import {
  isTeamsServiceUrl,
  readTeamsServiceUrl,
  getTeamsBotToken,
  sendTeamsMessage,
  clearTeamsTokenCache,
  TeamsConfigError,
  type TeamsCreds,
} from '../teams-send.js'
import { getProvider, readTeamsCreds } from '../channel-provider.js'
import { classifySendError } from '../pending-retries.js'

// -- fixtures --------------------------------------------------------------

const TOKEN_URL = 'https://login.microsoftonline.com/t-1/oauth2/v2.0/token'
const SEND_URL = 'https://smba.trafficmanager.net/emea/v3/conversations/a%3A1x/activities'
const CONVERSATION = 'a:1x'
const CREDS: TeamsCreds = { appId: 'app-1', secret: 'sec-1', tenant: 't-1' }

/** The conversation-refs.json entry the Teams plugin writes at pairing time. */
function validRefs(serviceUrl = 'https://smba.trafficmanager.net/emea/', conversationId = CONVERSATION) {
  return {
    version: 1,
    refs: [
      {
        conversationId,
        ref: {
          serviceUrl,
          conversation: { id: conversationId, conversationType: 'personal', tenantId: 't-1' },
          bot: { id: '28:bot' },
        },
        aadObjectId: 'aaaa',
        lastSeen: 1,
      },
    ],
  }
}

/** A temp state directory holding a valid refs file for the default conversation. */
function stateDirWithRefs(refs: unknown = validRefs()): string {
  const dir = mkdtempSync(join(tmpdir(), 'teams-send-'))
  writeFileSync(join(dir, 'conversation-refs.json'), typeof refs === 'string' ? refs : JSON.stringify(refs))
  return dir
}

// A fetch that records (url, init) and answers from a per-URL table; an
// unlisted URL throws, so an unexpected outbound request fails the test.
function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const recorded = init ?? {}
    calls.push({ url, init: recorded })
    const route = routes[url]
    if (!route) throw new TypeError(`fetch failed: unexpected URL ${url}`)
    return route(recorded)
  }) as typeof fetch
  return { impl, calls }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A working token + send route pair: token 'tok-1', send answers 201 {id:'m1'}. */
function happyRoutes(tokenBody: Record<string, unknown> = { access_token: 'tok-1', expires_in: 3600 }) {
  return {
    [TOKEN_URL]: () => jsonResponse(200, tokenBody),
    [SEND_URL]: () => jsonResponse(201, { id: 'm1' }),
  }
}

/** Every temp directory created during a test, removed afterwards. */
let scratch: string[] = []
const scratchDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'teams-send-'))
  scratch.push(d)
  return d
}

beforeEach(() => {
  clearTeamsTokenCache()
})

afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch = []
  delete process.env.TEAMS_STATE_DIR
  delete process.env.TEAMS_SERVICE_URL
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// -- S1: the serviceUrl allowlist -------------------------------------------

describe('isTeamsServiceUrl (Bot Framework host allowlist)', () => {
  it('accepts the bare host and the regional form, rejects everything else', () => {
    expect(isTeamsServiceUrl('https://smba.trafficmanager.net/teams/')).toBe(true)
    expect(isTeamsServiceUrl('https://smba.emea.trafficmanager.net/')).toBe(true)

    expect(isTeamsServiceUrl('http://smba.trafficmanager.net/')).toBe(false)
    expect(isTeamsServiceUrl('https://u:p@smba.trafficmanager.net/')).toBe(false)
    expect(isTeamsServiceUrl('https://smba.trafficmanager.net:444/')).toBe(false)
    expect(isTeamsServiceUrl('https://evil.trafficmanager.net/')).toBe(false)
    expect(isTeamsServiceUrl('https://smba.a.b.trafficmanager.net/')).toBe(false)
    expect(isTeamsServiceUrl('https://smba.trafficmanager.net.evil.com/')).toBe(false)
    // An IP literal must never pass (assembled without a literal here; it is
    // only a rejected input, never a destination).
    const ipLiteral = 'https://' + ['10', '0', '0', '1'].join('.') + '/'
    expect(isTeamsServiceUrl(ipLiteral)).toBe(false)
    expect(isTeamsServiceUrl('not a url')).toBe(false)
  })
})

// -- S2: reading the conversation reference ---------------------------------

describe('readTeamsServiceUrl (reason per failure)', () => {
  it('returns the stored serviceUrl for a matching entry', () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({ url: 'https://smba.trafficmanager.net/emea/' })
  })

  it('reason: no conversation-refs.json in the Teams state directory', () => {
    const dir = scratchDir()
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({
      reason: 'no conversation-refs.json in the Teams state directory',
    })
  })

  it('reason: conversation-refs.json is not a regular file (symlink)', () => {
    const dir = scratchDir()
    writeFileSync(join(dir, 'real-refs.json'), JSON.stringify(validRefs()))
    symlinkSync(join(dir, 'real-refs.json'), join(dir, 'conversation-refs.json'))
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({
      reason: 'conversation-refs.json is not a regular file',
    })
  })

  it('reason: conversation-refs.json belongs to another user', () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const uid = process.getuid?.() ?? null
    expect(readTeamsServiceUrl(dir, CONVERSATION, { uid: uid === null ? 999_999 : uid + 1 })).toEqual({
      reason: 'conversation-refs.json belongs to another user',
    })
  })

  it('reason: conversation-refs.json is too large (1 MiB + 1 byte)', () => {
    const dir = scratchDir()
    writeFileSync(join(dir, 'conversation-refs.json'), 'x'.repeat(1_048_576 + 1))
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({ reason: 'conversation-refs.json is too large' })
  })

  it('reason: conversation-refs.json has an unexpected format (not JSON / wrong version)', () => {
    const dir = scratchDir()
    writeFileSync(join(dir, 'conversation-refs.json'), 'not json at all')
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({ reason: 'conversation-refs.json has an unexpected format' })

    const dir2 = scratchDir()
    writeFileSync(join(dir2, 'conversation-refs.json'), JSON.stringify({ version: 2, refs: [] }))
    expect(readTeamsServiceUrl(dir2, CONVERSATION)).toEqual({ reason: 'conversation-refs.json has an unexpected format' })
  })

  it('reason: no conversation reference for the target conversation', () => {
    const dir = stateDirWithRefs(validRefs(undefined, 'a:different'))
    scratch.push(dir)
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({
      reason: 'no conversation reference for the target conversation',
    })
  })

  it('an entry whose nested ref.conversation.id differs from its conversationId is not a match', () => {
    const refs = validRefs()
    refs.refs[0].ref.conversation.id = 'a:different'
    const dir = stateDirWithRefs(refs)
    scratch.push(dir)
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({
      reason: 'no conversation reference for the target conversation',
    })
  })

  it('reason: the stored serviceUrl is not a Teams service host', () => {
    const dir = stateDirWithRefs(validRefs('https://evil.example/'))
    scratch.push(dir)
    expect(readTeamsServiceUrl(dir, CONVERSATION)).toEqual({
      reason: 'the stored serviceUrl is not a Teams service host',
    })
  })
})

// -- S3/S4: the token request and the send -----------------------------------

describe('sendTeamsMessage (happy path)', () => {
  it('requests a client-credentials token, then POSTs the activity to the recorded serviceUrl', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const { impl, calls } = fakeFetch(happyRoutes())

    const receipt = await sendTeamsMessage(CREDS, dir, CONVERSATION, 'hello teams', { fetch: impl, now: () => 1_000_000 })

    expect(receipt).toEqual({ status: 201, messageId: 'm1' })
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, SEND_URL])

    const tokenInit = calls[0].init
    expect(tokenInit.method).toBe('POST')
    expect((tokenInit.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded')
    expect(tokenInit.redirect).toBe('error')
    expect(tokenInit.signal).toBeInstanceOf(AbortSignal)
    expect(tokenInit.body).toBeInstanceOf(URLSearchParams)
    const form = tokenInit.body as URLSearchParams
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('app-1')
    expect(form.get('client_secret')).toBe('sec-1')
    expect(form.get('scope')).toBe('https://api.botframework.com/.default')

    const sendInit = calls[1].init
    expect(sendInit.method).toBe('POST')
    expect((sendInit.headers as Record<string, string>).authorization).toBe('Bearer tok-1')
    expect((sendInit.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(sendInit.body).toBe(JSON.stringify({ type: 'message', text: 'hello teams' }))
    expect(sendInit.redirect).toBe('error')
    expect(sendInit.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('getTeamsBotToken / token cache', () => {
  it('reuses one token across sends and refreshes it after obtainedAt + (expires_in - 300) s', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    let nowMs = 1_000_000
    const deps = { now: () => nowMs }
    const { impl, calls } = fakeFetch({
      ...happyRoutes(),
      'https://smba.trafficmanager.net/emea/v3/conversations/a%3A1x/activities': () => jsonResponse(200, {}),
    })

    await sendTeamsMessage(CREDS, dir, CONVERSATION, 'one', { ...deps, fetch: impl })
    await sendTeamsMessage(CREDS, dir, CONVERSATION, 'two', { ...deps, fetch: impl })
    // obtainedAt = 1_000_000, expires_in 3600 -> reuse while now() < 4_300_000.
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1)

    nowMs = 4_300_001 // one millisecond past the reuse window
    await sendTeamsMessage(CREDS, dir, CONVERSATION, 'three', { ...deps, fetch: impl })
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2)
  })
})

// -- S5-S7: nothing is requested or sent when the route is missing/foreign --

describe('sendTeamsMessage (serviceUrl resolution before any request)', () => {
  it('no ref and no TEAMS_SERVICE_URL -> TeamsConfigError, fetch never called, one warn', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const dir = stateDirWithRefs(validRefs(undefined, 'a:different')) // nothing for CONVERSATION
    scratch.push(dir)
    const { impl, calls } = fakeFetch(happyRoutes())

    const err = await sendTeamsMessage(CREDS, dir, CONVERSATION, 'hi', { fetch: impl, env: {} }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(TeamsConfigError)
    expect(err?.message).toMatch(/^Teams API config: /)
    expect(calls).toEqual([]) // the token was never requested
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      { provider: 'teams', reason: 'no conversation reference for the target conversation' },
      'Teams riasztas nem kuldheto',
    )
  })

  it('no ref + TEAMS_SERVICE_URL override: sends there when allowed, fails locally when not', async () => {
    const dir = stateDirWithRefs(validRefs(undefined, 'a:different'))
    scratch.push(dir)

    // Allowed override: the send goes to the override host.
    const ok = fakeFetch({
      'https://login.microsoftonline.com/t-1/oauth2/v2.0/token': () => jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }),
      'https://smba.trafficmanager.net/teams/v3/conversations/a%3A1x/activities': () => jsonResponse(200, { id: 'm2' }),
    })
    const receipt = await sendTeamsMessage(CREDS, dir, CONVERSATION, 'hi', {
      fetch: ok.impl,
      env: { TEAMS_SERVICE_URL: 'https://smba.trafficmanager.net/teams/' },
    })
    expect(receipt).toEqual({ status: 200, messageId: 'm2' })

    // Foreign override: a config error, and no token was ever requested.
    const foreign = fakeFetch(happyRoutes())
    await expect(
      sendTeamsMessage(CREDS, dir, CONVERSATION, 'hi', {
        fetch: foreign.impl,
        env: { TEAMS_SERVICE_URL: 'https://evil.example/' },
      }),
    ).rejects.toThrow('Teams API config: TEAMS_SERVICE_URL is not a Teams service host')
    expect(foreign.calls).toEqual([])
  })

  it('a ref with a foreign serviceUrl -> TeamsConfigError, fetch never called', async () => {
    const dir = stateDirWithRefs(validRefs('https://evil.example/'))
    scratch.push(dir)
    const { impl, calls } = fakeFetch(happyRoutes())

    await expect(sendTeamsMessage(CREDS, dir, CONVERSATION, 'hi', { fetch: impl, env: {} })).rejects.toThrow(
      'Teams API config: the stored serviceUrl is not a Teams service host',
    )
    expect(calls).toEqual([]) // the token is never requested and never sent anywhere
  })

  it('a rejected refs file is not masked by TEAMS_SERVICE_URL: the override is only for a missing reference', async () => {
    const env = { TEAMS_SERVICE_URL: 'https://smba.trafficmanager.net/teams/' }
    const foreign = stateDirWithRefs(validRefs('https://evil.example/'))
    scratch.push(foreign)
    const f1 = fakeFetch(happyRoutes())
    await expect(sendTeamsMessage(CREDS, foreign, CONVERSATION, 'hi', { fetch: f1.impl, env })).rejects.toThrow(
      'Teams API config: the stored serviceUrl is not a Teams service host',
    )
    expect(f1.calls).toEqual([])

    const bad = stateDirWithRefs('{"version":2,"refs":[]}')
    scratch.push(bad)
    const f2 = fakeFetch(happyRoutes())
    await expect(sendTeamsMessage(CREDS, bad, CONVERSATION, 'hi', { fetch: f2.impl, env })).rejects.toThrow(
      'Teams API config: conversation-refs.json has an unexpected format',
    )
    expect(f2.calls).toEqual([])
  })
})

// -- S8: the secret and the token never leak ----------------------------------

describe('sendTeamsMessage (secret and token hygiene)', () => {
  const SECRET = 'SECRET-XYZ'
  const TOKEN = 'TOKEN-ABC'
  const CREDS_LEAK: TeamsCreds = { appId: 'app-1', secret: SECRET, tenant: 't-1' }

  /** Every argument the spied logger methods were called with, as one string. */
  function loggedText(): string {
    const parts: string[] = []
    for (const level of ['warn', 'info', 'error'] as const) {
      for (const call of vi.mocked(logger[level]).mock.calls) {
        parts.push(JSON.stringify(call))
      }
    }
    return parts.join('\n')
  }

  beforeEach(() => {
    vi.spyOn(logger, 'warn')
    vi.spyOn(logger, 'info')
    vi.spyOn(logger, 'error')
  })

  it('(a) token 401: the Entra body may echo the secret, the error never does', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const { impl } = fakeFetch({
      [TOKEN_URL]: () =>
        jsonResponse(401, {
          error: 'invalid_client',
          error_description: `AADSTS7000215: Invalid client secret provided ${SECRET}`,
          error_codes: [7000215],
        }),
    })

    const err = await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: impl, env: {} }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(TeamsConfigError)
    expect(err?.message).toMatch(/^Teams API config: token request refused \(HTTP 401, AADSTS7000215\)$/)
    expect(err?.message).not.toContain(SECRET)
    expect(err?.message).not.toContain(TOKEN)
    expect(loggedText()).not.toContain(SECRET)
    expect(loggedText()).not.toContain(TOKEN)
  })

  it('(b) send 403: the detail is error.code + error.message only, never the bearer value', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    // The token sits in a body field OUTSIDE error.code/error.message (those
    // two are legitimately quoted) -- it must not reach the error either way.
    const { impl } = fakeFetch({
      [TOKEN_URL]: () => jsonResponse(200, { access_token: TOKEN, expires_in: 3600 }),
      [SEND_URL]: () =>
        jsonResponse(403, {
          error: { code: 'BlockedByPolicy', message: 'The bot is blocked from this conversation' },
          authorization: `Bearer ${TOKEN}`,
        }),
    })

    const err = await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: impl, env: {} }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err?.message).toBe('Teams API 403: BlockedByPolicy The bot is blocked from this conversation')
    expect(err?.message).not.toContain(TOKEN)
    expect(err?.message).not.toContain('Bearer')
    expect(loggedText()).not.toContain(SECRET)
    expect(loggedText()).not.toContain(TOKEN)

    // And when the token would only appear past the 200-character cut, the cut
    // drops it: the detail is capped, so a far-away echo cannot travel either.
    const cut = fakeFetch({
      [TOKEN_URL]: () => jsonResponse(200, { access_token: TOKEN, expires_in: 3600 }),
      [SEND_URL]: () =>
        jsonResponse(403, {
          error: { code: 'BlockedByPolicy', message: 'x'.repeat(250) + ` ${TOKEN}` },
        }),
    })
    const errCut = await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: cut.impl, env: {} }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(errCut?.message).toBe('Teams API 403: ' + ('BlockedByPolicy ' + 'x'.repeat(250)).slice(0, 200))
    expect(errCut?.message).not.toContain(TOKEN)
  })

  it('(c) send network error: the message carries no credential', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const { impl } = fakeFetch({
      [TOKEN_URL]: () => jsonResponse(200, { access_token: TOKEN, expires_in: 3600 }),
      [SEND_URL]: () => {
        throw new TypeError('fetch failed')
      },
    })

    const err = await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: impl, env: {} }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err?.message).toBe('Teams API: send failed (network error or timeout)')
    expect(err?.message).not.toContain(SECRET)
    expect(err?.message).not.toContain(TOKEN)
    expect(loggedText()).not.toContain(SECRET)
    expect(loggedText()).not.toContain(TOKEN)
  })

  it('(e) a send error body that echoes the token or the secret is scrubbed', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const routes = {
      ...happyRoutes({ access_token: TOKEN, expires_in: 3600 }),
      [SEND_URL]: () => jsonResponse(403, { error: { code: 'Forbidden', message: `rejected Bearer ${TOKEN} for ${SECRET}` } }),
    }
    const { impl } = fakeFetch(routes)
    const err = (await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: impl, env: {} }).catch((e: unknown) => e)) as Error
    expect(err?.message).toMatch(/^Teams API 403: Forbidden rejected Bearer \[redacted\] for \[redacted\]$/)
    expect(err?.message).not.toContain(TOKEN)
    expect(err?.message).not.toContain(SECRET)
  })

  it('(f) a response id that carries the token or the secret is not passed on as the messageId', async () => {
    for (const echoed of [TOKEN, `x${SECRET}`]) {
      clearTeamsTokenCache()
      const dir = stateDirWithRefs()
      scratch.push(dir)
      const routes = {
        ...happyRoutes({ access_token: TOKEN, expires_in: 3600 }),
        [SEND_URL]: () => jsonResponse(201, { id: echoed }),
      }
      const { impl } = fakeFetch(routes)
      const receipt = await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: impl, env: {} })
      expect(receipt).toEqual({ status: 201, messageId: undefined })
    }
  })

  it('(d) success: the receipt carries no credential', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const { impl } = fakeFetch(happyRoutes({ access_token: TOKEN, expires_in: 3600 }))

    const receipt = await sendTeamsMessage(CREDS_LEAK, dir, CONVERSATION, 'hi', { fetch: impl, env: {} })
    expect(JSON.stringify(receipt)).not.toContain(SECRET)
    expect(JSON.stringify(receipt)).not.toContain(TOKEN)
    expect(loggedText()).not.toContain(SECRET)
    expect(loggedText()).not.toContain(TOKEN)
  })
})

// -- S9: retry classification -------------------------------------------------

describe('sendTeamsMessage + classifySendError (transient vs permanent)', () => {
  const cases: Array<{ status: number; body: Record<string, unknown>; expected: 'transient' | 'permanent' }> = [
    { status: 403, body: { error: { code: 'BlockedByPolicy', message: 'bot is blocked' } }, expected: 'permanent' },
    { status: 503, body: {}, expected: 'transient' },
    { status: 429, body: {}, expected: 'transient' },
  ]

  it('non-2xx sends throw "Teams API <status>: ..." and classify by status', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)

    for (const c of cases) {
      clearTeamsTokenCache()
      const { impl } = fakeFetch({
        [TOKEN_URL]: () => jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }),
        [SEND_URL]: () => jsonResponse(c.status, c.body),
      })
      const err = await sendTeamsMessage(CREDS, dir, CONVERSATION, 'hi', { fetch: impl, env: {} }).then(
        () => undefined,
        (e: Error) => e,
      )
      expect(err?.message).toMatch(new RegExp(`^Teams API ${c.status}: `))
      expect(classifySendError(err!.message)).toBe(c.expected)
    }

    expect(classifySendError('Teams API config: no conversation reference for the target conversation')).toBe('permanent')
    expect(classifySendError('Teams API: send failed (network error or timeout)')).toBe('transient')
  })
})

// -- S10: incomplete credentials ----------------------------------------------

describe('sendTeamsMessage (incomplete credentials)', () => {
  it('missing secret or tenant -> TeamsConfigError, fetch never called', async () => {
    const dir = stateDirWithRefs()
    scratch.push(dir)
    const { impl, calls } = fakeFetch(happyRoutes())

    for (const creds of [
      { appId: 'app-1', secret: '', tenant: 't-1' },
      { appId: 'app-1', secret: 'sec-1', tenant: '' },
    ] satisfies TeamsCreds[]) {
      await expect(sendTeamsMessage(creds, dir, CONVERSATION, 'hi', { fetch: impl, env: {} })).rejects.toThrow(
        'Teams API config: Teams credentials incomplete ' +
          '(TEAMS_BOT_APP_ID, TEAMS_BOT_APP_PASSWORD and TEAMS_BOT_TENANT_ID are all needed)',
      )
    }
    expect(calls).toEqual([])
  })
})

// -- S11: the provider level and the credential lookup ------------------------

describe('teamsProvider.sendMessage (provider level)', () => {
  it("sends over the Bot Framework REST API from the channel state dir's credentials", async () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, '.env'),
      'TEAMS_BOT_APP_ID=app-1\nTEAMS_BOT_APP_PASSWORD=s\nTEAMS_BOT_TENANT_ID=t-1\n',
    )
    writeFileSync(join(dir, 'conversation-refs.json'), JSON.stringify(validRefs()))
    process.env.TEAMS_STATE_DIR = dir // channelStateDir('teams') honours the override

    const { impl, calls } = fakeFetch(happyRoutes())
    vi.stubGlobal('fetch', impl)

    // Today this call throws 'teams: direct dashboard send not supported'.
    const receipt = await getProvider('teams').sendMessage('app-1', CONVERSATION, 'hello')
    expect(receipt).toEqual({ status: 201, messageId: 'm1' })
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, SEND_URL])
  })
})

describe('readTeamsCreds (first file with TEAMS_BOT_APP_ID wins, never mixed)', () => {
  it('the first file with a TEAMS_BOT_APP_ID supplies all three keys; a second file is never mixed in', () => {
    const dir = scratchDir()
    const first = join(dir, 'one.env')
    const second = join(dir, 'two.env')

    // The first file has the app id (and a secret, but no tenant): its values
    // win and the second file's tenant/secret are NOT merged in.
    writeFileSync(first, 'TEAMS_BOT_APP_ID=app-first\nTEAMS_BOT_APP_PASSWORD=p1\n')
    writeFileSync(second, 'TEAMS_BOT_APP_ID=app-second\nTEAMS_BOT_APP_PASSWORD=p2\nTEAMS_BOT_TENANT_ID=t2\n')
    expect(readTeamsCreds('fallback', [first, second])).toEqual({ appId: 'app-first', secret: 'p1', tenant: '' })

    // Without an app id in the first file it is skipped entirely.
    writeFileSync(first, 'TEAMS_BOT_APP_PASSWORD=only-secret\n')
    expect(readTeamsCreds('fallback', [first, second])).toEqual({ appId: 'app-second', secret: 'p2', tenant: 't2' })
  })

  it('neither file -> the fallback app id with an empty secret and tenant', () => {
    const dir = scratchDir()
    expect(readTeamsCreds('fallback-app', [join(dir, 'missing-a.env'), join(dir, 'missing-b.env')])).toEqual({
      appId: 'fallback-app',
      secret: '',
      tenant: '',
    })
  })
})
