// Support access: the password check in front of enabling support standby.
//
// ONE bucket for the whole machine, separate from the login's (Dani 78357, Q4):
//   - 5 wrong passwords within 15 minutes lock it for 15 minutes;
//   - the third lock within 24 hours locks it until the owner's next
//     successful dashboard LOGIN (not a support password), and alerts the owner;
//   - while it is locked every attempt gets the same answer, whether the
//     password is right or wrong, and the password is not even checked.
//
// The state survives a restart (it is kept in the database through `store`):
// a restart must not buy a fresh set of guesses. A stolen session cookie can
// reach this route, which is why it has its own, stricter bucket.

export const SUPPORT_PASSWORD_WINDOW_MS = 15 * 60 * 1000
export const SUPPORT_PASSWORD_MAX_FAILURES = 5
export const SUPPORT_PASSWORD_LOCK_MS = 15 * 60 * 1000
export const SUPPORT_PASSWORD_LOCKS_WINDOW_MS = 24 * 60 * 60 * 1000
export const SUPPORT_PASSWORD_LOCKS_BEFORE_HARD = 3

export interface SupportPasswordState {
  /** Times of the wrong passwords since the last lock or success, in the window. */
  readonly failures: readonly number[]
  readonly lockedUntil: number
  /** Times of the locks in the last 24 hours. */
  readonly locks: readonly number[]
  /** Locked until the owner's next successful login. */
  readonly hardLocked: boolean
}

export const SUPPORT_PASSWORD_STATE_EMPTY: SupportPasswordState = { failures: [], lockedUntil: 0, locks: [], hardLocked: false }

export interface SupportPasswordStore {
  readonly load: () => SupportPasswordState
  readonly save: (state: SupportPasswordState) => void
}

export type SupportPasswordVerdict =
  | { readonly locked: false }
  /** retryAfterS is null for the hard lock: it does not end by itself. */
  | { readonly locked: true; readonly retryAfterS: number | null }

/** A state read back from the store: anything that is not exactly the shape counts as the hard lock (fail closed). */
export function normaliseSupportPasswordState(raw: unknown): SupportPasswordState {
  const isTimes = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 64 && v.every((t) => Number.isSafeInteger(t) && t >= 0)
  if (raw === null || typeof raw !== 'object') return { ...SUPPORT_PASSWORD_STATE_EMPTY, hardLocked: true }
  const r = raw as Record<string, unknown>
  if (!isTimes(r.failures) || !isTimes(r.locks) || !Number.isSafeInteger(r.lockedUntil) || typeof r.hardLocked !== 'boolean') {
    return { ...SUPPORT_PASSWORD_STATE_EMPTY, hardLocked: true }
  }
  return { failures: r.failures, lockedUntil: r.lockedUntil as number, locks: r.locks, hardLocked: r.hardLocked }
}

export function createSupportPasswordGate(deps: {
  readonly store: SupportPasswordStore
  readonly now: () => number
  /** Called once, when the hard lock falls. Must not throw into the caller; its failure is the caller's to log. */
  readonly alertHardLock: () => void
}) {
  const { store, now } = deps

  function check(): SupportPasswordVerdict {
    const s = store.load()
    if (s.hardLocked) return { locked: true, retryAfterS: null }
    const t = now()
    if (s.lockedUntil > t) return { locked: true, retryAfterS: Math.max(1, Math.ceil((s.lockedUntil - t) / 1000)) }
    return { locked: false }
  }

  function recordFailure(): void {
    const s = store.load()
    if (s.hardLocked) return
    const t = now()
    // A failure while locked does not count (Dani's review of #2781, N2): a burst must not build the next lock.
    if (s.lockedUntil > t) return
    const failures = [...s.failures.filter((f) => f > t - SUPPORT_PASSWORD_WINDOW_MS), t]
    if (failures.length < SUPPORT_PASSWORD_MAX_FAILURES) {
      store.save({ ...s, failures })
      return
    }
    const locks = [...s.locks.filter((l) => l > t - SUPPORT_PASSWORD_LOCKS_WINDOW_MS), t]
    const hardLocked = locks.length >= SUPPORT_PASSWORD_LOCKS_BEFORE_HARD
    store.save({ failures: [], lockedUntil: t + SUPPORT_PASSWORD_LOCK_MS, locks, hardLocked })
    if (hardLocked) deps.alertHardLock()
  }

  /** A right password: the wrong ones before it no longer count towards a lock. The locks of the day still do. */
  function recordSuccess(): void {
    const s = store.load()
    if (s.failures.length > 0) store.save({ ...s, failures: [] })
  }

  /** The owner logged in with the dashboard password: every lock of this bucket ends. */
  function ownerLoggedIn(): void {
    const s = store.load()
    if (s.hardLocked || s.lockedUntil > 0 || s.failures.length > 0 || s.locks.length > 0) store.save(SUPPORT_PASSWORD_STATE_EMPTY)
  }

  return { check, recordFailure, recordSuccess, ownerLoggedIn }
}

export type SupportPasswordGate = ReturnType<typeof createSupportPasswordGate>
