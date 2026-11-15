import { describe, it, expect } from 'vitest'
import { supportSelfProbe, TOKEN_REVOKED_BODY, SUPPORT_ACCESS_CHECK_PATH } from '../support-access-check.js'
import type { RedeemRequest, RedeemTransport } from '../support-access-redeem.js'

// TEST ONLY values.
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const FP = 'SHA256:' + 'A'.repeat(43)
const answering = (status: number, body: string, seen: RedeemRequest[] = []): RedeemTransport => async (req) => {
  seen.push(req)
  return { status, body }
}

describe('the reconcile\'s self-probe (Dani 32056 G1, G5, G6; Mira 78172, 78183)', () => {
  it('asks the access check with probe true, the token as a bearer, and nothing of it in the body', async () => {
    const seen: RedeemRequest[] = []
    await supportSelfProbe({ token: TOKEN, fingerprint: FP }, answering(200, '{}', seen))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ origin: 'https://api.marveen.io', path: SUPPORT_ACCESS_CHECK_PATH, bearer: TOKEN, maxBodyBytes: 2048 })
    expect(JSON.parse(seen[0].body)).toEqual({ key_fingerprint: FP, probe: true })
    expect(seen[0].body).not.toContain(TOKEN)
  })

  it('token_revoked only on 401 with exactly the one-line body', async () => {
    expect(TOKEN_REVOKED_BODY).toBe('{"error":"token_revoked"}')
    expect(await supportSelfProbe({ token: TOKEN, fingerprint: FP }, answering(401, TOKEN_REVOKED_BODY))).toBe('token_revoked')
  })

  it.each<[string, number, string]>([
    ['a bare 401', 401, ''],
    ['the other 401', 401, '{"error":"invalid_status_token"}'],
    ['the body with a line end', 401, TOKEN_REVOKED_BODY + '\n'],
    ['the body with a space', 401, '{"error": "token_revoked"}'],
    ['the body with another key', 401, '{"error":"token_revoked","x":1}'],
    ['the body in other case', 401, '{"error":"TOKEN_REVOKED"}'],
    ['the body with a byte before it', 401, ' ' + TOKEN_REVOKED_BODY],
    ['the right body on 403', 403, TOKEN_REVOKED_BODY],
    ['the right body on 200', 200, TOKEN_REVOKED_BODY],
    ['a 503', 503, ''],
  ])('changes nothing on %s', async (_label, status, body) => {
    expect(await supportSelfProbe({ token: TOKEN, fingerprint: FP }, answering(status, body))).toBe('no_change')
  })

  it('changes nothing when no answer could be read', async () => {
    expect(await supportSelfProbe({ token: TOKEN, fingerprint: FP }, async () => { throw new Error('timeout') })).toBe('no_change')
  })
})
