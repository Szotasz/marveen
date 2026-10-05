// DASHOPERATOR1005 PR-2: an 'operator' scoped device key reaches /api/operator/*
// only, decided before any handler; it must expire; and only the owner (token,
// session) reads or changes what an operator gets.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createDeviceKey, resolveDeviceKey, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { resolveAuth } from '../web/auth-gate.js'
import { operatorGateDecision, OPERATOR_API_PREFIX } from '../web/operator-gate.js'
import { defaultOperatorAccess, normaliseOperatorAccess, readOperatorAccess, type OperatorAccess } from '../web/operator-access.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleOperatorAccess } from '../web/routes/operator-access.js'
import type { RouteContext } from '../web/routes/types.js'

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => { _clearDeviceKeyCacheForTest() })

const ON: OperatorAccess = { ...defaultOperatorAccess(), enabled: true }
const OFF: OperatorAccess = defaultOperatorAccess()
const operator = { kind: 'device', scope: 'operator' }

// Every /api path the server handles, enumerated from the source (not a hand
// list): literal `path === '/api/...'` checks and `/^\/api\/...$/` matchers,
// with each capture group / wildcard replaced by a concrete segment.
function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    // A regex literal on one line, from `/^\/api\/` up to its closing `$/`.
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!
        .replace(/\([^)]*\)/g, 'x') // capture groups -> one concrete segment
        .replace(/\[[^\]]*\][+*]?/g, 'x') // character classes
        .replace(/\\\//g, '/') // unescape slashes
        .replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

describe('operatorGateDecision over every enumerated /api path', () => {
  const paths = enumerateApiPaths()

  it('the enumeration is not trivially small (the scanner works)', () => {
    expect(paths.length).toBeGreaterThan(150)
    expect(paths).toContain('/api/vault')
    expect(paths).toContain('/api/memories')
    expect(paths).toContain('/api/operator-access')
    // regex routes come out whole, with their parameter as a concrete segment
    expect(paths).toContain('/api/agents/x/keys')
    expect(paths).toContain('/api/vault/x')
  })

  it('an operator key is refused on every path outside /api/operator/', () => {
    const allowed = paths.filter(p => !p.startsWith(OPERATOR_API_PREFIX) && operatorGateDecision(operator, p, () => ON) === null)
    expect(allowed).toEqual([])
  })

  it('with the surface OFF the operator key is refused everywhere, /api/operator/* included', () => {
    expect(operatorGateDecision(operator, '/api/operator/status', () => OFF)).toBe('operator access is turned off')
    expect(operatorGateDecision(operator, '/api/operator/status', () => ON)).toBeNull()
  })

  it('every other credential is untouched by the gate, and it does not even read the switches', () => {
    let reads = 0
    const get = () => { reads++; return OFF }
    for (const kind of ['token', 'session', 'federation']) expect(operatorGateDecision({ kind }, '/api/vault', get)).toBeNull()
    expect(operatorGateDecision({ kind: 'device', scope: 'full' }, '/api/vault', get)).toBeNull()
    expect(reads).toBe(0)
  })
})

describe('the gate binding in web.ts', () => {
  const SRC = readFileSync(join(__dirname, '../web.ts'), 'utf-8')
  it('runs after the 401 check and before ANY handler (network-info and the route chain)', () => {
    const unauthorized = SRC.indexOf("res.end(JSON.stringify({ error: 'Unauthorized' }))")
    const gate = SRC.indexOf('operatorGateDecision(auth, path, () => readOperatorAccess())')
    const networkInfo = SRC.indexOf("if (path === '/api/network-info' && method === 'GET')")
    const firstHandler = SRC.indexOf('if (await tryHandleAuth(routeCtx)) return')
    expect(unauthorized).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(unauthorized)
    expect(gate).toBeLessThan(networkInfo)
    expect(gate).toBeLessThan(firstHandler)
    expect(SRC.slice(gate - 200, gate)).toMatch(/if \(requiresAuth\(path, method\)\) \{/)
  })
})

describe('operator device keys', () => {
  it('an operator key cannot be minted without an expiry', () => {
    expect(() => createDeviceKey('it-op', { scope: 'operator' })).toThrow(/must expire/)
  })

  it('the scope travels from the stored key to the gate', () => {
    const k = createDeviceKey('it-op', { scope: 'operator', expiresInDays: 30 })
    _clearDeviceKeyCacheForTest() // force the DB path
    expect(resolveDeviceKey(k.key)?.scope).toBe('operator')
    const req: any = { headers: { authorization: `Bearer ${k.key}` } }
    const auth = resolveAuth(req, new URL('http://x/api/vault'), '/api/vault', 'GET', 'a'.repeat(64))
    expect(auth).toMatchObject({ kind: 'device', scope: 'operator' })
  })

  it('a key minted without a scope is a full key (existing behaviour unchanged)', () => {
    const k = createDeviceKey('phone')
    expect(k.scope).toBe('full')
    expect(resolveDeviceKey(k.key)?.scope).toBe('full')
  })
})

function fakeCtx(method: string, path: string, body: unknown, auth: RouteContext['auth']) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json' }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), auth } as RouteContext, out }
}

describe('POST /api/auth/device-keys with a scope', () => {
  const owner = { kind: 'token' } as RouteContext['auth']

  it('an operator key defaults to 90 days', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: 'it-op', scope: 'operator' }, owner)
    await tryHandleAuth(ctx)
    expect(out.status).toBe(201)
    expect(out.body.scope).toBe('operator')
    const days = (out.body.expires_at - out.body.created_at) / 86400
    expect(days).toBe(90)
  })

  it('an operator key with an explicit "no expiry" is refused', async () => {
    for (const expires of [0, null]) {
      const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: 'it-op', scope: 'operator', expires_in_days: expires }, owner)
      await tryHandleAuth(ctx)
      expect(out.status).toBe(400)
    }
  })

  it('an unknown scope is refused', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: 'x', scope: 'admin' }, owner)
    await tryHandleAuth(ctx)
    expect(out.status).toBe(400)
  })
})

describe('the owner switches', () => {
  it('only a literal true turns anything on; unknown keys and commands are dropped', () => {
    const a = normaliseOperatorAccess({ enabled: 'yes', capabilities: { update: true, paneView: 1, bogus: true }, commands: ['login', 'rm -rf', 'mcp', 'login'] })
    expect(a.enabled).toBe(false)
    expect(a.capabilities).toEqual({ agentControl: false, update: true, vaultWrite: false, paneView: false, commands: false })
    expect(a.commands).toEqual(['login', 'mcp'])
  })

  it('a missing or malformed file reads as everything OFF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-access-'))
    expect(readOperatorAccess(join(dir, 'nope.json'))).toEqual(defaultOperatorAccess())
    writeFileSync(join(dir, 'bad.json'), '{"enabled": tru')
    expect(readOperatorAccess(join(dir, 'bad.json'))).toEqual(defaultOperatorAccess())
  })

  it('GET/PUT /api/operator-access is owner-only: device keys (full or operator) get 403', async () => {
    for (const auth of [{ kind: 'device', scope: 'full' }, { kind: 'device', scope: 'operator' }, { kind: 'federation' }] as RouteContext['auth'][]) {
      const { ctx, out } = fakeCtx('GET', '/api/operator-access', undefined, auth)
      expect(await tryHandleOperatorAccess(ctx)).toBe(true)
      expect(out.status).toBe(403)
    }
  })
})
