import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldAlertParkedGiveUp } from '../web/stuck-input-watcher.js'

// RIASZTASZAJ819: three identical owner alerts in one afternoon ("a samu
// agens bemenete beragadt ... kezi restart kell") at an agent that was
// demonstrably WORKING -- its outbound messages bracket every alert
// timestamp, and no manual restart happened or was needed. Parked input at a
// BUSY agent is a message waiting out the current turn; the owner alert must
// require an IDLE pane. The naive fix (raising thresholds or muting the
// alert) would silence the REAL wedge too -- the goal is a correct alert,
// not fewer alerts.

const MAX = 5

describe('shouldAlertParkedGiveUp (pure)', () => {
  const base = { attempts: MAX, maxAttempts: MAX, alreadyAlerted: false }

  it('busy pane suppresses the owner alert (waiting, not wedged)', () => {
    expect(shouldAlertParkedGiveUp({ ...base, paneState: 'busy' })).toBe(false)
  })

  it('idle pane with a spent give-up threshold alerts (the genuine wedge)', () => {
    expect(shouldAlertParkedGiveUp({ ...base, paneState: 'idle' })).toBe(true)
  })

  it("typing and unknown panes alert too -- 'unknown' must not become a silent hole", () => {
    expect(shouldAlertParkedGiveUp({ ...base, paneState: 'typing' })).toBe(true)
    expect(shouldAlertParkedGiveUp({ ...base, paneState: 'unknown' })).toBe(true)
    expect(shouldAlertParkedGiveUp({ ...base, paneState: null })).toBe(true)
  })

  it('below the give-up threshold never alerts, whatever the pane says', () => {
    expect(shouldAlertParkedGiveUp({ ...base, attempts: MAX - 1, paneState: 'idle' })).toBe(false)
  })

  it('one alert per spell: alreadyAlerted suppresses a repeat', () => {
    expect(shouldAlertParkedGiveUp({ ...base, alreadyAlerted: true, paneState: 'idle' })).toBe(false)
  })

  it('the deferred-alert shape: busy ticks suppress, the first idle tick fires', () => {
    // A spell that crosses max while the agent is mid-turn must not lose its
    // alert forever -- when the turn ends and the input is STILL parked, the
    // next tick alerts. Replayed as the decision sequence:
    const ticks: Array<{ paneState: 'busy' | 'idle'; expected: boolean }> = [
      { paneState: 'busy', expected: false },
      { paneState: 'busy', expected: false },
      { paneState: 'idle', expected: true },
    ]
    let alerted = false
    for (const t of ticks) {
      const fire = shouldAlertParkedGiveUp({ ...base, alreadyAlerted: alerted, paneState: t.paneState })
      expect(fire).toBe(t.expected)
      if (fire) alerted = true
    }
  })
})

// --- wiring contract (structurally anchored windows, never needle-derived) ---

const ROOT = join(__dirname, '..', '..')
const SRC = readFileSync(join(ROOT, 'src', 'web', 'stuck-input-watcher.ts'), 'utf-8')

describe('wiring: the owner alert goes through the gate, recovery does not', () => {
  // Window: from the checkLocalSession declaration to the function's own
  // closing brace (column-0), not derived from any sought string.
  const start = SRC.indexOf('async function checkLocalSession')
  const fnBody = SRC.slice(start, SRC.indexOf('\n}', start))

  it('checkLocalSession exists and its alert is gated by shouldAlertParkedGiveUp', () => {
    expect(start).toBeGreaterThanOrEqual(0)
    expect(fnBody).toMatch(/shouldAlertParkedGiveUp\(/)
    // The sendAlert call must be INSIDE the gated branch: no sendAlert may
    // appear in the body before the gate call.
    const gateIdx = fnBody.indexOf('shouldAlertParkedGiveUp(')
    const alertIdx = fnBody.indexOf('sendAlert(')
    expect(alertIdx).toBeGreaterThan(gateIdx)
  })

  it('the pane state is read fresh at alert time (capturePane + detectPaneState)', () => {
    expect(fnBody).toMatch(/capturePane\(session\)/)
    expect(fnBody).toMatch(/detectPaneState\(pane\)/)
  })

  it('a spell that ends clears the one-alert-per-spell marker', () => {
    // Spell end is the parkedSig === null branch; the marker delete must sit
    // in it, or a session could alert only once across its whole lifetime.
    const spellEnd = fnBody.indexOf('watchState.delete(session)')
    expect(spellEnd).toBeGreaterThanOrEqual(0)
    const after = fnBody.slice(spellEnd, spellEnd + 120)
    expect(after).toMatch(/alertedSpells\.delete\(session\)/)
  })

  it('recovery attempts are NOT busy-gated (only the escalation is)', () => {
    // recoverStuckInputForSession runs before any pane-state gate in the
    // body: the first gate mention must come after the recovery call.
    const recoverIdx = fnBody.indexOf('recoverStuckInputForSession(')
    const gateIdx = fnBody.indexOf('shouldAlertParkedGiveUp(')
    expect(recoverIdx).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeGreaterThan(recoverIdx)
  })
})
