import { describe, it, expect } from 'vitest'
import { isMalformedBodyError } from '../web/malformed-body.js'

// The two bodies below are not invented shapes: they are the exact failures
// that reached store/dashboard.log on 2026-09-04, one on POST /api/daily-log
// and one on POST /api/kanban. Both answered 500, so every caller-side check
// that looks at the HTTP status read them as "the server broke", and the
// writes were simply gone.
describe('isMalformedBodyError', () => {
  const parseError = (raw: string): unknown => {
    try { JSON.parse(raw); return null } catch (e) { return e }
  }

  it('recognises a raw newline inside a string literal', () => {
    const err = parseError('{"agent_id":"agent","content":"## 14:00 -- Napi\nsor"}')
    expect(err).toBeInstanceOf(SyntaxError)
    expect(isMalformedBodyError(err)).toBe(true)
  })

  it('recognises an unterminated string', () => {
    const err = parseError('{"title":"Kartya cim')
    expect(isMalformedBodyError(err)).toBe(true)
  })

  it('leaves a well-formed body alone', () => {
    expect(parseError('{"ok":true}')).toBeNull()
  })

  it('does not claim our own bugs as the caller"s fault', () => {
    expect(isMalformedBodyError(new TypeError('x is not a function'))).toBe(false)
    expect(isMalformedBodyError(new SyntaxError('Unexpected token in regex'))).toBe(false)
    expect(isMalformedBodyError(new Error('boom'))).toBe(false)
    expect(isMalformedBodyError(undefined)).toBe(false)
  })
})
