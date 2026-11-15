// Support access: the reconcile's self-probe to marveen.io (SUPPORTKULCS1109,
// PR1b 2b-3; Mira 78172 and 78183, Dani 32056 G1-G6).
//
// The machine asks the access check with `"probe": true`. The answer of a probe
// is always a deny and the machine never uses it to let anyone in. It looks at
// ONE thing only: after "Remove the machine" in the account, the service answers
// HTTP 401 with exactly the one-line body {"error":"token_revoked"} (no line end,
// no other key, no other spelling). That, and only that, says the machine should
// take its support lines and its token away. Every other answer changes nothing:
// a bare 401, a 401 with another body, any other status, a network error, a
// timeout (G1, G5). The body is compared byte for byte, never parsed.
//
// The transport is the redeem's (G1: fixed https origin, the certificate always
// verified, no redirect followed, a size and a time limit); the token goes in the
// Authorization header, never in the body or a log.
import { SUPPORT_SERVICE_ORIGIN, type RedeemTransport } from './support-access-redeem.js'

export const SUPPORT_ACCESS_CHECK_PATH = '/support/v1/access-check'
export const SUPPORT_ACCESS_CHECK_TIMEOUT_MS = 10_000
/** The v1 answer is at most 2048 bytes (terv-v7 3.6). */
export const SUPPORT_ACCESS_CHECK_MAX_BODY_BYTES = 2048
/** The one body that means "this machine was removed in the account" (Mira 78172, 78183: no trailing newline). */
export const TOKEN_REVOKED_BODY = '{"error":"token_revoked"}'

export type SelfProbeVerdict = 'token_revoked' | 'no_change'

/** Ask once, with the token and one fingerprint of the group. Never rejects. */
export async function supportSelfProbe(input: { readonly token: string; readonly fingerprint: string }, transport: RedeemTransport): Promise<SelfProbeVerdict> {
  let res
  try {
    res = await transport({
      origin: SUPPORT_SERVICE_ORIGIN,
      path: SUPPORT_ACCESS_CHECK_PATH,
      body: JSON.stringify({ key_fingerprint: input.fingerprint, probe: true }),
      timeoutMs: SUPPORT_ACCESS_CHECK_TIMEOUT_MS,
      maxBodyBytes: SUPPORT_ACCESS_CHECK_MAX_BODY_BYTES,
      bearer: input.token,
    })
  } catch {
    return 'no_change'
  }
  return res.status === 401 && res.body === TOKEN_REVOKED_BODY ? 'token_revoked' : 'no_change'
}
