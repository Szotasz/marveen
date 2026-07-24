// Login brute-force throttle for the dashboard browser login.
//
// In-memory (single-process server). Keyed by lowercased username: the server
// is loopback / reverse-proxy fronted so the client IP is almost always
// 127.0.0.1, making per-IP keying decoration -- a global counter covers the
// distributed-username case instead.
//
// Policy:
//   - 5 consecutive failures for a username -> lock 30s, doubling each further
//     failure to a 15min cap. A success clears that username's counter.
//   - Global: 50 failed attempts within a rolling hour -> every login gets 429
//     until the window drains (loud log at the call site).
//
// An unknown username must be indistinguishable from a wrong password: the
// caller runs verifyPassword against a process-lifetime dummy hash (runDummyVerify)
// so timing and lockout behavior cannot enumerate users. In-memory reset on
// restart is accepted (restarts are operator/updater events).

import { randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from './password-hash.js'

const MAX_CONSECUTIVE_BEFORE_LOCK = 5
const BASE_LOCK_MS = 30 * 1000
const MAX_LOCK_MS = 15 * 60 * 1000
const GLOBAL_WINDOW_MS = 60 * 60 * 1000
const GLOBAL_MAX_FAILURES = 50

interface UserThrottle {
  failures: number
  lockedUntil: number
}

const perUser = new Map<string, UserThrottle>()
let globalFailures: number[] = []

export interface ThrottleState {
  locked: boolean
  retryAfterS: number
  global: boolean
}

function pruneGlobal(now: number): void {
  const cutoff = now - GLOBAL_WINDOW_MS
  if (globalFailures.length && globalFailures[0] < cutoff) {
    globalFailures = globalFailures.filter((t) => t >= cutoff)
  }
}

// Is this login currently blocked? Checked BEFORE any password verification so a
// locked account never even reaches the KDF.
export function checkThrottle(usernameLc: string, now: number = Date.now()): ThrottleState {
  pruneGlobal(now)
  if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
    const retry = Math.ceil((globalFailures[0] + GLOBAL_WINDOW_MS - now) / 1000)
    return { locked: true, retryAfterS: Math.max(1, retry), global: true }
  }
  const u = perUser.get(usernameLc)
  if (u && u.lockedUntil > now) {
    return { locked: true, retryAfterS: Math.max(1, Math.ceil((u.lockedUntil - now) / 1000)), global: false }
  }
  return { locked: false, retryAfterS: 0, global: false }
}

export function recordFailure(usernameLc: string, now: number = Date.now()): void {
  globalFailures.push(now)
  const u = perUser.get(usernameLc) ?? { failures: 0, lockedUntil: 0 }
  u.failures += 1
  if (u.failures >= MAX_CONSECUTIVE_BEFORE_LOCK) {
    const over = u.failures - MAX_CONSECUTIVE_BEFORE_LOCK // 0 at the 5th failure
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS)
    u.lockedUntil = now + lockMs
  }
  perUser.set(usernameLc, u)
}

export function recordSuccess(usernameLc: string): void {
  perUser.delete(usernameLc)
}

// True once the global rolling-hour failure cap is hit -- the caller logs it.
export function isGlobalLimited(now: number = Date.now()): boolean {
  pruneGlobal(now)
  return globalFailures.length >= GLOBAL_MAX_FAILURES
}

// Timing equalizer: verify the presented password against a stable per-process
// dummy hash so an unknown-username path costs the same as a real verify.
let dummyHashPromise: Promise<string> | null = null
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(randomBytes(24).toString('hex'))
  return dummyHashPromise
}

export async function runDummyVerify(password: string): Promise<void> {
  try {
    await verifyPassword(password, await getDummyHash())
  } catch {
    /* equalizer only -- result discarded */
  }
}

// Test seam.
export function _resetThrottleForTest(): void {
  perUser.clear()
  globalFailures = []
}
