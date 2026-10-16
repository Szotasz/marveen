// Browser sessions for the IT operator (DASHOPERATOR1005 PR-3).
//
// The operator signs in once with the operator key; the server answers with an
// opaque HttpOnly + SameSite=Strict cookie, so the key itself never sits in the
// browser's storage and never travels in a URL (the SECHARDEN d) lesson).
//
// The session points at the device key by id and re-checks that key on EVERY
// request: revoking or expiring the key ends the session on the next call, with
// no separate session to forget. Held in memory on purpose -- a dashboard
// restart (an update, for one) signs the operator out, which costs one login and
// leaves nothing on disk to steal.

import { randomBytes } from 'node:crypto'
import { getDeviceKey } from './auth-device-keys.js'

export const OPERATOR_COOKIE_NAME = 'mv_operator'
/** A browser session never outlives this, nor the key it came from. */
export const OPERATOR_SESSION_MAX_SEC = 12 * 60 * 60

interface OperatorSession {
  deviceId: number
  expiresAt: number // unix seconds
}

const sessions = new Map<string, OperatorSession>()

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** Mint a session for an operator key; returns the cookie value and its lifetime. */
export function createOperatorSession(deviceId: number, keyExpiresAt: number | null): { token: string; maxAgeSec: number } {
  const now = nowSec()
  // Logins are rare, so sweeping here keeps the map bounded without a timer.
  for (const [t, s] of sessions) if (s.expiresAt <= now) sessions.delete(t)
  const cap = now + OPERATOR_SESSION_MAX_SEC
  const expiresAt = keyExpiresAt !== null && keyExpiresAt < cap ? keyExpiresAt : cap
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, { deviceId, expiresAt })
  return { token, maxAgeSec: Math.max(0, expiresAt - now) }
}

/**
 * The live operator behind a cookie, or null. Null when the session is unknown
 * or past its end, or when the key behind it was revoked, has expired, or is
 * no longer an operator key.
 */
export function resolveOperatorSession(token: string): { device: string; deviceId: number } | null {
  const s = sessions.get(token)
  if (!s) return null
  const now = nowSec()
  if (s.expiresAt <= now) { sessions.delete(token); return null }
  const key = getDeviceKey(s.deviceId)
  if (!key || key.scope !== 'operator' || (key.expiresAt !== null && key.expiresAt <= now)) {
    sessions.delete(token)
    return null
  }
  return { device: key.name, deviceId: key.id }
}

export function revokeOperatorSession(token: string): void {
  sessions.delete(token)
}

export function _clearOperatorSessionsForTest(): void {
  sessions.clear()
}
