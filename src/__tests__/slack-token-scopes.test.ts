/**
 * SLACKSCOPEJELZ1007: the Slack token test reports the granted bot scopes and
 * the manifest scopes it lacks, read from auth.test's x-oauth-scopes header.
 * Why: the slack-channel plugin needs im:read to write to an allowFrom user's
 * DM after a restart (SLACKOUTDM1007), and nothing in the dashboard could tell
 * whether an install's app has it.
 *
 * What each part proves: the header is parsed; a token with every manifest
 * scope reports none missing; a token without im:read reports exactly it; a
 * response WITHOUT the header makes no claim either way; a refused token stays
 * a failure; and, as source pins, the /test route passes the list on and the
 * dashboard warns (both languages) instead of saying "all right". fetch is
 * stubbed: no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProvider, missingSlackScopes, parseSlackScopes } from '../channel-provider.js'

const ALL = 'app_mentions:read,channels:history,channels:read,chat:write,files:read,files:write,groups:history,groups:read,im:history,im:read,im:write,reactions:write,users:read'

function stubAuthTest(body: unknown, scopesHeader: string | null) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (scopesHeader !== null) headers.set('x-oauth-scopes', scopesHeader)
    return new Response(JSON.stringify(body), { status: 200, headers })
  })
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('parseSlackScopes / missingSlackScopes', () => {
  it('splits and trims the header; no header is null, not an empty list', () => {
    expect(parseSlackScopes(' chat:write, im:read ,users:read')).toEqual(['chat:write', 'im:read', 'users:read'])
    expect(parseSlackScopes(null)).toBeNull()
    expect(parseSlackScopes(undefined)).toBeNull()
    expect(parseSlackScopes('')).toEqual([])
  })
  it('names the manifest scopes not granted, in manifest order', () => {
    expect(missingSlackScopes(ALL.split(','))).toEqual([])
    expect(missingSlackScopes(ALL.split(',').filter(s => s !== 'im:read' && s !== 'im:write'))).toEqual(['im:read', 'im:write'])
  })
})

describe('slack validateToken', () => {
  const slack = getProvider('slack')

  it('a token with every manifest scope: ok, nothing missing', async () => {
    const calls = stubAuthTest({ ok: true, user: 'marveen' }, ALL)
    const r = await slack.validateToken('xoxb-test')
    expect(r).toMatchObject({ ok: true, botName: 'marveen', missingScopes: [] })
    expect(r.scopes).toContain('im:read')
    expect(calls).toEqual(['https://slack.com/api/auth.test'])
  })

  it('a token without im:read: ok, and im:read is named', async () => {
    stubAuthTest({ ok: true, user: 'darwin' }, ALL.split(',').filter(s => s !== 'im:read').join(','))
    const r = await slack.validateToken('xoxb-test')
    expect(r.ok).toBe(true)
    expect(r.missingScopes).toEqual(['im:read'])
  })

  it('no x-oauth-scopes header: no claim at all (not "nothing missing")', async () => {
    stubAuthTest({ ok: true, user: 'marveen' }, null)
    const r = await slack.validateToken('xoxb-test')
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('scopes')
    expect(r).not.toHaveProperty('missingScopes')
  })

  it('a refused token stays a failure', async () => {
    stubAuthTest({ ok: false, error: 'invalid_auth' }, null)
    expect(await slack.validateToken('xoxb-bad')).toEqual({ ok: false, error: 'invalid_auth' })
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  it('the /test route passes the scope report on', () => {
    expect(read('src/web/routes/agents.ts')).toContain('...(result.missingScopes ? { scopes: result.scopes, missingScopes: result.missingScopes } : {}),')
  })
  it('the dashboard warns with the missing list instead of "all right"', () => {
    const app = read('web/app.js')
    expect(app).toContain("showToast(t('channel.toast.missing_scopes', { scopes: missing.join(', ') }), true)")
    expect(app).toContain('if (missing.length > 0) {')
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      expect(read(f)).toMatch(/'channel\.toast\.missing_scopes':\s*'[^']*\{scopes\}[^']*im:read/)
    }
  })
})
