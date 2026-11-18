// TEAMSAPPROVECARD1118: a customer's Teams main agent (v1.49.1) got none of its approval notifications. The log said
// "[notify-undelivered] ... no owner chat: .env placeholder/empty and no readable access.json". The approval
// notification (approvals.ts notifyOwner) goes through sendOwnerMessage -> resolveAlertDeliveryChat ->
// resolveAlertOwnerChat, which read <state dir>/access.json for every provider; the Teams plugin writes no such file,
// its paired users are in allowlist.json. #2682 fixed the token and the object-id -> 1:1 chat legs, but its test handed
// the owner id in from outside, so this leg was never exercised.
//
// A fake install with the plugin's real state files (allowlist.json + conversation-refs.json, no access.json) and every
// request stubbed: the owner message must go out to the owner's 1:1 chat, and nothing may say "no owner chat".
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return {
    ...a,
    PROJECT_ROOT: H.root,
    INSTALL_ROOT: H.root,
    STORE_DIR: `${H.root}/store`,
    CHANNEL_PROVIDER: 'teams' as const,
    CHANNEL_TOKEN: 'app-1',
    CHANNEL_CHAT_ID: '0',
    ALLOWED_CHAT_ID: '0',
  }
})

const root = mkdtempSync(join(tmpdir(), 'teams-owner-alert-'))
H.root = root
mkdirSync(join(root, 'store'), { recursive: true })
const STATE = join(root, 'teams-state')
mkdirSync(STATE, { recursive: true })
const OWNER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER = '11111111-2222-3333-4444-555555555555'
const CONV = 'a:1ownerPersonalChat'
writeFileSync(join(STATE, '.env'), 'TEAMS_BOT_APP_ID=app-1\nTEAMS_BOT_APP_PASSWORD=sec-1\nTEAMS_BOT_TENANT_ID=t-1\n')
writeFileSync(join(STATE, 'conversation-refs.json'), JSON.stringify({
  version: 1,
  refs: [{ conversationId: CONV, aadObjectId: OWNER, lastSeen: 1, ref: { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: CONV, conversationType: 'personal' } } }],
}))
const allowlist = (ids: string[]) =>
  writeFileSync(join(STATE, 'allowlist.json'), JSON.stringify({ version: 1, entries: ids.map((id) => ({ aad_object_id: id, added_at: '2026-11-17T08:00:00Z' })) }))

const origEnv = process.env.TEAMS_STATE_DIR
process.env.TEAMS_STATE_DIR = STATE
afterAll(() => {
  if (origEnv === undefined) delete process.env.TEAMS_STATE_DIR
  else process.env.TEAMS_STATE_DIR = origEnv
  rmSync(root, { recursive: true, force: true })
})

function stubFetch() {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    if (url.startsWith('https://login.microsoftonline.com/')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: 'act-1' }), { status: 201 })
  }))
  return urls
}

const { sendOwnerMessage, setOwnerChatMissingSink } = await import('../notify.js')
const { clearTeamsTokenCache } = await import('../teams-send.js')
const signals: string[] = []
setOwnerChatMissingSink((t) => { signals.push(t) })
afterEach(() => {
  vi.unstubAllGlobals()
  clearTeamsTokenCache()
  signals.length = 0
  setOwnerChatMissingSink((t) => { signals.push(t) })
})

describe('the owner message of a Teams main agent, owner paired the way the plugin pairs (allowlist.json)', () => {
  it('goes out to the paired owner 1:1 chat, with no "no owner chat" signal', async () => {
    allowlist([OWNER.toUpperCase()])
    const urls = stubFetch()
    const r = await sendOwnerMessage('[approval] email_send')
    expect(signals).toEqual([])
    expect(r.sent).toBe(true)
    expect(urls).toEqual([
      'https://login.microsoftonline.com/t-1/oauth2/v2.0/token',
      `https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(CONV)}/activities`,
    ])
  })

  it('two paired users: nothing is sent, and the signal names the reason instead of a missing access.json', async () => {
    allowlist([OWNER, OTHER])
    const urls = stubFetch()
    const r = await sendOwnerMessage('[approval] email_send')
    expect(r).toEqual({ sent: false, reason: 'no-owner-chat' })
    expect(urls).toEqual([])
    expect(signals).toHaveLength(1)
    expect(signals[0]).toContain('the Teams allowlist.json has 2 paired users, refusing to guess')
    expect(signals[0]).not.toContain('access.json)')
  })
})

describe('resolveOwnerChatId on Teams (the digest, welcome and command-task target): exactly one paired user, as for alerts', () => {
  // #2884 review: the first-entry heuristic of the other providers would hand owner content to whoever was paired
  // first. Teams takes the alert rule: one paired user is the owner, none or several is null.
  async function digestTarget(allowlistIds: string[] | null, configured = '0') {
    const { resolveOwnerChatId } = await import('../owner-chat.js')
    const files: Record<string, string> = { 'access.json': JSON.stringify({ allowFrom: ['999'] }) }
    if (allowlistIds) files['allowlist.json'] = JSON.stringify({ version: 1, entries: allowlistIds.map((id) => ({ aad_object_id: id })) })
    const reader = (p: string) => {
      const hit = Object.keys(files).find((k) => p.endsWith(`/${k}`))
      if (!hit) throw new Error('ENOENT')
      return files[hit]
    }
    return resolveOwnerChatId(reader, configured, 'teams')
  }
  it('one paired user: that user, from allowlist.json, never access.json', async () => {
    expect(await digestTarget([OWNER.toUpperCase()])).toBe(OWNER)
  })
  it('two paired users: null, not the first one', async () => {
    expect(await digestTarget([OWNER, OTHER])).toBeNull()
    expect(await digestTarget([OTHER, OWNER])).toBeNull()
  })
  it('no allowlist.json: null; a configured conversation id wins', async () => {
    expect(await digestTarget(null)).toBeNull()
    expect(await digestTarget([OWNER, OTHER], 'a:1configured')).toBe('a:1configured')
  })
})
