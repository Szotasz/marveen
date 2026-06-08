import { randomBytes } from 'node:crypto'

const TICKET_TTL_S = 30
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_S = 60

interface TicketEntry {
  agentName: string
  expiresAt: number  // epoch seconds
  used: boolean
}

interface RateLimitEntry {
  count: number
  windowStart: number  // epoch seconds
}

const tickets = new Map<string, TicketEntry>()
const rateLimits = new Map<string, RateLimitEntry>()

function cleanupExpired(nowS: number): void {
  for (const [k, v] of tickets) {
    if (nowS >= v.expiresAt) tickets.delete(k)
  }
}

function cleanupExpiredRateLimits(nowS: number): void {
  // Drop entries older than 2× the window — they could not be hit again.
  for (const [k, v] of rateLimits) {
    if (nowS - v.windowStart >= RATE_LIMIT_WINDOW_S * 2) rateLimits.delete(k)
  }
}

export function issueTicket(agentName: string, nowS: number): string {
  cleanupExpired(nowS)
  const ticket = randomBytes(32).toString('hex')
  tickets.set(ticket, { agentName, expiresAt: nowS + TICKET_TTL_S, used: false })
  return ticket
}

export type ConsumeResult =
  | { ok: true; agentName: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' }

export function consumeTicket(ticket: string, nowS: number): ConsumeResult {
  // Check the specific ticket BEFORE global cleanup, so we can distinguish
  // 'expired' (was valid, now stale) from 'not_found' (never existed).
  const entry = tickets.get(ticket)
  if (!entry) return { ok: false, reason: 'not_found' }
  if (nowS >= entry.expiresAt) return { ok: false, reason: 'expired' }
  if (entry.used) return { ok: false, reason: 'already_used' }
  entry.used = true
  cleanupExpired(nowS)
  return { ok: true, agentName: entry.agentName }
}

type RateLimitResult =
  | { ok: true }
  | { ok: false; retry_after_s: number }

export function checkRateLimit(ip: string, nowS: number): RateLimitResult {
  cleanupExpiredRateLimits(nowS)
  const entry = rateLimits.get(ip)
  if (!entry || nowS - entry.windowStart >= RATE_LIMIT_WINDOW_S) {
    rateLimits.set(ip, { count: 1, windowStart: nowS })
    return { ok: true }
  }
  if (entry.count < RATE_LIMIT_MAX) {
    entry.count++
    return { ok: true }
  }
  const retry = Math.ceil(RATE_LIMIT_WINDOW_S - (nowS - entry.windowStart))
  return { ok: false, retry_after_s: retry }
}

export { TICKET_TTL_S }
