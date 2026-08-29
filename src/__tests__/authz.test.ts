import { describe, it, expect } from 'vitest'
import { resolveRole, checkPermission } from '../web/authz.js'
import type { AuthResult } from '../web/auth-gate.js'

// Authorization middleware contract:
//   - resolveRole() maps each AuthResult kind to the correct default Role
//   - checkPermission() is fail-closed: no credential -> 401, missing
//     permission -> 403, admin token -> full access
//   - Backward-compat: kind='token' (dashboard bearer) is always 'admin'
//   - kind='device' (fleet key) is 'agent': can write, cannot reach /api/admin/*
//   - kind='session' (browser login) is 'viewer': read-only
//   - Unrecognized path falls back to admin:all (strictest default)

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN: AuthResult = { kind: 'token' }
const DEVICE: AuthResult = { kind: 'device', device: 'agent-a', deviceId: 1 }
const SESSION: AuthResult = { kind: 'session', user: 'agent-b' }
const FEDERATION: AuthResult = { kind: 'federation', peer: 'peer-x' }
const NONE: AuthResult = { kind: 'none' }

// ── resolveRole ───────────────────────────────────────────────────────────────

describe('resolveRole', () => {
  it('maps token -> admin', () => {
    expect(resolveRole(TOKEN)).toBe('admin')
  })

  it('maps device -> agent', () => {
    expect(resolveRole(DEVICE)).toBe('agent')
  })

  it('maps session -> viewer', () => {
    expect(resolveRole(SESSION)).toBe('viewer')
  })

  it('maps federation -> agent', () => {
    expect(resolveRole(FEDERATION)).toBe('agent')
  })

  it('maps none -> viewer (role is irrelevant; gate will 401)', () => {
    expect(resolveRole(NONE)).toBe('viewer')
  })
})

// ── checkPermission: unauthenticated ─────────────────────────────────────────

describe('checkPermission -- no credentials', () => {
  it('returns 401 for kind=none regardless of path', () => {
    const result = checkPermission(NONE, 'GET', '/api/memories')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(401)
  })
})

// ── checkPermission: admin token (backward-compat) ───────────────────────────

describe('checkPermission -- admin token', () => {
  const cases: [string, string][] = [
    ['GET', '/api/memories'],
    ['POST', '/api/memories'],
    ['DELETE', '/api/memories/123'],
    ['GET', '/api/kanban'],
    ['POST', '/api/kanban'],
    ['GET', '/api/agents'],
    ['POST', '/api/messages'],
    ['GET', '/api/approvals'],
    ['POST', '/api/approvals'],
    ['GET', '/api/blackboard'],
    ['POST', '/api/blackboard'],
    ['GET', '/api/admin/tokens'],
    ['POST', '/api/admin/tokens/1/rotate'],
    ['GET', '/api/federation/manifest'],
    ['POST', '/api/federation/inbox'],
  ]

  for (const [method, path] of cases) {
    it(`allows ${method} ${path}`, () => {
      const result = checkPermission(TOKEN, method, path)
      expect(result.allowed).toBe(true)
    })
  }
})

// ── checkPermission: device key (agent role) ──────────────────────────────────

describe('checkPermission -- device key (agent role)', () => {
  it('allows GET /api/memories', () => {
    expect(checkPermission(DEVICE, 'GET', '/api/memories').allowed).toBe(true)
  })

  it('allows POST /api/memories', () => {
    expect(checkPermission(DEVICE, 'POST', '/api/memories').allowed).toBe(true)
  })

  it('allows POST /api/messages', () => {
    expect(checkPermission(DEVICE, 'POST', '/api/messages').allowed).toBe(true)
  })

  it('allows GET /api/blackboard', () => {
    expect(checkPermission(DEVICE, 'GET', '/api/blackboard').allowed).toBe(true)
  })

  it('denies POST /api/approvals (admin-only write)', () => {
    const result = checkPermission(DEVICE, 'POST', '/api/approvals')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })

  it('denies GET /api/admin/tokens (admin namespace)', () => {
    const result = checkPermission(DEVICE, 'GET', '/api/admin/tokens')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})

// ── checkPermission: session login (viewer role) ──────────────────────────────

describe('checkPermission -- session login (viewer role)', () => {
  it('allows GET /api/memories', () => {
    expect(checkPermission(SESSION, 'GET', '/api/memories').allowed).toBe(true)
  })

  it('allows GET /api/kanban', () => {
    expect(checkPermission(SESSION, 'GET', '/api/kanban').allowed).toBe(true)
  })

  it('denies POST /api/memories (write)', () => {
    const result = checkPermission(SESSION, 'POST', '/api/memories')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })

  it('denies POST /api/kanban (write)', () => {
    const result = checkPermission(SESSION, 'POST', '/api/kanban')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })

  it('allows GET /api/blackboard (viewer has blackboard:read since 668)', () => {
    const result = checkPermission(SESSION, 'GET', '/api/blackboard')
    expect(result.allowed).toBe(true)
  })

  it('denies GET /api/admin/tokens', () => {
    const result = checkPermission(SESSION, 'GET', '/api/admin/tokens')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})

// ── checkPermission: unrecognized path -> admin:all fallback ──────────────────

describe('checkPermission -- unrecognized path', () => {
  it('denies device key on unknown /api/v2/future path', () => {
    const result = checkPermission(DEVICE, 'GET', '/api/v2/future/endpoint')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })

  it('allows admin token on unknown path (admin:all covers it)', () => {
    expect(checkPermission(TOKEN, 'GET', '/api/v2/future/endpoint').allowed).toBe(true)
  })
})

// ── checkPermission: federation peer (agent role) ─────────────────────────────

describe('checkPermission -- federation peer', () => {
  it('allows GET /api/federation/manifest', () => {
    expect(checkPermission(FEDERATION, 'GET', '/api/federation/manifest').allowed).toBe(true)
  })

  it('allows POST /api/federation/inbox', () => {
    expect(checkPermission(FEDERATION, 'POST', '/api/federation/inbox').allowed).toBe(true)
  })

  it('denies GET /api/admin/tokens', () => {
    const result = checkPermission(FEDERATION, 'GET', '/api/admin/tokens')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})

// ── v1 alias parity ───────────────────────────────────────────────────────────

describe('checkPermission -- /api/v1/* canonical paths', () => {
  it('admin token can write /api/v1/memories', () => {
    expect(checkPermission(TOKEN, 'POST', '/api/v1/memories').allowed).toBe(true)
  })

  it('viewer cannot write /api/v1/kanban', () => {
    const result = checkPermission(SESSION, 'POST', '/api/v1/kanban')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})
