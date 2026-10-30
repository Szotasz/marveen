import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideRoutineAlert, routineAlertSuffix, ROUTINE_ALERT_COOLDOWN_MS } from '../web/routine-alert.js'

const COOLDOWN = ROUTINE_ALERT_COOLDOWN_MS

// NOTIFY_ROUTINE_ALERTS is a BOOT-TIME const in src/config.ts, read once when
// the real module graph loads, so the test flips it through a GETTER: the mock
// factory itself is cached across vi.resetModules(), so a plain value captured
// there could never change after the first import (measured on vitest 4.1.11).
// The channel and the logger are mocked so a test can see which of the two a
// call actually produced.
const h = vi.hoisted(() => ({
  routineAlerts: true,
  notify: [] as { text: string, kind?: string }[],
  logLines: [] as { fields: unknown, msg: string }[],
}))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    get NOTIFY_ROUTINE_ALERTS() {
      return h.routineAlerts
    },
  }
})

vi.mock('../notify.js', () => ({
  notifyChannel: (text: string, opts?: { kind?: string }) => {
    h.notify.push({ text, kind: opts?.kind })
    return Promise.resolve()
  },
}))

vi.mock('../logger.js', async (orig) => {
  const actual = await orig<typeof import('../logger.js')>()
  return {
    ...actual,
    logger: {
      info: (fields: unknown, msg: string) => {
        h.logLines.push({ fields, msg })
      },
    },
  }
})

// A fresh module graph per test: the cooldown bookkeeping lives in a
// module-level Map, and one test's sent alert must not silence the next one.
async function loadRoutineAlert() {
  vi.resetModules()
  return import('../web/routine-alert.js')
}

describe('decideRoutineAlert', () => {
  it('sends the first occurrence with no repeat counter', () => {
    expect(decideRoutineAlert(undefined, 1_000, COOLDOWN)).toEqual({ send: true, repeats: 0 })
  })

  it('stays silent while inside the cooldown', () => {
    const prev = { lastSentAt: 1_000, suppressed: 0 }
    expect(decideRoutineAlert(prev, 1_000 + COOLDOWN - 1, COOLDOWN)).toEqual({ send: false })
  })

  it('speaks again once the cooldown elapsed, carrying the suppressed count', () => {
    const prev = { lastSentAt: 1_000, suppressed: 4 }
    expect(decideRoutineAlert(prev, 1_000 + COOLDOWN, COOLDOWN)).toEqual({ send: true, repeats: 4 })
  })

  it('a quiet cooldown produces a clean report, not a repeat warning', () => {
    const prev = { lastSentAt: 1_000, suppressed: 0 }
    expect(decideRoutineAlert(prev, 1_000 + COOLDOWN * 3, COOLDOWN)).toEqual({ send: true, repeats: 0 })
  })
})

describe('routineAlertSuffix', () => {
  it('adds nothing to a first report', () => {
    expect(routineAlertSuffix(0, COOLDOWN)).toBe('')
  })

  it('reports the total occurrences, not just the suppressed ones', () => {
    expect(routineAlertSuffix(4, COOLDOWN)).toContain('5 ilyen volt')
    expect(routineAlertSuffix(4, COOLDOWN)).toContain('30 perc')
  })
})

describe('sendRoutineAlert channel gate (NOTIFY_ROUTINE_ALERTS)', () => {
  beforeEach(() => {
    h.routineAlerts = true
    h.notify.length = 0
    h.logLines.length = 0
  })

  // The regression that matters most: an install that never touches the new key
  // must keep the exact behaviour it had before the gate existed.
  it('gate on (default): sends the first alert to the channel', async () => {
    const { sendRoutineAlert } = await loadRoutineAlert()

    expect(sendRoutineAlert('main-session-recreate', 'ujrainditom', { now: 1_000 })).toBe(true)
    expect(h.notify).toHaveLength(1)
    expect(h.notify[0].kind).toBe('main-session-recreate')
    expect(h.notify[0].text).toContain('ujrainditom')
  })

  it('gate off: keeps the alert log-only, sends nothing, returns false', async () => {
    h.routineAlerts = false
    const { sendRoutineAlert } = await loadRoutineAlert()

    expect(sendRoutineAlert('main-session-recreate', 'ujrainditom', { now: 1_000 })).toBe(false)
    expect(h.notify).toHaveLength(0)
    expect(h.logLines).toHaveLength(1)
    expect(h.logLines[0].fields).toEqual({ key: 'main-session-recreate' })
    expect(h.logLines[0].msg).toContain('NOTIFY_ROUTINE_ALERTS=off')
  })

  it('gate off: a repeat inside the cooldown is suppressed, still without a message', async () => {
    h.routineAlerts = false
    const { sendRoutineAlert } = await loadRoutineAlert()

    // The gate is checked AFTER the cooldown bookkeeping, so the state has to
    // advance even with the switch off: that is what makes the second call a
    // suppressed repeat instead of a second "first" alert.
    sendRoutineAlert('k', 'text', { now: 1_000 })
    expect(sendRoutineAlert('k', 'text', { now: 1_000 + COOLDOWN - 1 })).toBe(false)
    expect(h.notify).toHaveLength(0)
    expect(h.logLines.some((line) => line.msg.includes('inside cooldown'))).toBe(true)
  })

  it('gate on: a repeat inside the cooldown is suppressed exactly as before', async () => {
    const { sendRoutineAlert } = await loadRoutineAlert()

    expect(sendRoutineAlert('k', 'text', { now: 1_000 })).toBe(true)
    expect(sendRoutineAlert('k', 'text', { now: 1_000 + COOLDOWN - 1 })).toBe(false)
    expect(h.notify).toHaveLength(1)
    expect(h.logLines.some((line) => line.msg.includes('inside cooldown'))).toBe(true)
  })

  it('gate on: speaks again after the cooldown, carrying the suppressed count', async () => {
    const { sendRoutineAlert } = await loadRoutineAlert()

    sendRoutineAlert('k', 'text', { now: 1_000 })
    sendRoutineAlert('k', 'text', { now: 1_000 + 10 })
    expect(sendRoutineAlert('k', 'text', { now: 1_000 + COOLDOWN })).toBe(true)
    expect(h.notify).toHaveLength(2)
    expect(h.notify[1].text).toContain('2 ilyen volt')
  })
})

describe('NOTIFY_ROUTINE_ALERTS registry entry', () => {
  it('ships enabled by default and needs a dashboard restart', async () => {
    const { SETTINGS_REGISTRY } = await import('../config-registry.js')
    const entry = SETTINGS_REGISTRY.find((item) => item.key === 'NOTIFY_ROUTINE_ALERTS')

    expect(entry).toBeDefined()
    expect(entry?.type).toBe('boolean')
    expect(entry?.default).toBe('1')
    expect(entry?.requiresRestart).toBe(true)
    expect(entry?.module).toBe('channels')
  })
})
