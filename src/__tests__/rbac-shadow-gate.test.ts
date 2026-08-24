// RBAC shadow gate unit tests (Phase 0).
//
// Verifies four contracts:
//   1. applyRbacGate shadow -- never blocks, calls onWouldDeny when permission denied
//   2. applyRbacGate enforce -- writes 403 and returns false for denied requests
//   3. applyRbacGate -- admin-token requests always allowed in both modes
//   4. resolveTenantId -- returns 'default' for all auth kinds (until token-based tenant lookup lands)
//
// Uses in-memory mock ServerResponse; no HTTP server spun up.

import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { applyRbacGate, resolveTenantId, resolveRole } from '../web/authz.js'
import type { AuthResult } from '../web/auth-gate.js'

// Minimal mock ServerResponse -- only the methods the RBAC gate writes to.
function mockRes(): http.ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse
}

// A POST to any /api/v1/kanban/* path requires kanban:write.
// viewer role has kanban:read but NOT kanban:write.
const WRITE_PATH = '/api/v1/kanban/cards'
const READ_PATH = '/api/v1/memories'
const WRITE_METHOD = 'POST'
const READ_METHOD = 'GET'

// ── shadow mode ───────────────────────────────────────────────────────────────

describe('applyRbacGate shadow mode', () => {
  it('allows an admin token (kind=token) to any endpoint without would-deny', () => {
    const auth: AuthResult = { kind: 'token' }
    const onWouldDeny = vi.fn()
    const res = mockRes()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, res, 'shadow', onWouldDeny)
    expect(allowed).toBe(true)
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(onWouldDeny).not.toHaveBeenCalled()
  })

  it('allows device (kind=device) to write without would-deny', () => {
    const auth: AuthResult = { kind: 'device', device: 'test-dev', deviceId: 1 }
    const onWouldDeny = vi.fn()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, mockRes(), 'shadow', onWouldDeny)
    expect(allowed).toBe(true)
    expect(onWouldDeny).not.toHaveBeenCalled()
  })

  it('session (viewer) POST to write path: allowed in shadow but fires onWouldDeny', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user' }
    const onWouldDeny = vi.fn()
    const res = mockRes()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, res, 'shadow', onWouldDeny)
    // shadow never blocks
    expect(allowed).toBe(true)
    // no HTTP response written
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
    // but the would-deny callback fired with the reason
    expect(onWouldDeny).toHaveBeenCalledOnce()
    const [reason] = (onWouldDeny as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(reason).toContain('viewer')
    expect(reason).toContain('kanban:write')
  })

  it('session (viewer) GET to read path: allowed without would-deny', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user' }
    const onWouldDeny = vi.fn()
    const allowed = applyRbacGate(auth, READ_METHOD, READ_PATH, mockRes(), 'shadow', onWouldDeny)
    expect(allowed).toBe(true)
    expect(onWouldDeny).not.toHaveBeenCalled()
  })

  it('onWouldDeny is optional -- shadow never throws when omitted', () => {
    const auth: AuthResult = { kind: 'session', user: 'u' }
    expect(() => applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, mockRes(), 'shadow')).not.toThrow()
  })
})

// ── enforce mode ──────────────────────────────────────────────────────────────

describe('applyRbacGate enforce mode', () => {
  it('blocks session (viewer) POST to write path with 403', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user' }
    const res = mockRes()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, res, 'enforce')
    expect(allowed).toBe(false)
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    const body = JSON.parse(((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0] as string))
    expect(body.error).toBe('Forbidden')
  })

  it('allows admin token POST in enforce mode', () => {
    const auth: AuthResult = { kind: 'token' }
    const res = mockRes()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, res, 'enforce')
    expect(allowed).toBe(true)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('allows device (agent) to write in enforce mode', () => {
    const auth: AuthResult = { kind: 'device', device: 'fleet-dev', deviceId: 2 }
    const res = mockRes()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, res, 'enforce')
    expect(allowed).toBe(true)
  })

  it('allows session (viewer) GET to read path in enforce mode', () => {
    const auth: AuthResult = { kind: 'session', user: 'u' }
    const res = mockRes()
    const allowed = applyRbacGate(auth, READ_METHOD, READ_PATH, res, 'enforce')
    expect(allowed).toBe(true)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('federation (agent) allowed to write in enforce mode', () => {
    const auth: AuthResult = { kind: 'federation', peer: 'peer-a' }
    const res = mockRes()
    const allowed = applyRbacGate(auth, WRITE_METHOD, WRITE_PATH, res, 'enforce')
    expect(allowed).toBe(true)
  })
})

// ── resolveTenantId ───────────────────────────────────────────────────────────

describe('resolveTenantId', () => {
  const cases: AuthResult[] = [
    { kind: 'token' },
    { kind: 'device', device: 'dev', deviceId: 1 },
    { kind: 'session', user: 'u' },
    { kind: 'federation', peer: 'p' },
    { kind: 'none' },
  ]
  for (const auth of cases) {
    it(`returns 'default' for kind=${auth.kind}`, () => {
      expect(resolveTenantId(auth)).toBe('default')
    })
  }
})

// ── resolveRole backward-compat ───────────────────────────────────────────────

describe('resolveRole backward-compat', () => {
  it('token -> admin', () => expect(resolveRole({ kind: 'token' })).toBe('admin'))
  it('device -> agent', () => expect(resolveRole({ kind: 'device', device: 'd', deviceId: 1 })).toBe('agent'))
  it('federation -> agent', () => expect(resolveRole({ kind: 'federation', peer: 'p' })).toBe('agent'))
  it('session -> viewer', () => expect(resolveRole({ kind: 'session', user: 'u' })).toBe('viewer'))
  it('none -> viewer (gate will 401 before this matters)', () => expect(resolveRole({ kind: 'none' })).toBe('viewer'))
})
