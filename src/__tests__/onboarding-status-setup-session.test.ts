// DOCKERHTTPS1119 Dani n2 (81264, Samu 81267): GET /api/onboarding/status hands a channel token saved by an earlier,
// unfinished channel step back to pre-fill the wizard. A setup session (the public listener before the first login)
// reaches this route, so it must get null there; the owner (token or session) still gets the pre-fill.
// The saved token is stubbed: a Slack install whose bot token is on disk but whose managed settings are not ready
// (the one state in which the route pre-fills).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), CHANNEL_PROVIDER: 'slack' }))
vi.mock('../channel-provider.js', async (orig) => ({
  ...(await orig<typeof import('../channel-provider.js')>()),
  readChannelToken: () => 'saved-bot-token-fixture',
}))
vi.mock('../web/routes/agents.js', async (orig) => ({ ...(await orig<typeof import('../web/routes/agents.js')>()), isManagedSettingsReady: () => false }))

const { initDatabase } = await import('../db.js')
const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')

async function status(auth: RouteContext['auth']) {
  const req = Readable.from([]) as unknown as http.IncomingMessage
  req.headers = {}
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string) { if (d !== undefined) out.body += d },
  }
  const url = new URL('http://127.0.0.1:3421/api/onboarding/status')
  expect(await tryHandleOnboarding({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method: 'GET', url, auth })).toBe(true)
  return JSON.parse(out.body || '{}') as Record<string, unknown>
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('the onboarding status does not hand a saved channel token to a setup session', () => {
  it('the owner (token) gets the pre-fill: the stub is live', async () => {
    expect((await status({ kind: 'token' })).existingBotToken).toBe('saved-bot-token-fixture')
  })

  it('a setup session gets null', async () => {
    const s = await status({ kind: 'setup' })
    expect(s.existingBotToken).toBeNull()
    expect(s.existingAppToken).toBeNull()
    expect(JSON.stringify(s)).not.toContain('saved-bot-token-fixture')
  })
})
