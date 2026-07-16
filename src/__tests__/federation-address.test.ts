import { describe, it, expect } from 'vitest'
import {
  parseQualifiedId,
  isQualifiedId,
  isValidIdSegment,
  formatQualifiedId,
  federationSource,
} from '../web/federation/address.js'

// Parsing is strict by contract: an id either matches exactly or is rejected,
// never "sanitized and passed along" (sanitizeAgentIdent would collapse
// 'a/bc' and 'ab/c' into the same 'abc').
describe('parseQualifiedId', () => {
  it('parses a plain qualified id', () => {
    expect(parseQualifiedId('teodor/backend-dev')).toEqual({ system: 'teodor', agent: 'backend-dev' })
  })

  it('returns null for local (slash-free) ids', () => {
    expect(parseQualifiedId('marveen')).toBeNull()
    expect(parseQualifiedId('')).toBeNull()
  })

  it('returns null for non-strings', () => {
    expect(parseQualifiedId(undefined)).toBeNull()
    expect(parseQualifiedId(null)).toBeNull()
    expect(parseQualifiedId(42 as unknown as string)).toBeNull()
  })

  it('rejects more than one separator', () => {
    expect(parseQualifiedId('a/b/c')).toBeNull()
    expect(parseQualifiedId('teodor//x')).toBeNull()
  })

  it('rejects empty segments', () => {
    expect(parseQualifiedId('/agent')).toBeNull()
    expect(parseQualifiedId('system/')).toBeNull()
    expect(parseQualifiedId('/')).toBeNull()
  })

  it('rejects path-traversal shapes (no dots in the whitelist)', () => {
    expect(parseQualifiedId('../x')).toBeNull()
    expect(parseQualifiedId('a/..')).toBeNull()
    expect(parseQualifiedId('./x')).toBeNull()
  })

  it('rejects Unicode / homoglyph segments', () => {
    expect(parseQualifiedId('teоdor/x')).toBeNull() // Cyrillic о
    expect(parseQualifiedId('теодор/x')).toBeNull()
    expect(parseQualifiedId('a b/x')).toBeNull()
  })

  it('rejects segments that do not start alphanumeric', () => {
    expect(parseQualifiedId('-sys/agent')).toBeNull()
    expect(parseQualifiedId('sys/_agent')).toBeNull()
  })

  it('enforces the 64-char segment cap', () => {
    const ok = 'a'.repeat(64)
    const long = 'a'.repeat(65)
    expect(parseQualifiedId(`${ok}/x`)).not.toBeNull()
    expect(parseQualifiedId(`${long}/x`)).toBeNull()
    expect(parseQualifiedId(`x/${long}`)).toBeNull()
  })

  it('allows underscores and hyphens after the first char', () => {
    expect(parseQualifiedId('sys-1/agent_2')).toEqual({ system: 'sys-1', agent: 'agent_2' })
  })
})

describe('isQualifiedId', () => {
  it('is a TOTAL predicate on slash presence (valid or not)', () => {
    // The router relies on this to divert EVERY slash-bearing recipient away
    // from the local filesystem path -- malformed ones included.
    expect(isQualifiedId('teodor/x')).toBe(true)
    expect(isQualifiedId('../x')).toBe(true)
    expect(isQualifiedId('a/b/c')).toBe(true)
    expect(isQualifiedId('local')).toBe(false)
    expect(isQualifiedId(undefined)).toBe(false)
  })
})

describe('isValidIdSegment / helpers', () => {
  it('validates single segments', () => {
    expect(isValidIdSegment('marveen')).toBe(true)
    expect(isValidIdSegment('')).toBe(false)
    expect(isValidIdSegment('a/b')).toBe(false)
    expect(isValidIdSegment('..')).toBe(false)
  })

  it('formats and derives the wrap source', () => {
    expect(formatQualifiedId('teodor', 'teodor')).toBe('teodor/teodor')
    expect(federationSource({ system: 'teodor', agent: 'dev' })).toBe('federation:teodor:dev')
  })
})
