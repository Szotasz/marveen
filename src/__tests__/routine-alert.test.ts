import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decideRoutineAlert, routineAlertSuffix, ROUTINE_ALERT_COOLDOWN_MS } from '../web/routine-alert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

describe('sendOwnerActionAlert (Szotasz/marveen#2353 review): never gated by NOTIFY_ROUTINE_ALERTS', () => {
  beforeEach(() => {
    h.routineAlerts = true
    h.notify.length = 0
    h.logLines.length = 0
  })

  it('gate on: sends the first alert to the channel', async () => {
    const { sendOwnerActionAlert } = await loadRoutineAlert()

    expect(sendOwnerActionAlert('agent-wait:agent-a', 'varakozik', { now: 1_000 })).toBe(true)
    expect(h.notify).toHaveLength(1)
    expect(h.notify[0].kind).toBe('agent-wait:agent-a')
    expect(h.notify[0].text).toContain('varakozik')
  })

  // The actual review gap: NOTIFY_ROUTINE_ALERTS=off must not reach this
  // function at all -- unlike sendRoutineAlert, there is no gate to even check.
  it('gate off: still sends to the channel (this is what sendRoutineAlert must NOT do here)', async () => {
    h.routineAlerts = false
    const { sendOwnerActionAlert } = await loadRoutineAlert()

    expect(sendOwnerActionAlert('agent-wait:agent-a', 'varakozik', { now: 1_000 })).toBe(true)
    expect(h.notify).toHaveLength(1)
    expect(h.notify[0].text).toContain('varakozik')
    expect(h.logLines.some((line) => line.msg.includes('NOTIFY_ROUTINE_ALERTS'))).toBe(false)
  })

  it('a repeat inside the cooldown is still suppressed, gate state notwithstanding', async () => {
    h.routineAlerts = false
    const { sendOwnerActionAlert } = await loadRoutineAlert()

    sendOwnerActionAlert('k', 'text', { now: 1_000 })
    expect(sendOwnerActionAlert('k', 'text', { now: 1_000 + COOLDOWN - 1 })).toBe(false)
    expect(h.notify).toHaveLength(1)
    expect(h.logLines.some((line) => line.msg.includes('inside cooldown'))).toBe(true)
  })

  it('speaks again after the cooldown, carrying the suppressed count', async () => {
    const { sendOwnerActionAlert } = await loadRoutineAlert()

    sendOwnerActionAlert('k', 'text', { now: 1_000 })
    sendOwnerActionAlert('k', 'text', { now: 1_000 + 10 })
    expect(sendOwnerActionAlert('k', 'text', { now: 1_000 + COOLDOWN })).toBe(true)
    expect(h.notify).toHaveLength(2)
    expect(h.notify[1].text).toContain('2 ilyen volt')
  })

  it("a sendRoutineAlert key and a sendOwnerActionAlert key never share cooldown state, even when equal", async () => {
    const { sendRoutineAlert, sendOwnerActionAlert } = await loadRoutineAlert()

    expect(sendRoutineAlert('shared-key', 'routine text', { now: 1_000 })).toBe(true)
    // If the two functions shared one Map, this would be suppressed as a repeat.
    expect(sendOwnerActionAlert('shared-key', 'owner text', { now: 1_000 + 1 })).toBe(true)
    expect(h.notify).toHaveLength(2)
  })
})

// Szotasz's review on Szotasz/marveen#2353: NOTIFY_ROUTINE_ALERTS=off silenced
// four/five calls that actually ask for the OWNER's action (a permission
// prompt, a stuck supervisor nobody can safely double-start, a restart that
// did not take, a dead channel intake) rather than reporting a recovery the
// fleet already performed. This pins which function each call site must use,
// straight from the source text, so a future edit that quietly reverts one of
// these back onto the gated path fails a test instead of silently resurfacing
// the exact gap under review.
describe('owner-action call sites stay off the NOTIFY_ROUTINE_ALERTS gate (pin)', () => {
  function read(relPath: string): string {
    return readFileSync(join(__dirname, relPath), 'utf-8')
  }

  const channelMonitor = read('../web/channel-monitor.ts')
  const stuckToolCallWatcher = read('../web/stuck-tool-call-watcher.ts')
  const channelIntakeMonitor = read('../web/channel-intake-monitor.ts')

  it.each([
    ['main-session-supervisor-stuck', channelMonitor, "sendOwnerActionAlert('main-session-supervisor-stuck'"],
    ['main-hard-restart-no-claude', channelMonitor, "sendOwnerActionAlert('main-hard-restart-no-claude'"],
    ['agent-wait:<agent> (sub-agent sweep)', stuckToolCallWatcher, 'sendOwnerActionAlert(`agent-wait:${agent}`'],
    ['agent-wait:<main> (held peer message)', stuckToolCallWatcher, 'sendOwnerActionAlert(`agent-wait:${MAIN_AGENT_ID}`'],
    ['channel-intake:<agent>:<verdict>', channelIntakeMonitor, 'sendOwnerActionAlert('],
  ])('%s calls sendOwnerActionAlert, not sendRoutineAlert', (_label, source, needle) => {
    expect(source).toContain(needle)
  })

  // The companion half of the same pin: recoveries that DID fix something
  // themselves must stay on the gated path, so the fix above does not widen
  // into "nothing is gated any more".
  it.each([
    ['main-session-recreate', channelMonitor, "sendRoutineAlert('main-session-recreate'"],
    ['post-resume-fresh-respawn', channelMonitor, "sendRoutineAlert('post-resume-fresh-respawn'"],
    ['keepalive-respawn', channelMonitor, "sendRoutineAlert('keepalive-respawn'"],
    ['firstrun-gate:<label>', channelMonitor, 'sendRoutineAlert(`firstrun-gate:${label}`'],
    ['model-consent:<label>', channelMonitor, 'sendRoutineAlert(`model-consent:${label}`'],
    ['menu-escape:<label>', channelMonitor, 'sendRoutineAlert(`menu-escape:${label}`'],
    ['main-stuck-tool-call:<session>', stuckToolCallWatcher, 'sendRoutineAlert('],
  ])('%s (self-heal) stays on sendRoutineAlert', (_label, source, needle) => {
    expect(source).toContain(needle)
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
