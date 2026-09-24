// POST /api/commands/dispatch (ELSOKOR922 spec D-4): the endpoint the main
// session's command hook calls. A registry command from the owner chat runs
// and its reply comes back; anything else is `handled:false` with nothing run
// and nothing replied, so the hook lets the prompt through to the model.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { registerCommand, clearCommandsForTest } from '../web/commands.js'
import { dispatchForChat, tryHandleCommands, mainSessionFromBody } from '../web/routes/commands.js'
import { requiresAuth, resolveAuth } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

let runs = 0

beforeEach(() => {
  clearCommandsForTest()
  runs = 0
  registerCommand({ name: 'status', kind: 'read', description: 'állapot', run: async (ctx) => { runs++; await ctx.reply('minden rendben') } })
  registerCommand({ name: 'runs', kind: 'write', description: 'leállítás', usage: '/runs stop <nonce>', planned: true, matches: a => a[0] === 'stop' })
})

function fakeCtx(body: unknown, headers: Record<string, string> = {}, method = 'POST', path = '/api/commands/dispatch') {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    setHeader() { return res },
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.headers = headers
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path, method, url, auth: { kind: 'token' } } as RouteContext
  return { ctx, out }
}

describe('dispatchForChat', () => {
  it('runs a registry command from the owner chat and returns its reply', async () => {
    const r = await dispatchForChat('/status', '42', '42')
    expect(r).toEqual({ handled: true, outcome: 'ran', replies: ['minden rendben'] })
    expect(runs).toBe(1)
  })
  it('a planned entry is handled (answers "planned", runs nothing)', async () => {
    const r = await dispatchForChat('/runs stop abc', '42', '42')
    expect(r.handled).toBe(true)
    expect(r.outcome).toBe('planned')
  })
  it('an unknown slash word is not handled and nothing is replied', async () => {
    const r = await dispatchForChat('/kanban', '42', '42')
    expect(r).toEqual({ handled: false, outcome: 'unknown', replies: [] })
  })
  it('a FORWARDED registry command is refused, nothing runs; a forwarded unknown word still goes to the model', async () => {
    const r = await dispatchForChat('/status', '42', '42', Date.now(), true, false, true)
    expect(r).toEqual({ handled: true, outcome: 'forwarded-refused', replies: ['Továbbított üzenetből nem futtatok parancsot: /status. Ha kell, írd be magad.'] })
    expect(runs).toBe(0)
    expect((await dispatchForChat('/kanban', '42', '42', Date.now(), true, false, true)).handled).toBe(false)
  })
  it('a write command\'s ? is answered as a read: no deferral, even for a sub-agent', async () => {
    registerCommand({ name: 'irasos', kind: 'write', description: 'ír', help: () => 'SÚGÓ', run: async () => { runs++ } })
    const r = await dispatchForChat('/irasos ?', '42', '42', Date.now(), false, true)
    expect(r).toEqual({ handled: true, outcome: 'ran', replies: ['SÚGÓ'] })
    expect(runs).toBe(0)
  })
  it('plain text is not handled', async () => {
    expect((await dispatchForChat('szia, mi a helyzet?', '42', '42')).handled).toBe(false)
  })
  it('a foreign chat or a missing owner chat runs nothing', async () => {
    expect(await dispatchForChat('/status', '43', '42')).toEqual({ handled: false, outcome: 'not-owner', replies: [] })
    expect((await dispatchForChat('/status', '42', null)).handled).toBe(false)
    expect(runs).toBe(0)
  })
  // ELSOKOR922 fix-forward (3): a sub-agent's READ still dispatches (0 model
  // tokens either way); a WRITE from a sub-agent is refused HERE, one line,
  // without running -- the old gate lived in the Python hook and blocked
  // every non-/usage command for a sub-agent, reads included.
  it('a sub-agent READ dispatches and runs normally', async () => {
    const r = await dispatchForChat('/status', '42', '42', Date.now(), false)
    expect(r).toEqual({ handled: true, outcome: 'ran', replies: ['minden rendben'] })
    expect(runs).toBe(1)
  })
  it('a sub-agent WRITE is refused, one line, and never runs', async () => {
    registerCommand({ name: 'model', kind: 'write', description: 'valt', run: async () => { throw new Error('should not run') } })
    const r = await dispatchForChat('/model opus', '42', '42', Date.now(), false)
    expect(r.handled).toBe(true)
    expect(r.outcome).toBe('sub-agent-write-refused')
    expect(r.replies).toHaveLength(1)
    expect(r.replies[0]).toMatch(/^\/model csak a fő chatből írható/)
  })
  it('deferWrites: a runnable WRITE is answered `deferred` and not run; a READ runs as usual', async () => {
    registerCommand({ name: 'model', kind: 'write', description: 'valt', run: async () => { throw new Error('should not run') } })
    expect(await dispatchForChat('/model opus', '42', '42', Date.now(), true, true)).toEqual({ handled: true, outcome: 'deferred', replies: [] })
    const read = await dispatchForChat('/status', '42', '42', Date.now(), true, true)
    expect(read.outcome).toBe('ran')
    expect(runs).toBe(1)
  })
  it('deferWrites: a planned write still answers "planned" at once (nothing to defer)', async () => {
    const r = await dispatchForChat('/runs stop abc', '42', '42', Date.now(), true, true)
    expect(r.outcome).toBe('planned')
  })
  it('deferWrites: a sub-agent write is still refused, not deferred', async () => {
    registerCommand({ name: 'model', kind: 'write', description: 'valt', run: async () => {} })
    const r = await dispatchForChat('/model opus', '42', '42', Date.now(), false, true)
    expect(r.outcome).toBe('sub-agent-write-refused')
  })
  it('the main session runs the same WRITE normally', async () => {
    let ran = 0
    registerCommand({ name: 'model', kind: 'write', description: 'valt', run: async () => { ran++ } })
    const r = await dispatchForChat('/model opus', '42', '42', Date.now(), true)
    expect(r.outcome).not.toBe('sub-agent-write-refused')
    expect(ran).toBe(1)
  })
})

describe('mainSessionFromBody', () => {
  it('reads an explicit boolean', () => {
    expect(mainSessionFromBody({ mainSession: false })).toBe(false)
    expect(mainSessionFromBody({ mainSession: true })).toBe(true)
  })
  it('defaults to true when missing or non-boolean', () => {
    expect(mainSessionFromBody({})).toBe(true)
    expect(mainSessionFromBody({ mainSession: 'false' })).toBe(true)
    expect(mainSessionFromBody({ mainSession: 0 })).toBe(true)
  })
})

describe('POST /api/commands/dispatch', () => {
  it('is gated: without a credential the auth gate answers 401', () => {
    expect(requiresAuth('/api/commands/dispatch', 'POST')).toBe(true)
    const req: any = { headers: {} }
    const url = new URL('http://localhost:3420/api/commands/dispatch')
    expect(resolveAuth(req, url, url.pathname, 'POST', 'secret-token').kind).toBe('none')
  })
  it('refuses a call carrying an agent identity (403), runs nothing', async () => {
    const { ctx, out } = fakeCtx({ text: '/status', chatId: '42' }, { 'x-agent-id': 'nova' })
    expect(await tryHandleCommands(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(runs).toBe(0)
  })
  it('missing text/chatId -> 400; bad JSON -> 400; GET -> 405', async () => {
    let c = fakeCtx({ text: '/status' })
    await tryHandleCommands(c.ctx)
    expect(c.out.status).toBe(400)
    c = fakeCtx('{nope')
    await tryHandleCommands(c.ctx)
    expect(c.out.status).toBe(400)
    c = fakeCtx({}, {}, 'GET')
    await tryHandleCommands(c.ctx)
    expect(c.out.status).toBe(405)
  })
  it('GET /api/commands/menu lists the runnable names, planned-only left out', async () => {
    const { ctx, out } = fakeCtx({}, {}, 'GET', '/api/commands/menu')
    await tryHandleCommands(ctx)
    expect(out.body.commands.map((c: { command: string }) => c.command)).toEqual(['status'])
  })
  it('other paths are not ours', async () => {
    const { ctx } = fakeCtx({}, {}, 'GET', '/api/status')
    expect(await tryHandleCommands(ctx)).toBe(false)
  })
})
