import { describe, it, expect } from 'vitest'
import { ERROR_TOKENS, ALLOWED_STATUS_TOKENS, checkErrorResponse } from '../api-error-catalog.js'

describe('api-error-catalog invariants', () => {
  it('has no duplicate tokens', () => {
    expect(new Set(ERROR_TOKENS).size).toBe(ERROR_TOKENS.length)
  })

  it('all ALLOWED_STATUS_TOKENS entries reference valid tokens', () => {
    const valid = new Set(ERROR_TOKENS)
    for (const [status, tokens] of Object.entries(ALLOWED_STATUS_TOKENS)) {
      for (const t of tokens) {
        expect(valid.has(t), `${t} in status ${status} not in catalog`).toBe(true)
      }
    }
  })

  it('known valid pairings pass', () => {
    expect(checkErrorResponse('not_found', 404)).toBeNull()
    expect(checkErrorResponse('internal_error', 500)).toBeNull()
    expect(checkErrorResponse('upstream_error', 502)).toBeNull()
    expect(checkErrorResponse('required', 400)).toBeNull()
    expect(checkErrorResponse('disabled', 409)).toBeNull()
    expect(checkErrorResponse('sender_not_in_allowlist', 403)).toBeNull()
    expect(checkErrorResponse('federation_disabled', 400)).toBeNull()
    expect(checkErrorResponse('unknown_query_parameter', 400)).toBeNull()
  })

  it('catches unknown token', () => {
    expect(checkErrorResponse('some_random_thing', 400)).toMatch(/unknown error token/)
  })

  it('catches forbidden status-token pairing (internal_error + 400)', () => {
    expect(checkErrorResponse('internal_error', 400)).toMatch(/not allowed with HTTP 400/)
  })

  it('catches forbidden pairing (not_found + 500)', () => {
    expect(checkErrorResponse('not_found', 500)).toMatch(/not allowed with HTTP 500/)
  })

  it('catches forbidden pairing (upstream_error + 500)', () => {
    expect(checkErrorResponse('upstream_error', 500)).toMatch(/not allowed with HTTP 500/)
  })

  it('catches forbidden pairing (forbidden + 400)', () => {
    expect(checkErrorResponse('forbidden', 400)).toMatch(/not allowed with HTTP 400/)
  })

  it('returns null for unconstrained status (e.g. 200 with no error field check needed)', () => {
    // Statuses not in ALLOWED_STATUS_TOKENS are unconstrained -- any valid token passes.
    expect(checkErrorResponse('not_found', 200)).toBeNull()
  })
})
