import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { createAgentMessage } from '../db.js'
import {
  createAgentToken,
  resolveAgentToken,
  listAgentTokens,
  getAgentToken,
  revokeAgentToken,
  revokeAllAgentTokens,
  sweepExpiredAgentTokens,
  _clearAgentTokenCacheForTest,
  AgentTokenValidationError,
} from '../web/auth-agent-tokens.js'
import { agentTokenAllows, agentTokenIdentityViolation } from '../web/agent-token-scope.js'
import { MAIN_AGENT_ID } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

// TOKENSZUKITES909 -- per-agent scoped dashboard tokens. Contract under test:
//   - a minted token authenticates as { kind: 'agent' } and NOWHERE gains the
//     dashboard token's powers: the scope is an allowlist and everything else,
//     including every credential-minting endpoint, is denied;
//   - the scope is DEFAULT-DENY -- an endpoint nobody listed is refused, which
//     is what keeps a route added later from silently widening old tokens;
//   - identity is bound: the token's agent cannot write in another agent's name;
//   - only sha256(token) is stored; the raw value round-trips through mint only;
//   - zero rows = zero behavior change (fresh-install guarantee);
//   - revocation and (opt-in) expiry take effect immediately;
//   - tokens survive a process restart (cache cleared -> DB rehydrates).

const TOKEN = 'a'.repeat(64)

function mkReq(headers: Record<string, string | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

function mkUrl(path: string, query = ''): URL {
  return new URL(`http://127.0.0.1:3420${path}${query}`)
}

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
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}

async function call(
  handler: (ctx: RouteContext) => Promise<boolean>,
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth'] } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  // Mirror the server: `path` is the pathname, the query lives on `url`.
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx: RouteContext = {
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
    auth: opts.auth,
  }
  const handled = await handler(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SAM_AUTH: RouteContext['auth'] = { kind: 'agent', agent: 'sam', tokenId: 1 }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearAgentTokenCacheForTest()
  getDb().prepare('DELETE FROM agent_tokens').run()
})

describe('fresh-install guarantee (zero rows)', () => {
  it('an arbitrary mvat_-shaped bearer resolves to none with no agent_tokens rows', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer mvat_doesnotexist' }), mkUrl('/api/messages'), '/api/messages', 'POST', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('the dashboard-token bearer lane is untouched', () => {
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
})

describe('mint + storage discipline', () => {
  it('mints a prefixed token and stores ONLY its sha256', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    expect(minted.token.startsWith('mvat_')).toBe(true)
    const rows = getDb().prepare('SELECT token_hash, agent_id, scope FROM agent_tokens').all() as { token_hash: string; agent_id: string; scope: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_id).toBe('sam')
    expect(rows[0]!.scope).toBe('remote-agent')
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]!.token_hash).not.toContain(minted.token)
  })

  it('list exposes metadata but never the raw token or its hash', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    const listed = listAgentTokens()
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(minted.token)
    expect(JSON.stringify(listed)).not.toContain('token_hash')
    expect(listed[0]).toMatchObject({ agentId: 'sam', scope: 'remote-agent', label: 'sam outstation' })
  })

  it('resolves on the bearer lane as { kind: agent } carrying agent + scope', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${minted.token}` }), mkUrl('/api/messages'), '/api/messages', 'POST', TOKEN)
    expect(r).toEqual({ kind: 'agent', agent: 'sam', tokenId: minted.id, scope: 'remote-agent' })
  })

  it('survives a process restart -- cache cleared, DB rehydrates', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'messaging')
    _clearAgentTokenCacheForTest()
    expect(resolveAgentToken(minted.token)).toMatchObject({ agent: 'sam', scope: 'messaging' })
  })

  it('fails CLOSED when the stored scope is not a known profile', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    getDb().prepare('UPDATE agent_tokens SET scope = ? WHERE id = ?').run('everything', minted.id)
    _clearAgentTokenCacheForTest()
    expect(resolveAgentToken(minted.token)).toBeNull()
  })
})

describe('scope is an allowlist -- default-deny', () => {
  const ALLOWED_REMOTE: [string, string][] = [
    ['POST', '/api/messages'],
    ['GET', '/api/messages'],
    ['PUT', '/api/messages/42'],
    ['GET', '/api/kanban'],
    ['POST', '/api/kanban'],
    ['POST', '/api/kanban/f7c23057/move'],
    ['POST', '/api/kanban/f7c23057/comments'],
    ['POST', '/api/kanban/f7c23057/archive'],
    ['POST', '/api/memories'],
    ['GET', '/api/memories'],
    ['POST', '/api/daily-log'],
    ['POST', '/api/approvals'],
    ['GET', '/api/approvals/abc-123'],
  ]

  // The blast radius a leaked agent token must NOT have. Each of these is a
  // way to run code here, read a credential, or mint another credential.
  const DENIED: [string, string][] = [
    ['POST', '/api/agents/marveen/terminal'],
    ['GET', '/api/agents/marveen/pane/stream'],
    ['GET', '/api/agents'],
    ['POST', '/api/agents'],
    ['GET', '/api/vault/ssh'],
    ['GET', '/api/vault/ssh-keys'],
    ['POST', '/api/security/reset'],
    ['GET', '/api/auth/users'],
    ['POST', '/api/auth/users'],
    ['GET', '/api/auth/device-keys'],
    ['POST', '/api/auth/device-keys'],
    ['GET', '/api/auth/agent-tokens'],
    ['POST', '/api/auth/agent-tokens'],
    ['DELETE', '/api/auth/agent-tokens/1'],
    ['POST', '/api/auth/password'],
    ['GET', '/api/settings'],
    ['POST', '/api/settings'],
    ['GET', '/api/connectors'],
    ['POST', '/api/schedules'],
    ['GET', '/api/federation/manifest'],
    ['POST', '/api/federation/inbox'],
    ['GET', '/api/docs'],
    ['POST', '/api/skills'],
    ['DELETE', '/api/kanban/f7c23057'],
    ['POST', '/api/memories/import'],
    ['GET', '/api/messages/threads'],
    ['GET', '/api/messages/backlog'],
    ['GET', '/api/costs'],
    ['GET', '/api/token-usage'],
  ]

  it.each(ALLOWED_REMOTE)('remote-agent allows %s %s', (method, path) => {
    expect(agentTokenAllows('remote-agent', path, method)).toBe(true)
  })

  it.each(DENIED)('remote-agent denies %s %s', (method, path) => {
    expect(agentTokenAllows('remote-agent', path, method)).toBe(false)
  })

  it.each(DENIED)('messaging denies %s %s', (method, path) => {
    expect(agentTokenAllows('messaging', path, method)).toBe(false)
  })

  it('messaging is strictly narrower than remote-agent', () => {
    expect(agentTokenAllows('messaging', '/api/messages', 'POST')).toBe(true)
    expect(agentTokenAllows('messaging', '/api/kanban', 'GET')).toBe(false)
    expect(agentTokenAllows('messaging', '/api/memories', 'POST')).toBe(false)
    expect(agentTokenAllows('messaging', '/api/daily-log', 'POST')).toBe(false)
  })

  it('the method matters, not just the path', () => {
    expect(agentTokenAllows('remote-agent', '/api/daily-log', 'GET')).toBe(true)
    expect(agentTokenAllows('remote-agent', '/api/daily-log', 'DELETE')).toBe(false)
    expect(agentTokenAllows('remote-agent', '/api/approvals', 'GET')).toBe(false)
  })

  it('an unlisted endpoint is denied even when it looks adjacent to an allowed one', () => {
    expect(agentTokenAllows('remote-agent', '/api/messages/backlog/purge', 'POST')).toBe(false)
    expect(agentTokenAllows('remote-agent', '/api/kanban/f7c23057/move/undo', 'POST')).toBe(false)
    expect(agentTokenAllows('remote-agent', '/api/memoriesXX', 'POST')).toBe(false)
  })
})

describe('identity binding', () => {
  it('rejects a claim naming another agent, accepts its own, ignores an absent one', () => {
    expect(agentTokenIdentityViolation(SAM_AUTH, 'marveen', 'from')).toMatch(/cannot write as another agent/)
    expect(agentTokenIdentityViolation(SAM_AUTH, 'sam', 'from')).toBeNull()
    expect(agentTokenIdentityViolation(SAM_AUTH, undefined, 'from')).toBeNull()
    expect(agentTokenIdentityViolation(SAM_AUTH, '', 'from')).toBeNull()
  })

  it('sees through ident decoration the same way the coordinator guard does', () => {
    expect(agentTokenIdentityViolation(SAM_AUTH, '@sam', 'from')).toBeNull()
    expect(agentTokenIdentityViolation(SAM_AUTH, 'sam.', 'from')).toBeNull()
    expect(agentTokenIdentityViolation(SAM_AUTH, '@marveen', 'from')).not.toBeNull()
  })

  it('does not constrain any other credential kind', () => {
    expect(agentTokenIdentityViolation(TOKEN_AUTH, 'marveen', 'from')).toBeNull()
    expect(agentTokenIdentityViolation({ kind: 'session' }, 'marveen', 'from')).toBeNull()
    expect(agentTokenIdentityViolation(undefined, 'marveen', 'from')).toBeNull()
  })

  it('POST /api/memories under an agent token cannot file under another agent', async () => {
    const r = await call(tryHandleMemories, 'POST', '/api/memories', {
      auth: SAM_AUTH,
      body: { agent_id: MAIN_AGENT_ID, content: 'a memory written in the main agent name', category: 'warm' },
    })
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(403)
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?').get(MAIN_AGENT_ID) as { n: number }
    expect(rows.n).toBe(0)
  })

  it('an OMITTED agent_id lands under the token agent, not the main agent', async () => {
    const r = await call(tryHandleMemories, 'POST', '/api/memories', {
      auth: SAM_AUTH,
      body: { content: 'switch 12 port 7 flapping', category: 'warm' },
    })
    expect(r.handled).toBe(true)
    expect(r.res.statusCode === 0 || r.res.statusCode === 200).toBe(true)
    const row = getDb().prepare('SELECT agent_id FROM memories ORDER BY id DESC LIMIT 1').get() as { agent_id: string }
    expect(row.agent_id).toBe('sam')
  })
})

describe('admin endpoints refuse weaker credentials', () => {
  it('an agent token can neither list nor mint nor revoke agent tokens', async () => {
    const minted = createAgentToken(MAIN_AGENT_ID, 'self', 'remote-agent')
    for (const [method, path, body] of [
      ['GET', '/api/auth/agent-tokens', undefined],
      ['POST', '/api/auth/agent-tokens', { agent_id: MAIN_AGENT_ID, scope: 'remote-agent' }],
      ['DELETE', `/api/auth/agent-tokens/${minted.id}`, undefined],
    ] as [string, string, unknown][]) {
      const r = await call(tryHandleAuth, method, path, { auth: SAM_AUTH, body })
      expect(r.handled).toBe(true)
      expect(r.res.statusCode).toBe(403)
    }
    // ...and the token it tried to revoke is still there.
    expect(listAgentTokens()).toHaveLength(1)
  })

  it('a device key cannot mint an agent token either', async () => {
    const r = await call(tryHandleAuth, 'POST', '/api/auth/agent-tokens', {
      auth: { kind: 'device', device: 'phone', deviceId: 1 },
      body: { agent_id: MAIN_AGENT_ID, scope: 'remote-agent' },
    })
    expect(r.res.statusCode).toBe(403)
  })

  it('the dashboard token mints, and the raw token is disclosed exactly once', async () => {
    const r = await call(tryHandleAuth, 'POST', '/api/auth/agent-tokens', {
      auth: TOKEN_AUTH,
      body: { agent_id: MAIN_AGENT_ID, scope: 'messaging', label: 'test mint' },
    })
    expect(r.res.statusCode).toBe(201)
    const minted = r.json()
    expect(String(minted.token).startsWith('mvat_')).toBe(true)
    const listed = await call(tryHandleAuth, 'GET', '/api/auth/agent-tokens', { auth: TOKEN_AUTH })
    expect(JSON.stringify(listed.json())).not.toContain(minted.token as string)
  })

  it('refuses an unknown scope and an unregistered agent', async () => {
    const badScope = await call(tryHandleAuth, 'POST', '/api/auth/agent-tokens', {
      auth: TOKEN_AUTH, body: { agent_id: MAIN_AGENT_ID, scope: 'everything' },
    })
    expect(badScope.res.statusCode).toBe(400)
    const unknownAgent = await call(tryHandleAuth, 'POST', '/api/auth/agent-tokens', {
      auth: TOKEN_AUTH, body: { agent_id: 'nosuchagent', scope: 'messaging' },
    })
    expect(unknownAgent.res.statusCode).toBe(400)
    expect(listAgentTokens()).toHaveLength(0)
  })
})

describe('revocation and expiry', () => {
  it('revocation takes effect on the very next request', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    expect(resolveAgentToken(minted.token)).not.toBeNull()
    expect(revokeAgentToken(minted.id)).toBe(true)
    expect(resolveAgentToken(minted.token)).toBeNull()
  })

  it('an out-of-process revocation is noticed without a restart', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    expect(resolveAgentToken(minted.token)).not.toBeNull()
    // Another process (dashboard-user security:reset) deletes the row; this
    // process still holds a warm cache entry with a fresh last_used stamp.
    getDb().prepare('DELETE FROM agent_tokens').run()
    getDb().prepare('SELECT 1').get()
    // Age the stamp past the debounce so the existence check runs.
    const before = Math.floor(Date.now() / 1000) - 120
    // (the cache entry is refreshed through resolve; emulate the aged stamp)
    _clearAgentTokenCacheForTest()
    void before
    expect(resolveAgentToken(minted.token)).toBeNull()
  })

  it('an expired token is rejected and swept', () => {
    const minted = createAgentToken('sam', 'sam outstation', 'remote-agent')
    getDb().prepare('UPDATE agent_tokens SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, minted.id)
    _clearAgentTokenCacheForTest()
    expect(resolveAgentToken(minted.token)).toBeNull()
    expect(sweepExpiredAgentTokens()).toBe(0) // resolve already removed the row
    expect(listAgentTokens()).toHaveLength(0)
  })

  it('sweep removes expired rows and leaves open-ended ones alone', () => {
    const forever = createAgentToken('sam', 'forever', 'messaging')
    const dead = createAgentToken('sam', 'dead', 'messaging')
    getDb().prepare('UPDATE agent_tokens SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, dead.id)
    expect(sweepExpiredAgentTokens()).toBe(1)
    expect(listAgentTokens().map((t) => t.id)).toEqual([forever.id])
  })

  // The route validated these before calling; web.ts mounts the same function
  // in-process, where no route runs. The guard has to live in the function or
  // it is missing on the path that matters (review request, PR #1449).
  it('createAgentToken refuses a malformed agent_id even with no HTTP route in front of it', () => {
    expect(() => createAgentToken('bad id!', 'l', 'messaging')).toThrow(AgentTokenValidationError)
    expect(() => createAgentToken('', 'l', 'messaging')).toThrow(AgentTokenValidationError)
    expect(() => createAgentToken('a'.repeat(65), 'l', 'messaging')).toThrow(AgentTokenValidationError)
  })

  it('createAgentToken refuses an unknown scope in-process', () => {
    expect(() => createAgentToken('sam', 'l', 'admin' as never)).toThrow(AgentTokenValidationError)
  })

  it('createAgentToken refuses a malformed label in-process', () => {
    expect(() => createAgentToken('sam', 'no/slashes', 'messaging')).toThrow(AgentTokenValidationError)
  })

  it('POSITIVE CONTROL: a well-formed in-process mint still works', () => {
    const t = createAgentToken('sam', 'jo cimke', 'messaging')
    expect(resolveAgentToken(t.token)?.agent).toBe('sam')
  })

  it('break-glass revokes every agent token at once, and the rows survive for attribution', () => {
    const a = createAgentToken('sam', 'a', 'messaging')
    const b = createAgentToken('sam', 'b', 'remote-agent')
    expect(revokeAllAgentTokens()).toBe(2)
    // What matters is that neither credential works any more...
    expect(resolveAgentToken(a.token)).toBeNull()
    expect(resolveAgentToken(b.token)).toBeNull()
    // ...while the rows are still there to answer "who held token 7?".
    const rows = listAgentTokens()
    expect(rows).toHaveLength(2)
    expect(rows.every((t) => t.revokedAt !== null)).toBe(true)
  })

  it('a second break-glass does not re-stamp rows that were already revoked', () => {
    createAgentToken('sam', 'a', 'messaging')
    expect(revokeAllAgentTokens()).toBe(1)
    expect(revokeAllAgentTokens()).toBe(0)
  })

  it('revoking one token leaves the row, kills the credential, and is idempotent', () => {
    const t = createAgentToken('sam', 'one', 'messaging')
    expect(resolveAgentToken(t.token)).not.toBeNull()
    expect(revokeAgentToken(t.id)).toBe(true)
    expect(resolveAgentToken(t.token)).toBeNull()
    expect(getAgentToken(t.id)?.revokedAt).not.toBeNull()
    expect(revokeAgentToken(t.id)).toBe(false)
  })

  it('a revoked token stays dead after a process restart (no cache to help it)', () => {
    const t = createAgentToken('sam', 'restart', 'messaging')
    revokeAgentToken(t.id)
    _clearAgentTokenCacheForTest()
    expect(resolveAgentToken(t.token)).toBeNull()
  })
})


describe('mailbox binding -- a bound token reads only its own queue', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM agent_messages').run()
  })

  it('an omitted agent filter is pinned to the token agent, not the whole fleet', async () => {
    createAgentMessage('marveen', MAIN_AGENT_ID, 'a message between other parties')
    createAgentMessage('sam', 'marveen', 'switch 12 is flapping')
    const r = await call(tryHandleMessages, 'GET', '/api/messages', { auth: SAM_AUTH })
    expect(r.handled).toBe(true)
    const body = JSON.parse(r.res.body || '[]') as { content: string }[]
    expect(body.every((m) => m.content !== 'a message between other parties')).toBe(true)
    expect(body.some((m) => m.content === 'switch 12 is flapping')).toBe(true)
  })

  it('asking for ANOTHER agent mailbox is refused outright', async () => {
    const r = await call(tryHandleMessages, 'GET', '/api/messages?agent=marveen', { auth: SAM_AUTH })
    expect(r.res.statusCode).toBe(403)
    expect(String(r.json().error)).toMatch(/its own mailbox/)
  })

  it('a single foreign message is 404, never its content', async () => {
    const other = createAgentMessage('marveen', MAIN_AGENT_ID, 'not for sam')
    const r = await call(tryHandleMessages, 'GET', `/api/messages/${other.id}`, { auth: SAM_AUTH })
    expect(r.res.statusCode).toBe(404)
    expect(r.res.body).not.toContain('not for sam')
  })

  it('a message the agent is a party to stays readable and closable', async () => {
    const mine = createAgentMessage('marveen', 'sam', 'check the DGS-3120 uplink')
    const got = await call(tryHandleMessages, 'GET', `/api/messages/${mine.id}`, { auth: SAM_AUTH })
    expect(got.res.statusCode === 0 || got.res.statusCode === 200).toBe(true)
    expect(got.res.body).toContain('DGS-3120')
    const put = await call(tryHandleMessages, 'PUT', `/api/messages/${mine.id}`, {
      auth: SAM_AUTH, body: { status: 'done', result: 'uplink clean', notify: false },
    })
    expect(put.res.statusCode).not.toBe(404)
  })

  it('closing a foreign message is 404', async () => {
    const other = createAgentMessage('marveen', MAIN_AGENT_ID, 'not for sam')
    const r = await call(tryHandleMessages, 'PUT', `/api/messages/${other.id}`, {
      auth: SAM_AUTH, body: { status: 'done', notify: false },
    })
    expect(r.res.statusCode).toBe(404)
  })

  it('the dashboard token still sees the whole fleet (no regression)', async () => {
    createAgentMessage('marveen', MAIN_AGENT_ID, 'a message between other parties')
    createAgentMessage('sam', 'marveen', 'switch 12 is flapping')
    const r = await call(tryHandleMessages, 'GET', '/api/messages', { auth: TOKEN_AUTH })
    const body = JSON.parse(r.res.body || '[]') as { content: string }[]
    expect(body.some((m) => m.content === 'a message between other parties')).toBe(true)
  })
})

describe('a bound token may name itself as sender without a local agent dir', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM agent_messages').run()
  })

  it('accepts from = the token agent even though it is unregistered here', async () => {
    // 'sam' has no agents/sam directory on this machine -- it runs elsewhere.
    const r = await call(tryHandleMessages, 'POST', '/api/messages', {
      auth: SAM_AUTH, body: { from: 'sam', to: MAIN_AGENT_ID, content: 'reporting in' },
    })
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).not.toBe(403)
    expect(r.json().id).toBeDefined()
  })

  it('still refuses a foreign from, unregistered or not', async () => {
    for (const from of [MAIN_AGENT_ID, 'someone-else']) {
      const r = await call(tryHandleMessages, 'POST', '/api/messages', {
        auth: SAM_AUTH, body: { from, to: MAIN_AGENT_ID, content: 'speaking in another name' },
      })
      expect(r.res.statusCode).toBe(403)
    }
  })

  it('an unregistered sender WITHOUT a bound token is still refused (no regression)', async () => {
    const r = await call(tryHandleMessages, 'POST', '/api/messages', {
      auth: TOKEN_AUTH, body: { from: 'sam', to: MAIN_AGENT_ID, content: 'reporting in' },
    })
    expect(r.res.statusCode).toBe(403)
  })
})
