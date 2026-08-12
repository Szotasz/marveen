import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideTaskTimeout,
  decideLostRedeliveryAction,
  MAX_LOST_REDELIVERIES,
  resolveStuckTimeoutMs,
  TASK_FIRE_GRACE_MS,
  TASK_FIRE_TIMEOUT_MS,
} from '../web/schedule-runner.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'
import { OWNER_ESCALATION_EXTRA_MS } from '../pending-retries.js'

// Tests for the post-fire timeout watchdog.
//
// The watchdog detects a scheduled task/heartbeat that was injected into a
// tmux session and is still running (session busy) past TASK_FIRE_TIMEOUT_MS.
// It closes the gap in the pending_task_retries path, which only triggers when
// a NEW task tries to inject into the already-busy session.
//
// decideTaskTimeout is pure (no I/O, no Map), so the decision logic is fully
// exercisable here without tmux mocks. The fix-revert test at the bottom
// guards against the test becoming a false guard.

const GRACE = TASK_FIRE_GRACE_MS   // 30_000
const TIMEOUT = TASK_FIRE_TIMEOUT_MS // 2_700_000 (45 min)
const MAX_TRACK = 6 * 60 * 60_000   // 6 hours
const OWNER_EXTRA = OWNER_ESCALATION_EXTRA_MS // 75 minutes, shared with the pending-retry escalation

const BASE_OPTS = { graceMs: GRACE, timeoutMs: TIMEOUT, maxTrackMs: MAX_TRACK, ownerExtraMs: OWNER_EXTRA }

// sawTurn defaults to TRUE here: every pre-existing case in this file was
// written for a task that really did start running, and the watchdog's original
// contract (idle => done) is only correct for those. The sawTurn=false cases --
// an injection that never started a turn -- get their own describe block below.
type EntryFields = Pick<TaskInflightEntry, 'injectedAt' | 'alerted' | 'ownerAlerted' | 'sawTurn'>

function makeEntry(overrides: Partial<EntryFields> = {}): EntryFields {
  return { injectedAt: 0, alerted: false, ownerAlerted: false, sawTurn: true, ...overrides }
}

// --- Grace period ---

describe('decideTaskTimeout: grace period', () => {
  it('holds during the grace window even when the pane is busy', () => {
    const entry = makeEntry({ injectedAt: 1000 })
    const now = 1000 + GRACE - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('holds at exactly the grace boundary (< timeout)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })
})

// --- Idle clear ---

describe('decideTaskTimeout: idle clear', () => {
  it('clears immediately when the pane is idle (task completed before timeout)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE + 1000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('done')
  })

  it('clears even before the grace period if somehow idle', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE - 5000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('done')
  })

  it('clears when idle even after the timeout has elapsed', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('done')
  })
})

// --- Timeout alert (the load-bearing case) ---

describe('decideTaskTimeout: timeout alert', () => {
  it('alerts when the session is still busy past the timeout threshold', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('alerts at a much later elapsed time if still busy', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT * 3
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('holds when elapsed is exactly one ms below the timeout', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })
})

// --- Already alerted (one-shot) ---

describe('decideTaskTimeout: one-shot alert flag', () => {
  it('holds after the first alert has been sent (no repeat alerts)', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + 60_000
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('still clears when idle even after alerted', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + 60_000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('done')
  })
})

// --- Lost injection (idle pane that never started a turn) ---
//
// Regression guard for the 2026-08-23 silent loss: two heartbeats were injected
// into a session wedged at 100% context, which presents as a perfectly normal
// idle pane. The watchdog cleared them on the next sweep as "completed", the
// runner had already stamped lastRun, and nothing ever retried them.

describe('decideTaskTimeout: injection that never started a turn', () => {
  it('reports lost when the pane is idle past grace and no turn was ever observed', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = GRACE + 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('lost')
  })

  it('holds inside the grace window -- pre-turn lag is not a loss', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = GRACE - 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('hold')
  })

  it('reports done instead of lost once a turn has been observed', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: true })
    const now = GRACE + 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('done')
  })

  it('still evicts at max tracking age rather than reporting lost', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('abandoned')
  })

  it('does not report lost while the pane is busy -- that is the alert path', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  // SCHEDLOST915: the resubmit chain was still clearing a paste placeholder
  // when the sweep called 'lost' and queued a second copy on top of it.
  it('holds past grace while the post-send resubmit chain still owns the delivery', () => {
    const entry = { ...makeEntry({ injectedAt: 0, sawTurn: false }), deliveryPending: true }
    expect(decideTaskTimeout(entry, 'idle', GRACE + 15_000, BASE_OPTS)).toBe('hold')
  })

  it('reports lost again once the resubmit chain has ended', () => {
    const entry = { ...makeEntry({ injectedAt: 0, sawTurn: false }), deliveryPending: false }
    expect(decideTaskTimeout(entry, 'idle', GRACE + 15_000, BASE_OPTS)).toBe('lost')
  })

  it('a pending delivery does not outlive max tracking age', () => {
    const entry = { ...makeEntry({ injectedAt: 0, sawTurn: false }), deliveryPending: true }
    expect(decideTaskTimeout(entry, 'idle', MAX_TRACK + 1, BASE_OPTS)).toBe('abandoned')
  })
})

// --- Stage-2 escalation ---
//
// alert (stage 1, main-agent notice) must fire and be acknowledged
// (entry.alerted = true) before escalate (stage 2, direct channel alert to
// the owner) can ever fire -- and escalate needs its OWN, LATER threshold
// (timeoutMs + ownerExtraMs), not just "alerted && busy".
describe('decideTaskTimeout: stage-2 owner escalation', () => {
  it('holds after stage-1 alert until the owner threshold is also crossed', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + OWNER_EXTRA - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('escalates once timeoutMs + ownerExtraMs has elapsed and stage 1 already fired', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + OWNER_EXTRA + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('escalate')
  })

  it('does NOT escalate if stage 1 (alerted) never fired, even past the owner threshold', () => {
    // Should not happen in the real sweep (alert always fires first at the
    // earlier threshold), but the decision function must not skip stage 1 on
    // its own -- escalate requires alerted=true explicitly.
    const entry = makeEntry({ injectedAt: 0, alerted: false })
    const now = TIMEOUT + OWNER_EXTRA + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('holds once already escalated (one-shot, no repeat owner alerts)', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true, ownerAlerted: true })
    const now = TIMEOUT + OWNER_EXTRA + 60_000
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('still ends when idle even after escalation, and it ends as done', () => {
    // Upstream wrote this as 'clear'. Since the done/abandoned split that value
    // no longer exists: an idle pane with a turn seen is a FINISHED run, so the
    // honest assertion is 'done'. Changing it is the point of the split, not a
    // concession to it.
    const entry = makeEntry({ injectedAt: 0, alerted: true, ownerAlerted: true })
    const now = TIMEOUT + OWNER_EXTRA + 60_000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('done')
  })

  it('maxTrackMs eviction still wins over escalate for a task configured near the ceiling', () => {
    // Known, accepted limitation (see decideTaskTimeout's doc comment):
    // abandoned (maxTrackMs) is checked before alert/escalate, so a task whose
    // timeoutMs + ownerExtraMs together exceed maxTrackMs never escalates.
    // Upstream called this 'clear'; after the split, giving up on a still-busy
    // task is 'abandoned' -- explicitly NOT 'done', because we never saw it end.
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const nearCeilingOpts = { graceMs: GRACE, timeoutMs: MAX_TRACK - 1000, maxTrackMs: MAX_TRACK, ownerExtraMs: OWNER_EXTRA }
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'busy', now, nearCeilingOpts)).toBe('abandoned')
  })
})

// --- Non-busy pane states ---

describe('decideTaskTimeout: non-busy pane states hold (owned by other watchdogs)', () => {
  const pastTimeout = TIMEOUT + 1000

  it('holds on unknown (session may be restarting)', () => {
    expect(decideTaskTimeout(makeEntry(), 'unknown', pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on null capture (no signal -- be conservative)', () => {
    expect(decideTaskTimeout(makeEntry(), null, pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on error (thinking-block API error -- channel-monitor owns that)', () => {
    expect(decideTaskTimeout(makeEntry(), 'error', pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on typing (post-send resubmit loop is active)', () => {
    expect(decideTaskTimeout(makeEntry(), 'typing', pastTimeout, BASE_OPTS)).toBe('hold')
  })
})

// --- Max track age eviction ---

describe('decideTaskTimeout: max tracking age', () => {
  it('evicts the entry regardless of pane state after maxTrackMs', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('abandoned')
  })

  it('evicts even if the pane is unknown at max age', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'unknown', now, BASE_OPTS)).toBe('abandoned')
  })

  // The load-bearing half of the 2026-08-26 split. Ageing out is NOT success:
  // the session was still busy when we stopped watching. If both cases kept
  // returning one value, recording completions would silently stamp 'done' on
  // every task that ran past six hours -- worse than recording nothing, because
  // it would look like evidence.
  it('a busy session at max age is abandoned, NOT done', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const decision = decideTaskTimeout(entry, 'busy', MAX_TRACK + 1, BASE_OPTS)
    expect(decision).toBe('abandoned')
    expect(decision).not.toBe('done')
  })

  it('an idle session that saw a turn is done, and max age cannot mask it as such', () => {
    const finished = makeEntry({ injectedAt: 0, sawTurn: true })
    expect(decideTaskTimeout(finished, 'idle', GRACE + 1000, BASE_OPTS)).toBe('done')
  })
})

// --- Fix-revert guard ---
//
// This test verifies the test is a REAL guard: if the 'alert' case were
// removed from decideTaskTimeout (returning 'hold' for all busy states),
// the test below would turn RED. A test that stays green after the fix is
// reverted is a false guard and must be discarded.
//
// How to verify: temporarily change decideTaskTimeout so it never returns
// 'alert' (comment out the `if (paneState === 'busy' && elapsed >= ...) return 'alert'`
// line) and confirm this test fails.

describe('fix-revert guard: alert case is load-bearing', () => {
  it('returns alert for a busy session past the threshold -- proves the alert branch fires', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const result = decideTaskTimeout(entry, 'busy', TIMEOUT + 1, BASE_OPTS)
    // If the fix (the alert branch) were removed, result would be 'hold' and
    // this assertion would fail: that is the correct behaviour.
    expect(result).toBe('alert')
    expect(result).not.toBe('hold')
  })
})

// --- Per-task stuck threshold ---
//
// TASK_FIRE_TIMEOUT_MS is one global number. It is the right default for the
// common case (a short-cadence heartbeat still busy after 5 minutes IS a real
// signal) and wrong for a task whose whole job is to think for a while: a
// nightly analysis run was declared a "possible hang" five minutes in, on
// 2026-07-30 at 02:12, and finished normally at 02:18. The operator got a
// false alarm about a task doing exactly what it was written to do.
describe('resolveStuckTimeoutMs: the threshold is per task', () => {
  const MIN = 60_000

  it('falls back to the global default when unset', () => {
    expect(resolveStuckTimeoutMs({})).toBe(TASK_FIRE_TIMEOUT_MS)
  })

  it('honours an explicit longer budget (the nightly analysis case)', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 20 })).toBe(20 * MIN)
  })

  it('a malformed or non-positive value falls back to the default, never to NaN', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: NaN })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 0 })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: -5 })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 'twenty' as unknown as number })).toBe(TASK_FIRE_TIMEOUT_MS)
  })

  it('clamps below one minute so the alert cannot fire inside startup noise', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 0.1 })).toBe(MIN)
  })

  it('clamps to the tracking window, so a huge value cannot silently disable the alert', () => {
    // Entries are evicted at maxTrackMs regardless, so anything above it would
    // mean "never alert" while still looking like a threshold.
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 60 * 24 })).toBe(MAX_TRACK)
  })

  // The clamp above only covers the PER-TASK branch. The default branch returns
  // defaultMs untouched, which was safe while that was a literal 300_000 -- but
  // this value now comes from .env, so an operator writing a big number would
  // get exactly the quiet disable the per-task branch refuses: above the
  // eviction age the entry is gone before the timeout can elapse, and nothing
  // reports it. Mocking the config (rather than asserting on the constant as
  // loaded) is what makes this measure the clamp: without it the test would
  // pass on the unclamped code too, because the default .env sets nothing.
  it('a GLOBAL value above the tracking window is clamped too, not just the per-task one', async () => {
    vi.resetModules()
    vi.doMock('../config.js', async () => ({
      ...(await vi.importActual<typeof import('../config.js')>('../config.js')),
      TASK_STALL_TIMEOUT_MS: 7 * 60 * 60_000,   // 7h, past the 6h eviction age
    }))
    try {
      const mod = await import('../web/schedule-runner.js')
      expect(mod.TASK_FIRE_TIMEOUT_MS).toBe(MAX_TRACK)
      expect(mod.resolveStuckTimeoutMs({})).toBe(MAX_TRACK)
    } finally {
      vi.doUnmock('../config.js')
      vi.resetModules()
    }
  })

  it('the resolved budget actually drives the decision', () => {
    const at6min = 6 * MIN
    const opts = { graceMs: GRACE, maxTrackMs: MAX_TRACK, ownerExtraMs: OWNER_EXTRA }
    // Both budgets are stated EXPLICITLY rather than leaning on the global
    // default. The claim under test is "the resolved budget drives the
    // decision", which says nothing about what the default happens to be --
    // and the default is install-configurable (TASK_STALL_TIMEOUT_MS), so an
    // install that raises it to 10 minutes would have failed this test on a
    // point it never meant to assert.
    // 5-minute budget: 6 minutes of continuous busy is a hang.
    expect(decideTaskTimeout(makeEntry(), 'busy', at6min, { ...opts, timeoutMs: resolveStuckTimeoutMs({ stuckAfterMinutes: 5 }) })).toBe('alert')
    // 20-minute budget: the same 6 minutes is just work in progress.
    expect(decideTaskTimeout(makeEntry(), 'busy', at6min, { ...opts, timeoutMs: resolveStuckTimeoutMs({ stuckAfterMinutes: 20 }) })).toBe('hold')
  })

  it('the sweep uses the entry budget, not the global constant (fix-revert guard)', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/timeoutMs: entry\.timeoutMs,/)
    expect(src).toMatch(/timeoutMs: resolveStuckTimeoutMs\(task\),/)
  })

  // Heartbeats must never reach the owner's Telegram from THIS alert path.
  // Measured 2026-09-01: 40 timeout alerts landed on the owner's phone, 18 of
  // them from `memoria-heartbeat` -- a task that is both `type: heartbeat` and
  // `skipIfBusy: true`. This is the second time heartbeat noise had to be
  // filtered out (2026-08-24 was the catch-up summary), hence a guard.
  it('sendTaskTimeoutAlert bails out for heartbeat tasks (fix-revert guard)', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    // The type must be captured on the entry at injection time...
    expect(src).toMatch(/taskType: task\.type,/)
    expect(src).toMatch(/taskType: string \| undefined/)
    // ...and the alert must return before any network call when it is a heartbeat.
    const fn = src.slice(src.indexOf('function sendTaskTimeoutAlert'))
    const guardAt = fn.indexOf("entry.taskType === 'heartbeat'")
    // Upstream made the alert channel-agnostic (sendTelegramMessage ->
    // sendSchedulerAlertMessage); accept either so the guard outlives a rename.
    const sendAt = Math.max(fn.indexOf('sendSchedulerAlertMessage'), fn.indexOf('sendTelegramMessage'))
    expect(guardAt).toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(sendAt)
  })
})

// --- Bounded 'lost' redelivery ---
//
// Regression guard for an unbounded self-refire loop, measured live
// 2026-09-12 on the main channels agent: 'lost' used to always drop the
// scheduleLastRun stamp and enqueue a fresh retry with no memory of how many
// times this exact occurrence had already been declared lost. The main
// agent's transcript-mtime evidence was blind (see the configDir fix in
// schedule-runner.ts, which reuses agent-process.ts's
// mainAgentConfigDirIfSeparate), so sawTurn depended entirely on catching the
// pane 'busy' in a snapshot -- any sweep that missed a fast heartbeat's busy
// window declared it 'lost' and re-delivered, every ~30s (TASK_FIRE_GRACE_MS),
// indefinitely. Even with correct evidence a single retry is worth keeping (a
// sweep can still land inside the grace window by bad luck), but past
// MAX_LOST_REDELIVERIES the sweep must give up instead of looping forever.
describe('decideLostRedeliveryAction: bounded lost-injection redelivery', () => {
  it('retries on the first lost verdict (zero prior attempts)', () => {
    expect(decideLostRedeliveryAction(0)).toBe('retry')
  })

  it('gives up once prior attempts reach the cap', () => {
    expect(decideLostRedeliveryAction(MAX_LOST_REDELIVERIES)).toBe('giveup')
  })

  it('never returns "retry" past the cap, however high prior attempts climb', () => {
    expect(decideLostRedeliveryAction(MAX_LOST_REDELIVERIES + 5)).toBe('giveup')
  })

  it('honours an explicit cap override rather than the module default', () => {
    expect(decideLostRedeliveryAction(0, 3)).toBe('retry')
    expect(decideLostRedeliveryAction(2, 3)).toBe('retry')
    expect(decideLostRedeliveryAction(3, 3)).toBe('giveup')
  })

  it('the default cap is a small positive number, not accidentally 0 or unbounded', () => {
    // A cap of 0 would give up on the very first 'lost' verdict (no retry ever
    // survives a single blind sweep); this constant is a deliberate policy
    // choice, not a stray default, so pin it against silent drift in either
    // direction.
    expect(MAX_LOST_REDELIVERIES).toBeGreaterThan(0)
    expect(MAX_LOST_REDELIVERIES).toBeLessThanOrEqual(3)
  })
})

// --- Wiring: the sweep's 'lost' branch actually consults the cap ---
//
// decideLostRedeliveryAction is pure and covered above; these guard that the
// imperative sweep (which owns the in-memory attempt counter and cannot be
// unit-tested without a full tmux/DB harness) is actually wired to it, the
// same source-text-guard style already used for the per-task-threshold fix
// above and for the main-agent-missing branch in
// schedule-runner-main-agent-missing.test.ts.
describe('lost-redelivery wiring in the watchdog sweep', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  const lostBranchIdx = SRC.indexOf("} else if (decision === 'lost') {")
  const doneBranchIdx = SRC.indexOf("if (decision === 'done' || decision === 'abandoned') {")

  it('the lost branch consults decideLostRedeliveryAction before re-queueing', () => {
    expect(lostBranchIdx).toBeGreaterThan(0)
    const lostBranch = SRC.slice(lostBranchIdx, lostBranchIdx + 3600)
    expect(lostBranch).toMatch(/decideLostRedeliveryAction\(priorAttempts\)/)
  })

  it("give-up records 'lost-giveup' and does NOT enqueue another pending retry", () => {
    const lostBranch = SRC.slice(lostBranchIdx, lostBranchIdx + 3600)
    const giveupIdx = lostBranch.indexOf("=== 'giveup'")
    expect(giveupIdx).toBeGreaterThan(0)
    const giveupBlock = lostBranch.slice(giveupIdx, lostBranch.indexOf('} else {', giveupIdx))
    expect(giveupBlock).toMatch(/'lost-giveup'/)
    expect(giveupBlock).toMatch(/sendLostRedeliveryGiveUpNotice/)
    expect(giveupBlock).not.toMatch(/insertPendingTaskRetryIfNew/)
  })

  it('a plain retry (not yet at the cap) still enqueues the pending retry, unchanged from before', () => {
    const lostBranch = SRC.slice(lostBranchIdx, lostBranchIdx + 3600)
    const elseIdx = lostBranch.indexOf('} else {')
    const retryBlock = lostBranch.slice(elseIdx, lostBranch.indexOf('}', elseIdx + 8))
    expect(retryBlock).toMatch(/insertPendingTaskRetryIfNew\(entry\.taskName, entry\.agentName, now, 'lost-injection'\)/)
  })

  it('done only forgets the attempt count on genuine success, not on max-track abandonment', () => {
    expect(doneBranchIdx).toBeGreaterThan(0)
    expect(doneBranchIdx).toBeLessThan(lostBranchIdx)
    const doneBlock = SRC.slice(doneBranchIdx, SRC.indexOf("} else if (decision === 'alert')", doneBranchIdx))
    // The delete must be conditioned on decision === 'done' specifically -- an
    // 'abandoned' entry never proved a turn happened, so the next occurrence of
    // the same task@agent must not start over with a fresh budget on a session
    // that may still be silently swallowing prompts.
    expect(doneBlock).toMatch(/if \(decision === 'done'\) \{\s*\n\s*lostRedeliveryCounts\.delete/)
  })
})

// SCHEDLOST915 wiring: the grace window starts at submit, and every exit of the
// resubmit chain ends the delivery phase (otherwise a pending flag stuck at
// true would turn every real loss into a silent hold until max-track age).
describe('in-flight registration wiring', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it('injectedAt is the submit time, not the tick start', () => {
    const sendIdx = SRC.indexOf('await sendPromptToSession(session, fullPrompt, host, { waitForIdle: !task.forceSend })')
    const stampIdx = SRC.indexOf('const submittedAt = Date.now()')
    expect(sendIdx).toBeGreaterThan(0)
    expect(stampIdx).toBeGreaterThan(sendIdx)
    expect(SRC).toMatch(/injectedAt: submittedAt,/)
    expect(SRC).not.toMatch(/injectedAt: now,/)
  })

  it('registers the entry with deliveryPending and clears it on every resubmit exit', () => {
    expect(SRC).toMatch(/deliveryPending: true,\s*\n\s*\}\s*\n\s*taskInflightMap\.set/)
    expect(SRC).toMatch(/if \(res\.value === 'done'\) \{ endDelivery\(\); return \}/)
    expect(SRC).toMatch(/'lane-busy'\)\s*\n\s*endDelivery\(\)\s*\n\s*return/)
    expect(SRC).toMatch(/'Post-send resubmit failed'\)\s*\n\s*endDelivery\(\)/)
  })
})
