// TEAMSALERTENV1110: a main agent on Teams, set up the documented way (CHANNEL_PROVIDER=teams in the install .env,
// the bot keys only in the main agent's Teams channel .env, an owner paired through access.json), sent none of its
// owner alerts. Measured on a fake install: first "no-token" (CHANNEL_TOKEN read only the install .env), and with
// that worked around, "no conversation reference" (the owner "chat" is the paired person's Entra object id, not a
// conversation id). These tests pin both legs: the token fallback and the object-id -> 1:1 chat resolution.

import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getMainChannelToken } from '../channel-provider.js'
import { resolveTeamsTarget, sendTeamsMessage, clearTeamsTokenCache, TeamsConfigError, type TeamsCreds } from '../teams-send.js'

const OWNER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER = '11111111-2222-3333-4444-555555555555'
const CONV = 'a:1ownerPersonalChat'
const CREDS: TeamsCreds = { appId: 'app-1', secret: 'sec-1', tenant: 't-1' }

function entry(over: Record<string, unknown> = {}, conv: Record<string, unknown> = {}) {
  const conversationId = (over.conversationId as string | undefined) ?? CONV
  return {
    conversationId,
    aadObjectId: OWNER,
    lastSeen: 10,
    ref: {
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversation: { id: conversationId, conversationType: 'personal', ...conv },
    },
    ...over,
  }
}

const dirs: string[] = []
function stateDir(refs: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'teams-main-alert-'))
  dirs.push(dir)
  if (refs !== undefined) writeFileSync(join(dir, 'conversation-refs.json'), typeof refs === 'string' ? refs : JSON.stringify(refs))
  return dir
}
function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'teams-main-env-'))
  dirs.push(dir)
  const p = join(dir, '.env')
  writeFileSync(p, content)
  return p
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  clearTeamsTokenCache()
  vi.restoreAllMocks()
})

describe('getMainChannelToken', () => {
  it('Teams: falls back to the main agent Teams channel .env when the install .env has no app id', () => {
    const p = envFile('TEAMS_BOT_APP_ID=app-from-channel\nTEAMS_BOT_APP_PASSWORD=x\n')
    expect(getMainChannelToken('teams', {}, () => p)).toBe('app-from-channel')
  })
  it('Teams: the install .env still wins when it has the app id', () => {
    const p = envFile('TEAMS_BOT_APP_ID=app-from-channel\n')
    expect(getMainChannelToken('teams', { TEAMS_BOT_APP_ID: 'app-from-install' }, () => p)).toBe('app-from-install')
  })
  it('Teams: a commented-out line in the channel .env is not a token', () => {
    const p = envFile('# TEAMS_BOT_APP_ID=old\n')
    expect(getMainChannelToken('teams', {}, () => p)).toBe('')
  })
  it('Teams: no channel .env is no token', () => {
    expect(getMainChannelToken('teams', {}, () => '/nonexistent/teams/.env')).toBe('')
  })
  it('other providers never read the Teams channel .env', () => {
    const p = envFile('TEAMS_BOT_APP_ID=app-from-channel\nSLACK_BOT_TOKEN=xoxb-x\nTELEGRAM_BOT_TOKEN=1:x\n')
    const read = vi.fn(() => p)
    expect(getMainChannelToken('slack', {}, read)).toBe('')
    expect(getMainChannelToken('telegram', {}, read)).toBe('')
    expect(read).not.toHaveBeenCalled()
  })
  it('config.ts takes CHANNEL_TOKEN from getMainChannelToken (the call site that made the alerts no-token)', () => {
    const src = readFileSync(join(__dirname, '..', 'config.ts'), 'utf-8')
    expect(src).toMatch(/^export const CHANNEL_TOKEN = getMainChannelToken\(CHANNEL_PROVIDER, env\)$/m)
  })
})

describe('resolveTeamsTarget', () => {
  it('a conversation id passes through without reading the refs file', () => {
    const readFile = vi.fn(() => { throw new Error('must not read') })
    expect(resolveTeamsTarget('/nowhere', CONV, { readFile })).toEqual({ conversationId: CONV })
    expect(readFile).not.toHaveBeenCalled()
  })
  it('an Entra object id becomes that person 1:1 chat', () => {
    expect(resolveTeamsTarget(stateDir({ version: 1, refs: [entry()] }), OWNER)).toEqual({ conversationId: CONV })
  })
  it('the object id matches case-insensitively', () => {
    expect(resolveTeamsTarget(stateDir({ version: 1, refs: [entry()] }), OWNER.toUpperCase())).toEqual({ conversationId: CONV })
  })
  it('another person, a group chat, a channel, a chat the bot opened, a missing type or disagreeing ids never stand in', () => {
    const refs = [
      entry({ aadObjectId: OTHER }),
      entry({ conversationId: '19:g@thread.v2' }, { conversationType: 'groupChat' }),
      entry({ conversationId: '19:c@thread.tacv2' }, { conversationType: 'channel' }),
      entry({ conversationId: 'a:1botOpened', botOpened: true }),
      entry({ conversationId: 'a:1noType' }, { conversationType: undefined }),
      { ...entry({ conversationId: 'a:1outer' }), ref: { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: 'a:1inner', conversationType: 'personal' } } },
    ]
    const r = resolveTeamsTarget(stateDir({ version: 1, refs }), OWNER)
    expect(r).toEqual({ reason: 'no personal chat with the bot is recorded for the paired Teams user' })
  })
  it('of two personal chats of the same person the most recently seen wins', () => {
    const refs = [entry({ conversationId: 'a:1older', lastSeen: 5 }), entry({ conversationId: 'a:1newer', lastSeen: 50 }), entry({ conversationId: 'a:1mid', lastSeen: 20 })]
    expect(resolveTeamsTarget(stateDir({ version: 1, refs }), OWNER)).toEqual({ conversationId: 'a:1newer' })
  })
  it('no refs file, or one in the wrong format, is a reason, not a guess', () => {
    const none = resolveTeamsTarget(stateDir(undefined), OWNER)
    expect('reason' in none && none.reason).toMatch(/cannot be looked up: no conversation-refs.json/)
    const bad = resolveTeamsTarget(stateDir('{"version":2,"refs":[]}'), OWNER)
    expect('reason' in bad && bad.reason).toMatch(/cannot be looked up: .*unexpected format/)
  })
})

describe('sendTeamsMessage with a paired person as the target', () => {
  function recordingFetch() {
    const urls: string[] = []
    const f = vi.fn(async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input)
      urls.push(url)
      if (url.startsWith('https://login.microsoftonline.com/')) {
        return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'act-1' }), { status: 201 })
    })
    return { f: f as unknown as typeof fetch, urls }
  }

  it('posts to the person 1:1 chat, never to the object id', async () => {
    const { f, urls } = recordingFetch()
    const res = await sendTeamsMessage(CREDS, stateDir({ version: 1, refs: [entry()] }), OWNER, 'riasztas', { fetch: f, env: {} })
    expect(res.status).toBe(201)
    expect(urls).toEqual([
      'https://login.microsoftonline.com/t-1/oauth2/v2.0/token',
      `https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(CONV)}/activities`,
    ])
    expect(urls.join(' ')).not.toContain(OWNER)
  })
  it('an unresolvable person sends nothing: no token request, no post, even with TEAMS_SERVICE_URL set', async () => {
    const { f, urls } = recordingFetch()
    await expect(sendTeamsMessage(CREDS, stateDir({ version: 1, refs: [entry({ aadObjectId: OTHER })] }), OWNER, 'x',
      { fetch: f, env: { TEAMS_SERVICE_URL: 'https://smba.trafficmanager.net/emea/' } })).rejects.toBeInstanceOf(TeamsConfigError)
    expect(urls).toEqual([])
  })
})
