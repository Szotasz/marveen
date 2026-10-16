import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  recordRescueFailure,
  clearRescueFailures,
  rescueFailureCount,
  __resetRescueFailures,
  RESCUE_ALERT_AFTER,
  RESCUE_REALERT_MS,
} from '../web/rescue-failure-tracker.js'

const RUNNER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'context-guard-runner.ts'),
  'utf8',
)

// RESCUEALERT901. After RESTARTRACE901 a failed rescue is honest -- result
// checked, state rolled back, logger.error written -- and completely silent. A
// saturated pane cannot be prompted (dispatch refuses it), so an agent whose
// rescue keeps failing is unreachable while the only thing that knows is a log
// line. Same shape the fleet hit three times on 2026-09-01: a control that
// works correctly and is never heard.
describe('rescue-failure tracker: three strikes, then hourly', () => {
  beforeEach(() => __resetRescueFailures())

  it('stays quiet for the first two failures and alerts on the third', () => {
    const t = 1_000_000
    expect(recordRescueFailure('levente', t)).toEqual({ count: 1, alert: false })
    expect(recordRescueFailure('levente', t + 600_000)).toEqual({ count: 2, alert: false })
    expect(recordRescueFailure('levente', t + 1_200_000)).toEqual({ count: 3, alert: true })
    expect(rescueFailureCount('levente')).toBe(3)
    expect(RESCUE_ALERT_AFTER).toBe(3)
  })

  it('a successful rescue clears the streak', () => {
    const t = 1_000_000
    recordRescueFailure('levente', t)
    recordRescueFailure('levente', t + 1)
    clearRescueFailures('levente')
    expect(rescueFailureCount('levente')).toBe(0)
    // ...and the count starts over, so two old failures plus one new one is
    // not "three consecutive".
    expect(recordRescueFailure('levente', t + 2)).toEqual({ count: 1, alert: false })
  })

  it('does NOT re-alert on every subsequent failure', () => {
    // The guard retries about every ten minutes; alerting on each one would
    // turn an outage into noise and the next real alert into wallpaper.
    const t = 1_000_000
    recordRescueFailure('levente', t)
    recordRescueFailure('levente', t)
    expect(recordRescueFailure('levente', t).alert).toBe(true)
    expect(recordRescueFailure('levente', t + 600_000).alert).toBe(false)
    expect(recordRescueFailure('levente', t + 1_200_000).alert).toBe(false)
  })

  it('DOES re-alert once an hour while it persists', () => {
    // A silent outage is the failure mode; a single alert an hour ago is not a
    // running signal.
    const t = 1_000_000
    recordRescueFailure('levente', t)
    recordRescueFailure('levente', t)
    expect(recordRescueFailure('levente', t).alert).toBe(true)
    expect(recordRescueFailure('levente', t + RESCUE_REALERT_MS - 1).alert).toBe(false)
    expect(recordRescueFailure('levente', t + RESCUE_REALERT_MS).alert).toBe(true)
    // ...and the hour restarts from the alert that was actually sent.
    expect(recordRescueFailure('levente', t + RESCUE_REALERT_MS + 1).alert).toBe(false)
  })

  it('counts per agent, so one broken agent does not mask another', () => {
    const t = 1_000_000
    recordRescueFailure('levente', t)
    recordRescueFailure('levente', t)
    expect(recordRescueFailure('hotblack', t).alert).toBe(false)
    expect(rescueFailureCount('hotblack')).toBe(1)
    expect(recordRescueFailure('levente', t).alert).toBe(true)
  })
})

describe('the guard raises the alert (pinned at the source)', () => {
  // checkAgent is a closure over tmux/transcript IO, so the wiring is pinned by
  // source, the same way the FRESH-restart guarantee has been since 2026-08-04.
  const i = RUNNER.indexOf('await performRestart(name)')
  // 4200, not 3000: the fleet's main-agent sink branch (operator notify for
  // MAIN_AGENT_ID) sits between the failure log and the queue send, and the
  // window must still reach the send-verify + catch below it.
  const region = RUNNER.slice(i, i + 4200)

  it('clears the streak only on a rescue that actually ran', () => {
    const success = RUNNER.slice(i, RUNNER.indexOf('} catch (err) {', i))
    expect(success).toContain('clearRescueFailures(name)')
  })

  it('records the failure and alerts only when the tracker says so', () => {
    expect(region).toContain('recordRescueFailure(name, nowMs)')
    expect(region).toMatch(/if \(shouldAlert\)/)
    // The message must not be sent unconditionally: that is the noise path.
    expect(region.indexOf('recordRescueFailure(name, nowMs)'))
      .toBeLessThan(region.indexOf('createAgentMessage('))
  })

  it('sends to the main agent, and says the agent is unreachable meanwhile', () => {
    expect(region).toContain('MAIN_AGENT_ID')
    expect(region).toMatch(/EGYMAST KOVETO bukott mentes/)
    // An alert that only says "it failed" leaves the reader to guess whether
    // anything is waiting on them.
    expect(region).toMatch(/elerhetetlen/)
    expect(region).toMatch(/ujraprobalja/)
  })

  it('verifies the send and never loses the alert silently', () => {
    // Fleet rule: a message counts as sent only when an id came back. The alert
    // is the last channel out of a silent failure -- dropping it without a
    // trace would restore the very silence it exists for.
    expect(region).toMatch(/if \(!msg\?\.id\) throw/)
    expect(region).toMatch(/FAILED TO RAISE the rescue-failure alert/)
  })

  it('still rolls the state back before it alerts', () => {
    // The retry is the actual rescue; the alert is the notification. Losing the
    // rollback to an alerting bug would be the worse trade.
    expect(region.indexOf('guardStates.set(name, INITIAL_GUARD_STATE)'))
      .toBeLessThan(region.indexOf('recordRescueFailure(name, nowMs)'))
  })
})

// Fleet addition: the alert sink must never be the patient's own inbox. For
// the MAIN agent a queue message is addressed to the very agent whose rescue
// keeps failing (pull-model delivery: a saturated main does not pull), so the
// runner must branch main to the operator notification channel. Source pin
// with a FIXED window.
import { readFileSync as readRunnerSrc } from 'node:fs'
import { join as joinRunnerPath } from 'node:path'

describe('main-agent rescue alert goes to the operator, not its own queue', () => {
  const src = readRunnerSrc(joinRunnerPath(__dirname, '../web/context-guard-runner.ts'), 'utf-8')
  const lines = src.split('\n')
  const sendIdx = lines.findIndex(l => l.includes('const msg = createAgentMessage('))

  it('branches MAIN_AGENT_ID to notifyChannel before the queue send', () => {
    expect(sendIdx, 'the queue send for sub-agent alerts disappeared').toBeGreaterThan(0)
    const before = lines.slice(Math.max(0, sendIdx - 20), sendIdx).join('\n')
    expect(before, 'the main-agent alert no longer branches to the operator channel')
      .toMatch(/if \(name === MAIN_AGENT_ID\) \{[\s\S]{0,400}notifyChannel\(/)
  })
})
