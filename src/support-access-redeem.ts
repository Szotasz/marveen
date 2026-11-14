// Support access: turning the one-time code into the narrow token.
//
// The owner asks for a one-time code in their account at the licensing service
// and types it in on this machine. This module checks the code's shape, sends
// it once, and reads the answer strictly. The frozen v1 contract:
//
//   POST https://api.marveen.io/support/v1/code-redeem
//   {"code":"msc_<32 chars>","purpose":"support"}
//   200 {"token":"mst_<43 chars>"}      one key, nothing else
//   401 the code is not good (unknown, expired, used, wrong purpose: all alike)
//   429 wait
//   anything else: the service is not available
//
// RULES THAT HOLD EVERYWHERE HERE
// - Neither the code nor the token nor a response body ever goes into an error,
//   a log line or a return value other than the token itself on success.
// - No retry. The code is single use: when the answer is lost, the owner asks
//   for a new code (the half-made entry is visible and revocable in their
//   account).
// - No redirect is followed, and TLS verification cannot be switched off from
//   the environment.
// - WHERE the code goes is a source constant. No environment variable, config
//   file or request can point this machine at another service: the code is a
//   credential, and whoever receives it can redeem it.
import { request } from 'node:https'
import { isSupportToken } from './support-access-token.js'

/** `msc_` and exactly 32 URL-safe characters. */
export const SUPPORT_CODE_SHAPE = /^msc_[A-Za-z0-9_-]{32}$/
/** The product's own API host. A constant on purpose: see the rules above. */
export const SUPPORT_SERVICE_ORIGIN = 'https://api.marveen.io'
export const SUPPORT_REDEEM_PATH = '/support/v1/code-redeem'
/** A person is waiting at the screen; ten seconds in total, then it is "not available". */
export const SUPPORT_REDEEM_TIMEOUT_MS = 10_000
/** The good answer is under 70 bytes. Anything longer than this is not read. */
export const SUPPORT_REDEEM_MAX_BODY_BYTES = 1024

export type SupportCodeProblem = 'code_required' | 'license_key_not_accepted' | 'code_shape'

export type SupportCodeCheck =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly problem: SupportCodeProblem }

/**
 * Check what the owner typed, BEFORE anything is sent anywhere. White space
 * around a pasted value is dropped; nothing else is repaired. A licence key
 * (`mrv_`) gets its own answer, so the owner learns they pasted the wrong
 * thing, and it never leaves the machine.
 */
export function classifySupportCode(input: unknown): SupportCodeCheck {
  if (typeof input !== 'string') return { ok: false, problem: 'code_required' }
  const code = input.trim()
  if (code.length === 0) return { ok: false, problem: 'code_required' }
  if (code.startsWith('mrv_')) return { ok: false, problem: 'license_key_not_accepted' }
  if (!SUPPORT_CODE_SHAPE.test(code)) return { ok: false, problem: 'code_shape' }
  return { ok: true, code }
}

export interface RedeemRequest {
  readonly origin: string
  readonly path: string
  readonly body: string
  readonly timeoutMs: number
  readonly maxBodyBytes: number
}

export interface RedeemResponse {
  readonly status: number
  readonly body: string
}

/** Sends one POST and resolves with the status and the body; rejects when no answer could be read. */
export type RedeemTransport = (req: RedeemRequest) => Promise<RedeemResponse>

export type RedeemProblem =
  /** 401: the service does not accept this code. */
  | 'code_rejected'
  /** 429. */
  | 'rate_limited'
  /** No answer, or an answer that is none of the known ones. The code may or may not be used up. */
  | 'service_unavailable'
  /** The service said yes and the answer cannot be read as a token. The code IS used up. */
  | 'answer_unreadable'

export type RedeemResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly problem: RedeemProblem }

function tokenFromBody(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'token') return null
  const token = (parsed as { token: unknown }).token
  return isSupportToken(token) ? token : null
}

/**
 * Redeem a code that classifySupportCode accepted. Sends exactly one request,
 * always to SUPPORT_SERVICE_ORIGIN: the caller chooses how it is sent (the
 * transport), never where. Never throws for anything the network or the
 * service does; a caller that hands in an unchecked value gets an exception
 * with a fixed message.
 */
export async function redeemSupportCode(
  code: string,
  deps: { readonly transport: RedeemTransport },
): Promise<RedeemResult> {
  if (!SUPPORT_CODE_SHAPE.test(code)) throw new Error('redeemSupportCode needs a code that classifySupportCode accepted')
  let res: RedeemResponse
  try {
    res = await deps.transport({
      origin: SUPPORT_SERVICE_ORIGIN,
      path: SUPPORT_REDEEM_PATH,
      body: JSON.stringify({ code, purpose: 'support' }),
      timeoutMs: SUPPORT_REDEEM_TIMEOUT_MS,
      maxBodyBytes: SUPPORT_REDEEM_MAX_BODY_BYTES,
    })
  } catch {
    // Whatever went wrong is not repeated here: an error text can quote the request.
    return { ok: false, problem: 'service_unavailable' }
  }
  if (res.status === 401) return { ok: false, problem: 'code_rejected' }
  if (res.status === 429) return { ok: false, problem: 'rate_limited' }
  if (res.status !== 200) return { ok: false, problem: 'service_unavailable' }
  const token = tokenFromBody(res.body)
  if (token === null) return { ok: false, problem: 'answer_unreadable' }
  return { ok: true, token }
}

/**
 * The real transport: one HTTPS POST. `https:` only; the certificate is always
 * verified (the explicit option wins over NODE_TLS_REJECT_UNAUTHORIZED); a
 * redirect is an answer like any other, it is not followed; the body is cut
 * off at the limit and the whole exchange at the deadline. `extraCa` only ADDS
 * a trusted root and exists for the test that runs a local TLS server.
 */
export function createHttpsRedeemTransport(opts: { readonly extraCa?: string } = {}): RedeemTransport {
  return (req) =>
    new Promise<RedeemResponse>((resolve, reject) => {
      let url: URL
      try {
        url = new URL(req.path, req.origin)
      } catch {
        reject(new Error('the service address is not a URL'))
        return
      }
      if (url.protocol !== 'https:') {
        reject(new Error('the service address is not https'))
        return
      }
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        fn()
      }
      const call = request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(req.body) },
          rejectUnauthorized: true,
          ...(opts.extraCa === undefined ? {} : { ca: opts.extraCa }),
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > req.maxBodyBytes) {
              call.destroy()
              finish(() => reject(new Error('the answer is longer than the limit')))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })))
          res.on('error', () => finish(() => reject(new Error('the answer could not be read'))))
        },
      )
      const deadline = setTimeout(() => {
        call.destroy()
        finish(() => reject(new Error('no answer within the time limit')))
      }, req.timeoutMs)
      call.on('error', () => finish(() => reject(new Error('the request failed'))))
      call.end(req.body)
    })
}
