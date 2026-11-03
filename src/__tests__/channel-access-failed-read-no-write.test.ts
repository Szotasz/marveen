/**
 * ACCESSREADFAIL1030: every dashboard route that reads a channel plugin's
 * access.json and then writes it back must tell three cases apart:
 *   - the file does not exist      -> start fresh, exactly as before;
 *   - it exists but cannot be read -> refuse: 500, nothing written, nothing
 *                                     renamed to .corrupt-*;
 *   - it exists but is not JSON    -> refuse the same way.
 * Before the fix readFileOr's '{}' fallback turned an unreadable file into an
 * empty allowlist (allowlist remove wrote {"allowFrom":[]}), createInvite wrote
 * back {"dmPolicy":"pairing"}, and the Slack channel-request approve renamed an
 * unreadable file to .corrupt-* and replaced it. Everything runs in a temp dir.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'access-failread-'))
const AGENTS = join(ROOT, 'agents')
const NAME = 'accesstest'

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(AGENTS, name),
    readAgentChannelProvider: () => 'slack',
  }
})

vi.mock('../db.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db.js')>()
  return {
    ...orig,
    listPendingChannelRequests: () => [{ id: 7, agent: NAME, channel_id: 'C123', channel_name: 'general', user_id: 'U1', status: 'pending' }],
    updateChannelRequestStatus: () => true,
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

// chmod 000 does not stop root; the unreadable cases would then measure nothing.
const IS_ROOT = userInfo().uid === 0

const ORIGINAL = JSON.stringify({
  dmPolicy: 'allowlist',
  allowFrom: ['111', '222'],
  groups: { '-100': { requireMention: true, allowFrom: [] } },
  pending: { abc123: { senderId: '333', chatId: '333', createdAt: 1, expiresAt: 9e15 } },
}, null, 2)

function stateDir(provider: string): string {
  return join(AGENTS, NAME, '.claude', 'channels', provider)
}

function fakeCtx(method: string, path: string, body: unknown) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const raw = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    headers: {},
    on(ev: string, cb: (x?: Buffer) => void) { if (ev === 'data') cb(raw); if (ev === 'end') cb(); return req },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
  return { ctx, out }
}

async function call(method: string, path: string, body?: unknown) {
  const { ctx, out } = fakeCtx(method, path, body)
  expect(await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  return out
}

interface Route {
  label: string
  provider: string
  method: string
  path: string
  body?: unknown
  // What the route answers on a MISSING access.json (unchanged behaviour).
  missingStatus: number
  missingCheck?: (dir: string) => void
}

const ROUTES: Route[] = [
  {
    label: 'pairing approve',
    provider: 'telegram',
    method: 'POST',
    path: `/api/agents/${NAME}/channels/telegram/approve`,
    body: { code: 'abc123' },
    missingStatus: 404,
    missingCheck: (dir) => expect(existsSync(join(dir, 'access.json'))).toBe(false),
  },
  {
    label: 'allowlist user remove',
    provider: 'telegram',
    method: 'DELETE',
    path: `/api/agents/${NAME}/channels/telegram/allowed/user/111`,
    missingStatus: 200,
    missingCheck: (dir) => expect(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf-8'))).toEqual({ allowFrom: [] }),
  },
  {
    label: 'allowlist group remove',
    provider: 'telegram',
    method: 'DELETE',
    path: `/api/agents/${NAME}/channels/telegram/allowed/group/-100`,
    missingStatus: 200,
  },
  {
    label: 'Slack channel-request approve',
    provider: 'slack',
    method: 'POST',
    path: `/api/agents/${NAME}/channel-requests/7/approve`,
    body: {},
    missingStatus: 200,
    missingCheck: (dir) => expect(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf-8'))).toEqual({
      dmPolicy: 'allowlist', allowFrom: [], groups: {}, channels: { C123: { requireMention: true, allowFrom: ['U1'] } },
    }),
  },
  {
    label: 'invite create',
    provider: 'slack',
    method: 'POST',
    path: `/api/agents/${NAME}/channels/slack/invites`,
    body: {},
    missingStatus: 200,
    missingCheck: (dir) => expect(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf-8'))).toEqual({ dmPolicy: 'pairing' }),
  },
]

beforeEach(() => {
  rmSync(join(AGENTS, NAME), { recursive: true, force: true })
  mkdirSync(stateDir('telegram'), { recursive: true })
  mkdirSync(stateDir('slack'), { recursive: true })
})

afterEach(() => {
  // Restore permissions so the next beforeEach (and afterAll) can clean up.
  for (const p of ['telegram', 'slack']) {
    for (const f of ['access.json', 'invites.json']) {
      const file = join(stateDir(p), f)
      if (existsSync(file)) chmodSync(file, 0o600)
    }
  }
})

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function siblings(dir: string): string[] {
  return readdirSync(dir).sort()
}

describe.skipIf(IS_ROOT).each(ROUTES)('$label', (route) => {
  it('an UNREADABLE access.json is refused: 500, byte-identical, no .corrupt-* copy', async () => {
    const dir = stateDir(route.provider)
    const file = join(dir, 'access.json')
    writeFileSync(file, ORIGINAL)
    chmodSync(file, 0o000)
    const before = siblings(dir)

    const out = await call(route.method, route.path, route.body)

    expect(out.status).toBe(500)
    expect(String(out.body?.detail ?? out.body?.error)).toMatch(/cannot be read/)
    expect(siblings(dir)).toEqual(before)
    expect(siblings(dir).some((f) => f.includes('.corrupt-'))).toBe(false)
    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL)
  })

  it('an access.json that is NOT valid JSON is refused the same way', async () => {
    const dir = stateDir(route.provider)
    const file = join(dir, 'access.json')
    writeFileSync(file, '{"allowFrom": ["111",')
    const before = siblings(dir)

    const out = await call(route.method, route.path, route.body)

    expect(out.status).toBe(500)
    expect(siblings(dir)).toEqual(before)
    expect(readFileSync(file, 'utf-8')).toBe('{"allowFrom": ["111",')
  })

  it('a MISSING access.json behaves as before', async () => {
    const dir = stateDir(route.provider)
    const out = await call(route.method, route.path, route.body)
    expect(out.status).toBe(route.missingStatus)
    route.missingCheck?.(dir)
    expect(siblings(dir).some((f) => f.includes('.corrupt-'))).toBe(false)
  })
})

describe.skipIf(IS_ROOT)('invite create: an unreadable invites.json', () => {
  it('is refused before EITHER file is written', async () => {
    const dir = stateDir('slack')
    const access = join(dir, 'access.json')
    const invites = join(dir, 'invites.json')
    const INVITES = JSON.stringify({ invites: { tok1: { createdAt: 1, expiresAt: 9e15, used: false } } }, null, 2)
    writeFileSync(access, ORIGINAL)
    writeFileSync(invites, INVITES)
    chmodSync(invites, 0o000)

    const out = await call('POST', `/api/agents/${NAME}/channels/slack/invites`, {})

    expect(out.status).toBe(500)
    chmodSync(invites, 0o600)
    expect(readFileSync(invites, 'utf-8')).toBe(INVITES)
    expect(readFileSync(access, 'utf-8')).toBe(ORIGINAL)
  })
})

describe('a readable access.json still works (the guard is not a blanket refusal)', () => {
  it('allowlist remove drops only the one user and keeps the rest', async () => {
    const file = join(stateDir('telegram'), 'access.json')
    writeFileSync(file, ORIGINAL)
    const out = await call('DELETE', `/api/agents/${NAME}/channels/telegram/allowed/user/111`)
    expect(out.status).toBe(200)
    const after = JSON.parse(readFileSync(file, 'utf-8'))
    expect(after.allowFrom).toEqual(['222'])
    expect(after.groups).toEqual({ '-100': { requireMention: true, allowFrom: [] } })
    expect(after.dmPolicy).toBe('allowlist')
  })
})
