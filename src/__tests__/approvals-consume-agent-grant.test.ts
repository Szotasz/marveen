// for_agent: the main agent grants an approval row to ONE sub-agent, whose
// acting tool runs under the sub-agent's OWN dashboard token (AGENT_TOKENS).
// Rows such a tool needs are often filed by the MAIN agent (agent_id = main,
// born approved through owner_approved_message_id), so "row agent_id ==
// caller" alone would admit nothing legitimate there. The row therefore
// carries for_agent: a sub-agent token may consume a row when for_agent names
// it, or -- with no grant -- when it filed the row itself. for_agent is the
// owner lane (never from a sub-agent token).
//
// Unknown ids (documented choice): a sub-agent token gets the SAME 403 body for
// an unknown id as for an ungranted or foreign row (a missing row is refused
// for an agent token, never deferred to the route's 404), so the answer says
// nothing about existence. The main token keeps its 404.
//
// The requests go through the real gate (gateRequest) and then the real route,
// the way web.ts chains them, with ctx.auth built as web.ts builds it.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'fo-agens', TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => null) }
})

import { initDatabase, getApproval, listApprovals } from '../db.js'
import { gateRequest } from '../web/auth-gate.js'
import { agentTokenPath, createAgentTokenResolver, ensureAgentToken } from '../web/agent-tokens.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

const MAIN = 'fo-agens'
const X = 'alfa'
const Y = 'beta'
const MAIN_TOKEN = 'f'.repeat(64)
const TOK: Record<string, string> = { [X]: 'a'.repeat(64), [Y]: 'b'.repeat(64) }
const resolver = (t: string): string | null => Object.entries(TOK).find(([, v]) => v === t)?.[0] ?? null
const HASH = 'ab'.repeat(32)
const CAT = 'teszt_inditas'

type Out = { status: number; body: any }

function mkReq(token: string, body: unknown): http.IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  ;(r as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` }
  return r
}

function mkRes(out: Out): http.ServerResponse {
  const res = {
    writeHead(code: number) { out.status = code; return res },
    end(data?: unknown) { if (data !== undefined) { try { out.body = JSON.parse(String(data)) } catch { out.body = String(data) } } },
    setHeader() { return res },
  }
  return res as unknown as http.ServerResponse
}

/** gate -> route, as web.ts runs them. */
async function call(method: string, path: string, token: string, body?: unknown, resolveAgentToken: (t: string) => string | null = resolver): Promise<Out> {
  const out: Out = { status: 0, body: null }
  const req = mkReq(token, body)
  const res = mkRes(out)
  const url = new URL(`http://127.0.0.1${path}`)
  const auth = await gateRequest(req, res, url, url.pathname, method, {
    dashboardToken: MAIN_TOKEN, resolveAgentToken, mainAgentId: MAIN,
  })
  if (auth === null) return out
  const ctxAuth = auth.kind === 'token' ? { kind: 'token' as const, agent: auth.agent, ...(auth.tokenAgent ? { tokenAgent: auth.tokenAgent } : {}) } : undefined
  const ctx: RouteContext = { req, res, path: url.pathname, method, url, auth: ctxAuth }
  expect(await tryHandleApprovals(ctx)).toBe(true)
  await new Promise((r) => setImmediate(r))
  return out
}

/** The route alone, with a sub-agent principal: the defence that does not rest on the gate table. */
async function routeOnly(method: string, path: string, agent: string, body: unknown): Promise<Out> {
  const out: Out = { status: 0, body: null }
  const req = mkReq('unused', body)
  const res = mkRes(out)
  const url = new URL(`http://127.0.0.1${path}`)
  expect(await tryHandleApprovals({ req, res, path: url.pathname, method, url, auth: { kind: 'token', agent, tokenAgent: agent } })).toBe(true)
  return out
}

/** Main agent files a row born approved (the measured shape), optionally granted to a sub-agent. */
async function mainGrant(forAgent?: string, category = CAT): Promise<string> {
  const r = await call('POST', '/api/approvals', MAIN_TOKEN, {
    agent_id: MAIN, category, action_description: 'inditas', content_hash: HASH, owner_approved_message_id: 4711,
    ...(forAgent !== undefined ? { for_agent: forAgent } : {}),
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(r.body.status).toBe('approved')
  return r.body.id as string
}

const consumeBody = (consumer = 'inditas-eszkoz') => ({ category: CAT, content_hash: HASH, consumer, ref: 'terv-1' })

function expectNotGranted(r: Out, agent: string): void {
  expect(r.status, JSON.stringify(r.body)).toBe(403)
  expect(r.body.rule).toBe('agent-identity-binding')
  expect(r.body.agent).toBe(agent)
  expect(r.body.main_agent).toBe(MAIN)
  expect(r.body.error).toContain(`not granted to the calling agent '${agent}'`)
}

beforeEach(() => { initDatabase(':memory:') })

describe('POST /api/approvals/:id/consume with a sub-agent token', () => {
  it('the granted sub-agent consumes its row once (200), the replay is 409 already_consumed', async () => {
    const id = await mainGrant(X)
    expect(getApproval(id)!.for_agent).toBe(X)
    const first = await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(getApproval(id)!.consumed_by).toBe('inditas-eszkoz')
    const second = await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody('masodik'))
    expect(second.status).toBe(409)
    expect(second.body.reason).toBe('already_consumed')
    expect(getApproval(id)!.consumed_by).toBe('inditas-eszkoz')
  })

  it('another sub-agent gets 403 and the row stays unconsumed (the grantee can still use it)', async () => {
    const id = await mainGrant(X)
    expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, TOK[Y]!, consumeBody()), Y)
    expect(getApproval(id)!.consumed_at).toBeNull()
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(200)
  })

  it('a main-agent row without for_agent is 403 for every sub-agent and unconsumed; the main token consumes it', async () => {
    const id = await mainGrant()
    expect(getApproval(id)!.for_agent).toBeNull()
    for (const a of [X, Y]) expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, TOK[a]!, consumeBody()), a)
    expect(getApproval(id)!.consumed_at).toBeNull()
    expect((await call('POST', `/api/approvals/${id}/consume`, MAIN_TOKEN, consumeBody())).status).toBe(200)
  })

  it('a row the sub-agent filed itself (agent_id = caller, no grant) and the owner approved: it consumes it once; another sub-agent cannot', async () => {
    const own = await call('POST', '/api/approvals', TOK[X]!, { agent_id: X, category: CAT, action_description: 'sajat', content_hash: HASH })
    expect(own.status, JSON.stringify(own.body)).toBe(201)
    const id = own.body.id as string
    // approving is the owner's lane: the sub-agent token cannot, the owner credential can
    expect((await call('PATCH', `/api/approvals/${id}`, TOK[X]!, { status: 'approved', resolved_by: 'owner' })).status).toBe(403)
    const patch = await call('PATCH', `/api/approvals/${id}`, MAIN_TOKEN, { status: 'approved', resolved_by: 'owner-tg-1' })
    expect(patch.status, JSON.stringify(patch.body)).toBe(200)
    expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, TOK[Y]!, consumeBody()), Y)
    expect(getApproval(id)!.consumed_at).toBeNull()
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(200)
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(409)
  })

  it('a grant overrides the filer: a row filed for X but granted to Y is consumable by Y only', async () => {
    const r = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: X, category: CAT, action_description: 'x', content_hash: HASH, for_agent: Y })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id = r.body.id as string
    expect((await call('PATCH', `/api/approvals/${id}`, MAIN_TOKEN, { status: 'approved', resolved_by: 'owner-tg-2' })).status).toBe(200)
    expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody()), X)
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[Y]!, consumeBody())).status).toBe(200)
  })

  it('an unknown id: the sub-agent token gets the same 403 body as an ungranted row (no existence signal); the main token keeps 404', async () => {
    const ungranted = await mainGrant()
    const unknown = await call('POST', '/api/approvals/nincs-ilyen/consume', TOK[X]!, consumeBody())
    expectNotGranted(unknown, X)
    const foreign = await call('POST', `/api/approvals/${ungranted}/consume`, TOK[X]!, consumeBody())
    expect(unknown.body).toEqual(foreign.body)
    const granted = await mainGrant(Y)
    expect((await call('POST', `/api/approvals/${granted}/consume`, TOK[X]!, consumeBody())).body).toEqual(foreign.body)
    const main = await call('POST', '/api/approvals/nincs-ilyen/consume', MAIN_TOKEN, consumeBody())
    expect(main.status).toBe(404)
    expect(main.body).toEqual({ ok: false, reason: 'not_found' })
  })

  it('the consume semantics are unchanged for the grantee: wrong category / wrong hash are 409 and leave the row usable', async () => {
    const id = await mainGrant(X)
    const wrongCat = await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, { ...consumeBody(), category: 'masik_kategoria' })
    expect([wrongCat.status, wrongCat.body.reason]).toEqual([409, 'wrong_category'])
    const wrongHash = await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, { ...consumeBody(), content_hash: 'cd'.repeat(32) })
    expect([wrongHash.status, wrongHash.body.reason]).toEqual([409, 'hash_mismatch'])
    expect(getApproval(id)!.consumed_at).toBeNull()
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(200)
  })

  it('the letter path (email_send, no category) works the same way for the grantee', async () => {
    const id = await mainGrant(X, 'email_send')
    expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, TOK[Y]!, { content_hash: HASH, consumer: 'mailer' }), Y)
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, { content_hash: HASH, consumer: 'mailer' })).status).toBe(200)
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, { content_hash: HASH, consumer: 'mailer' })).status).toBe(409)
  })

  it('the route repeats the check without the gate: a sub-agent principal on a foreign row is 403 and nothing is consumed', async () => {
    const id = await mainGrant(X)
    expectNotGranted(await routeOnly('POST', `/api/approvals/${id}/consume`, Y, consumeBody()), Y)
    expect(getApproval(id)!.consumed_at).toBeNull()
  })
})

// A directory copied with cp -r carries the original's token. A value two
// agents hold authenticates neither (loadAgentTokens), so the copy cannot spend
// a grant made to the original; once its next start rotates the copy, it is
// itself, still not the grantee.
describe('a copied agent dir (duplicate token) cannot consume a grant made for_agent to the original', () => {
  it('the shared token is 401; after the copy is rotated it is 403 not granted; the original consumes once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grant-twin-'))
    try {
      const base = join(root, 'agents')
      mkdirSync(join(base, X), { recursive: true })
      ensureAgentToken(X, base, MAIN_TOKEN)
      const COPY = `${X}-masolat`
      cpSync(join(base, X), join(base, COPY), { recursive: true })
      const shared = readFileSync(agentTokenPath(X, base), 'utf-8')
      expect(readFileSync(agentTokenPath(COPY, base), 'utf-8')).toBe(shared)
      const real = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })

      const id = await mainGrant(X)
      // While the two files hold the same value, it authenticates nobody.
      const twin = await call('POST', `/api/approvals/${id}/consume`, shared, consumeBody(), real)
      expect(twin.status, JSON.stringify(twin.body)).toBe(401)
      expect(getApproval(id)!.consumed_at).toBeNull()

      // The copy's next start rotates it: it is now itself, and not the grantee.
      expect(ensureAgentToken(COPY, base, MAIN_TOKEN)?.created).toBe(true)
      const copyTok = readFileSync(agentTokenPath(COPY, base), 'utf-8')
      expect(copyTok).not.toBe(shared)
      expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, copyTok, consumeBody(), real), COPY)
      expect(getApproval(id)!.consumed_at).toBeNull()

      // The original's token is unique again and consumes its grant once.
      expect((await call('POST', `/api/approvals/${id}/consume`, shared, consumeBody(), real)).status).toBe(200)
      expect((await call('POST', `/api/approvals/${id}/consume`, shared, consumeBody(), real)).status).toBe(409)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('for_agent on POST /api/approvals is the main agent\'s lane', () => {
  it('a sub-agent token cannot create a row with for_agent (its own name or another): 403 at the gate, no row', async () => {
    const before = listApprovals({ limit: 500 }).length
    for (const target of [X, Y, MAIN]) {
      const r = await call('POST', '/api/approvals', TOK[X]!, { agent_id: X, category: CAT, action_description: 'x', content_hash: HASH, for_agent: target })
      expect(r.status, JSON.stringify(r.body)).toBe(403)
      expect(r.body.rule).toBe('agent-identity-binding')
      expect(r.body.error).toContain("'for_agent' is an owner-lane field")
    }
    expect(listApprovals({ limit: 500 }).length).toBe(before)
  })

  it('the route refuses it too when reached with a sub-agent principal (no gate)', async () => {
    const r = await routeOnly('POST', '/api/approvals', X, { agent_id: X, category: CAT, action_description: 'x', for_agent: X })
    expect(r.status).toBe(403)
    expect(listApprovals({ limit: 500 })).toEqual([])
  })

  it('the main token sets it, it is returned on GET, and a malformed value is 400', async () => {
    const id = await mainGrant(X)
    const got = await call('GET', `/api/approvals/${id}`, MAIN_TOKEN)
    expect(got.body.for_agent).toBe(X)
    for (const bad of ['', 'a b', 'x/y', 'a'.repeat(65), 7]) {
      const r = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: MAIN, category: CAT, action_description: 'x', for_agent: bad })
      expect(r.status, `for_agent=${JSON.stringify(bad)}`).toBe(400)
    }
    // absent / null = no grant, exactly as before
    const plain = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: MAIN, category: CAT, action_description: 'x', for_agent: null })
    expect(plain.status).toBe(201)
    expect(plain.body.for_agent).toBeNull()
  })

  it('the main token still consumes a row granted to a sub-agent (main behaviour unchanged)', async () => {
    const id = await mainGrant(X)
    expect((await call('POST', `/api/approvals/${id}/consume`, MAIN_TOKEN, consumeBody())).status).toBe(200)
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(409)
  })
})

// The instruction texts this change generates must describe operations the API
// really offers (review round 1): for_agent exists only at creation, so the way
// out of a refused consume is a NEW row the main agent files for the sub-agent,
// approved by the owner -- the recipe in seed-skills/approval-request-handling.
describe('the documented way out of a refused consume works end to end', () => {
  it('for_agent cannot be added to an existing row: a PATCH carrying it leaves the grant unset', async () => {
    const filed = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: MAIN, category: CAT, action_description: 'x', content_hash: HASH })
    const id = filed.body.id as string
    const r = await call('PATCH', `/api/approvals/${id}`, MAIN_TOKEN, { status: 'approved', resolved_by: 'owner', for_agent: X })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(getApproval(id)!.for_agent).toBeNull()
    expectNotGranted(await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody()), X)
  })

  it('refused consume -> the main agent files a NEW pending row with for_agent -> the owner approves -> the sub-agent consumes it', async () => {
    const refused = await mainGrant()
    expectNotGranted(await call('POST', `/api/approvals/${refused}/consume`, TOK[X]!, consumeBody()), X)
    // the skill's recipe body, as written there
    const filed = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: MAIN, category: CAT, action_description: 'X inditja', content_hash: HASH, for_agent: X })
    expect(filed.status, JSON.stringify(filed.body)).toBe(201)
    expect(filed.body.status).toBe('pending')
    expect(filed.body.for_agent).toBe(X)
    const id = filed.body.id as string
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(409) // not approved yet
    expect((await call('PATCH', `/api/approvals/${id}`, MAIN_TOKEN, { status: 'approved', resolved_by: 'owner-dashboard' })).status).toBe(200)
    expect((await call('POST', `/api/approvals/${id}/consume`, TOK[X]!, consumeBody())).status).toBe(200)
  })

  it('the seed skill carries that recipe and says the grant cannot be added later', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const skill = readFileSync(join(process.cwd(), 'seed-skills', 'approval-request-handling', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('"for_agent":"<al-ügynök neve>"')
    expect(skill).toContain('CSAK létrehozáskor adható meg')
    expect(skill).toContain('a tulajdonos hagyja jóvá')
  })
})
