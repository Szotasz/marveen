import { describe, it, expect, vi } from 'vitest'
import { normalizePath, applyDeprecationHeaders, SUNSET_DATE, API_V1_PREFIX, API_PREFIX } from '../web/routes/versioning.js'

describe('normalizePath', () => {
  it('strips /v1 prefix from canonical API path', () => {
    const r = normalizePath('/api/v1/memories')
    expect(r.path).toBe('/api/memories')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBe('v1')
  })

  it('handles exact /api/v1 (no trailing slash)', () => {
    const r = normalizePath('/api/v1')
    expect(r.path).toBe('/api')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBe('v1')
  })

  it('handles deeply nested v1 path', () => {
    const r = normalizePath('/api/v1/kanban/cards/abc123/comments')
    expect(r.path).toBe('/api/kanban/cards/abc123/comments')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBe('v1')
  })

  it('marks legacy /api/* paths as deprecated', () => {
    const r = normalizePath('/api/memories')
    expect(r.path).toBe('/api/memories')
    expect(r.deprecated).toBe(true)
    expect(r.apiVersion).toBeNull()
  })

  it('marks exact /api as deprecated', () => {
    const r = normalizePath('/api')
    expect(r.path).toBe('/api')
    expect(r.deprecated).toBe(true)
    expect(r.apiVersion).toBeNull()
  })

  it('does not treat /apiv1/something as a v1 path', () => {
    const r = normalizePath('/apiv1/something')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBeUndefined()
    expect(r.path).toBe('/apiv1/something')
  })

  it('passes through non-API paths unchanged', () => {
    const r = normalizePath('/static/app.js')
    expect(r.path).toBe('/static/app.js')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBeUndefined()
  })

  it('passes through empty string unchanged', () => {
    const r = normalizePath('')
    expect(r.path).toBe('')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBeUndefined()
  })

  it('passes through root path unchanged', () => {
    const r = normalizePath('/')
    expect(r.path).toBe('/')
    expect(r.deprecated).toBe(false)
    expect(r.apiVersion).toBeUndefined()
  })

  it('does not match /api/v1 as a prefix of unrelated paths like /api/v10/', () => {
    const r = normalizePath('/api/v10/something')
    // /api/v10/... starts with /api/ but not /api/v1/ -- so legacy deprecated
    expect(r.deprecated).toBe(true)
    expect(r.apiVersion).toBeNull()
    expect(r.path).toBe('/api/v10/something')
  })
})

describe('applyDeprecationHeaders', () => {
  it('sets the three required headers', () => {
    const headers: Record<string, string> = {}
    const mockRes = { setHeader: (name: string, value: string) => { headers[name] = value } }
    applyDeprecationHeaders(mockRes)
    expect(headers['Deprecation']).toBe('true')
    expect(headers['Sunset']).toBe(SUNSET_DATE)
    expect(headers['Link']).toContain('successor-version')
  })

  it('is idempotent -- calling twice does not throw', () => {
    const mockRes = { setHeader: vi.fn() }
    applyDeprecationHeaders(mockRes)
    applyDeprecationHeaders(mockRes)
    expect(mockRes.setHeader).toHaveBeenCalledTimes(6)
  })
})

describe('constants', () => {
  it('API_V1_PREFIX is a proper prefix of API_PREFIX', () => {
    expect(API_V1_PREFIX.startsWith(API_PREFIX)).toBe(true)
  })

  it('SUNSET_DATE is a non-empty string', () => {
    expect(SUNSET_DATE.length).toBeGreaterThan(0)
  })
})
