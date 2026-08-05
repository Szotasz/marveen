import { createHmac, timingSafeEqual } from 'node:crypto'
import { loadOrCreateDashboardToken } from './dashboard-auth.js'

// View tokens are short-lived HMAC-SHA256 tickets that let a browser open an
// artifact without a Bearer header. The scope encodes the artifact ID and
// expiry so the HMAC simultaneously authenticates the ID and the TTL.
const TOKEN_TTL_SEC = 5 * 60 // 5 minutes

// Prefer a dedicated ARTIFACT_HMAC_SECRET so that rotating the dashboard Bearer
// token does not invalidate outstanding view tokens (and vice-versa).
// Rotation: set ARTIFACT_HMAC_SECRET to a new value (openssl rand -hex 32) and
// restart the dashboard -- any in-flight 5-minute view tokens are invalidated,
// which is acceptable given the short TTL.
function getHmacSecret(): string {
  return process.env['ARTIFACT_HMAC_SECRET'] ?? loadOrCreateDashboardToken()
}

function hmacForScope(scope: string): string {
  return createHmac('sha256', getHmacSecret()).update(scope).digest('hex')
}

export function signViewToken(artifactId: string, nowSec: number): { token: string; exp: number } {
  const exp = nowSec + TOKEN_TTL_SEC
  return { token: hmacForScope(`view:${artifactId}:${exp}`), exp }
}

export function verifyViewToken(artifactId: string, token: string, exp: number, nowSec: number): boolean {
  if (nowSec > exp) return false
  const expected = hmacForScope(`view:${artifactId}:${exp}`)
  // Constant-time comparison to prevent timing-based forgery.
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
