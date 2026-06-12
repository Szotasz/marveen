// Cookie-backed server-side sessions for the chat app. Deliberately separate
// from the dashboard bearer token: a chat login must never grant /api/* admin
// access, and the admin token must never reach a chat user's browser. The
// cookie carries a random 256-bit id; only its SHA-256 hash is persisted
// (chat_web_sessions table), so neither the DB file nor a backup yields a
// usable cookie.
import type http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import {
  createChatWebSession, getChatWebSession, deleteChatWebSession,
} from '../../db.js'
import { CHAT_PUBLIC_URL, CHAT_SESSION_TTL_HOURS } from '../../config.js'

export const CHAT_SESSION_COOKIE = 'marveen_chat_sid'

function hashSid(sid: string): string {
  return createHash('sha256').update(sid).digest('hex')
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) out[name] = decodeURIComponent(value)
  }
  return out
}

function cookieIsSecure(): boolean {
  // Behind the public reverse proxy the browser-facing origin is https; on a
  // bare localhost dev setup it is http, where a Secure cookie would never be
  // sent back.
  return CHAT_PUBLIC_URL.startsWith('https://')
}

export function buildSessionCookie(sid: string, maxAgeSeconds: number): string {
  const attrs = [
    `${CHAT_SESSION_COOKIE}=${sid}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (cookieIsSecure()) attrs.push('Secure')
  return attrs.join('; ')
}

export function buildClearedSessionCookie(): string {
  const attrs = [`${CHAT_SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (cookieIsSecure()) attrs.push('Secure')
  return attrs.join('; ')
}

export interface ChatUser {
  email: string
  agentId: string
}

export function createSession(email: string, agentId: string): { sid: string; maxAgeSeconds: number } {
  const sid = randomBytes(32).toString('hex')
  const ttlMs = CHAT_SESSION_TTL_HOURS * 60 * 60 * 1000
  createChatWebSession(hashSid(sid), email, agentId, ttlMs)
  return { sid, maxAgeSeconds: Math.floor(ttlMs / 1000) }
}

// The per-request authorization boundary for /chat-api/*: returns the logged-
// in user (email + their own agent) or null. Every chat endpoint must scope
// strictly to the returned agentId -- never to an agent name taken from the
// request.
export function getChatUser(req: http.IncomingMessage): ChatUser | null {
  const sid = parseCookies(req.headers.cookie)[CHAT_SESSION_COOKIE]
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null
  const session = getChatWebSession(hashSid(sid))
  if (!session) return null
  return { email: session.email, agentId: session.agentId }
}

export function destroySession(req: http.IncomingMessage): void {
  const sid = parseCookies(req.headers.cookie)[CHAT_SESSION_COOKIE]
  if (sid) deleteChatWebSession(hashSid(sid))
}
