import { describe, it, expect } from 'vitest'
import { parseSystemSenderIds } from '../config.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'

// POST /api/messages accepts `from` only from registered fleet agents (plus the
// owner). A neighbouring SYSTEM that merely notifies an agent has no
// agents/<id>/ directory and was rejected outright; SYSTEM_SENDER_IDS is the
// opt-in escape hatch. These cover the default (closed) and the normalization
// symmetry that the surrounding guards depend on.
describe('parseSystemSenderIds', () => {
  it('is empty when unset or blank -- a fresh install stays closed', () => {
    expect(parseSystemSenderIds(undefined, sanitizeAgentIdent).size).toBe(0)
    expect(parseSystemSenderIds('', sanitizeAgentIdent).size).toBe(0)
    // A stray separator must not admit the empty id, which would otherwise
    // match a request whose `from` sanitizes to '' .
    expect(parseSystemSenderIds(' , ,, ', sanitizeAgentIdent).size).toBe(0)
  })

  it('parses a comma-separated list and tolerates surrounding whitespace', () => {
    const s = parseSystemSenderIds('cortex, billing ,ticketing', sanitizeAgentIdent)
    expect(s.has('cortex')).toBe(true)
    expect(s.has('billing')).toBe(true)
    expect(s.has('ticketing')).toBe(true)
    expect(s.size).toBe(3)
  })

  it('does not admit a sender that was never listed', () => {
    const s = parseSystemSenderIds('cortex', sanitizeAgentIdent)
    expect(s.has('zack')).toBe(false)
    expect(s.has('cortex-router')).toBe(false)
  })

  it('normalizes entries with the same function the route matches on', () => {
    // The route tests sanitizeAgentIdent(from) against this set. If the .env
    // entry were stored raw, "@cortex." would sit in the set unmatched while a
    // request sanitizing to "cortex" got rejected -- the asymmetry the
    // neighbouring coordinator guard exists to prevent.
    const s = parseSystemSenderIds('@cortex.', sanitizeAgentIdent)
    expect(s.has(sanitizeAgentIdent('cortex'))).toBe(true)
    expect(s.has(sanitizeAgentIdent('@cortex.'))).toBe(true)
  })
})
