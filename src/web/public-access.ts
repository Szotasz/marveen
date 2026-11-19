// DOCKERHTTPS1119: the public (domain) access path of a Docker install, and its one-time setup code.
//
// With MARVEEN_DOMAIN set, Caddy serves the dashboard on the internet. It proxies to a SECOND listener
// (WEB_PUBLIC_PORT, 3421), reachable on the compose network only and never published to the host; the usual 3420
// stays the internal path (the agents, an SSH tunnel, the Bridge). Which listener a request came in on is a fact of
// the socket, not of a header a client could forge (X-Forwarded-For) or of the source address (behind Docker's NAT a
// tunnelled request comes from the bridge gateway, not from 127.0.0.1). On the public listener the gate accepts only
// browser cookies (auth-gate.ts resolveAuth): no shared token, no sub-agent token, no device key, no ?token=.
//
// Before the owner has a dashboard password, the first-run paths (routes/auth.ts mayActAsOwnerOrFirstRun) need a
// credential the internet does not have. The dashboard token is not it (it is the fleet's long-lived credential, and a
// log line holding it would stay there). Instead: a one-time setup code, 128 random bits, printed once to the
// container log at start and kept here only as its SHA-256. Redeemed once (POST /api/auth/setup-code, in the body,
// never in a URL), it gives a short setup session cookie, which opens the first-run paths only while no dashboard
// user exists; the first password ends it. A container restart issues a fresh code while no user exists.

import type http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SETUP_COOKIE_NAME = 'mv_setup'
/** How long a printed code can be redeemed. A restart of the container issues a new one. */
export const SETUP_CODE_TTL_MS = 2 * 60 * 60 * 1000
/** How long the setup session lasts once the code is redeemed (the wizard's first step needs minutes). */
export const SETUP_SESSION_TTL_S = 60 * 60

const publicRequests = new WeakSet<http.IncomingMessage>()

/** Called by the public listener for each of its requests, before the shared handler runs. */
export function markPublicRequest(req: http.IncomingMessage): void {
  publicRequests.add(req)
}

/** True when the request arrived on the public listener (Caddy's upstream). */
export function isPublicRequest(req: http.IncomingMessage | undefined): boolean {
  return req !== undefined && publicRequests.has(req)
}

/** The public listener's port from the environment (first-boot writes WEB_PUBLIC_PORT with MARVEEN_DOMAIN), or null. */
export function publicListenerPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.WEB_PUBLIC_PORT ?? '').trim()
  if (!/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 65535 ? n : null
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

let codeHash: Buffer | null = null
let codeIssuedAt = 0
/** SHA-256 (hex) of a live setup-session cookie value -> its expiry (ms). */
const setupSessions = new Map<string, number>()

/** A fresh code (32 hex characters); the previous code and every setup session end. Only its hash is kept. */
export function issueSetupCode(now: number = Date.now()): string {
  const code = randomBytes(16).toString('hex')
  codeHash = sha256(code)
  codeIssuedAt = now
  setupSessions.clear()
  return code
}

/** True while an issued code is unredeemed and inside its TTL. */
export function setupCodeAvailable(now: number = Date.now()): boolean {
  return codeHash !== null && now - codeIssuedAt < SETUP_CODE_TTL_MS
}

/** Normalises what a person types: spaces and dashes are dropped, letters lower-cased. */
function normaliseCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase()
}

/** Redeems the code: on a match (constant-time) the code is used up and a setup-session cookie value is returned. */
export function redeemSetupCode(input: string, now: number = Date.now()): string | null {
  if (!setupCodeAvailable(now) || codeHash === null) return null
  if (!timingSafeEqual(sha256(normaliseCode(input)), codeHash)) return null
  codeHash = null
  const value = randomBytes(32).toString('hex')
  setupSessions.set(sha256(value).toString('hex'), now + SETUP_SESSION_TTL_S * 1000)
  return value
}

/** True when the cookie value is a live setup session. The caller also checks that no dashboard user exists. */
export function isSetupSession(value: string | undefined, now: number = Date.now()): boolean {
  if (!value) return false
  const key = sha256(value).toString('hex')
  const exp = setupSessions.get(key)
  if (exp === undefined) return false
  if (now >= exp) { setupSessions.delete(key); return false }
  return true
}

/** Ends the setup: the code and every setup session (called once the first dashboard login exists). */
export function endSetup(): void {
  codeHash = null
  setupSessions.clear()
}

export function setupSessionCookie(value: string): string {
  return `${SETUP_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SETUP_SESSION_TTL_S}`
}

export function _resetPublicAccessForTest(): void {
  codeHash = null
  codeIssuedAt = 0
  setupSessions.clear()
}
