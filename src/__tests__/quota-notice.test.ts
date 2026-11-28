import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readQuotaNoticeConfig, readUsageCollectSnapshot, fresherSnapshot, decideThresholdNotices, formatThresholdNotice,
  runQuotaNoticeTick, planStateSnapshot, loadQuotaNoticeState, saveQuotaNoticeState, DEFAULT_PLAN_ID,
  parseLimitMonitorStamp, readLimitMonitorSignal, limitMonitorActive, limitMonitorCovered, decideDefaultPlanNotice,
  deliverOwnerAlertOutbox, outboxText, OUTBOX_MAX_CHARS, OUTBOX_ENABLED_MARKER, syncOutboxMarker, runQuotaNoticeCycle, LIMIT_MONITOR_GRACE_SEC, LIMIT_MONITOR_ACTIVE_MAX_AGE_SEC,
  type PlanQuota, type LimitMonitorSignal,
  type QuotaNoticeDeps, type QuotaNoticeState,
} from '../web/quota-notice.js'
import type { QuotaSnapshot } from '../web/quota.js'
import type { QuotaPlanProbeDeps } from '../web/quota-plan-probe.js'

const NOW = 1_795_700_000 // unix seconds
const snap = (five: number, seven: number, fiveReset = NOW + 3600, sevenReset = NOW + 86400 * 3): QuotaSnapshot => ({
  status: 'ok', ageSec: 60, maxAgeSec: 2700,
  fiveHour: { usedPercentage: five, resetsAt: fiveReset, expired: false },
  sevenDay: { usedPercentage: seven, resetsAt: sevenReset, expired: false },
})

describe('config', () => {
  it('defaults: off, 90', () => {
    expect(readQuotaNoticeConfig(() => undefined, {})).toEqual({ noticeEnabled: false, noticePct: 90, dryRun: false })
  })
  it('reads the settings values, rejects nonsense percentages; dry-run is environment only', () => {
    const v: Record<string, string | number> = { QUOTA_NOTICE: '1', QUOTA_NOTICE_PCT: 80 }
    expect(readQuotaNoticeConfig((k) => v[k], { QUOTA_NOTICE_DRY_RUN: '1' })).toEqual({ noticeEnabled: true, noticePct: 80, dryRun: true })
    expect(readQuotaNoticeConfig((k) => ({ QUOTA_NOTICE: '1', QUOTA_NOTICE_PCT: 150 } as Record<string, string | number>)[k], {}).noticePct).toBe(90)
  })
})

describe('usage-collect snapshot', () => {
  it('maps claude.windows and measures freshness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qn-'))
    const f = join(dir, 'usage-latest.json')
    writeFileSync(f, JSON.stringify({ claude: { ok: true, measured_at: new Date((NOW - 100) * 1000).toISOString(), windows: { five_hour: { used_percent: 91, resets_at: NOW + 60 }, seven_day: { used_percent: 40, resets_at: NOW + 999 } } } }))
    const s = readUsageCollectSnapshot(f, NOW)
    expect(s.status).toBe('ok')
    expect(s.fiveHour?.usedPercentage).toBe(91)
    expect(readUsageCollectSnapshot(f, NOW + 10_000).status).toBe('stale')
    expect(readUsageCollectSnapshot(join(dir, 'nope.json'), NOW).status).toBe('missing')
  })
  it('a fresh reading beats a stale one', () => {
    const stale = { ...snap(10, 10), status: 'stale' as const }
    expect(fresherSnapshot(stale, snap(50, 50)).fiveHour?.usedPercentage).toBe(50)
  })
})

describe('threshold notice', () => {
  it('fires once per window and re-arms on the next window', () => {
    const first = decideThresholdNotices(snap(91, 30), {}, 90)
    expect(first.notices.map((n) => n.kind)).toEqual(['five_hour'])
    const again = decideThresholdNotices(snap(97, 30), first.next, 90)
    expect(again.notices).toEqual([])
    const nextWindow = decideThresholdNotices(snap(92, 30, NOW + 20000), first.next, 90)
    expect(nextWindow.notices.map((n) => n.kind)).toEqual(['five_hour'])
  })
  it('a reset instant that moved by a few minutes is the same window (no second notice)', () => {
    const first = decideThresholdNotices(snap(91, 30), {}, 90)
    expect(decideThresholdNotices(snap(93, 30, NOW + 3600 + 120), first.next, 90).notices).toEqual([])
  })
  it('raising the threshold within a window re-arms the notice, lowering it does not', () => {
    const atFifty = decideThresholdNotices(snap(10, 51), {}, 50)
    expect(atFifty.notices.map((n) => n.kind)).toEqual(['seven_day'])
    // Back to 90: the same window reaching 90 % must be announced again.
    expect(decideThresholdNotices(snap(10, 85), atFifty.next, 90, atFifty.nextPct).notices).toEqual([])
    const atNinety = decideThresholdNotices(snap(10, 91), atFifty.next, 90, atFifty.nextPct)
    expect(atNinety.notices.map((n) => n.kind)).toEqual(['seven_day'])
    expect(atNinety.nextPct.seven_day).toBe(90)
    // Lowering to 80 after the 90 notice: already announced, no second message.
    expect(decideThresholdNotices(snap(10, 92), atNinety.next, 80, atNinety.nextPct).notices).toEqual([])
    // An older state without thresholds counts as announced at any threshold.
    expect(decideThresholdNotices(snap(10, 91), atFifty.next, 90).notices).toEqual([])
  })
  it('both windows, highest first; nothing under the threshold or on a stale reading', () => {
    expect(decideThresholdNotices(snap(93, 95), {}, 90).notices.map((n) => n.kind)).toEqual(['seven_day', 'five_hour'])
    expect(decideThresholdNotices(snap(89, 10), {}, 90).notices).toEqual([])
    expect(decideThresholdNotices({ ...snap(99, 99), status: 'stale' }, {}, 90).notices).toEqual([])
  })
  it('Hungarian text: names the subscription, accents, percentage, no em dash', () => {
    const t = formatThresholdNotice({ kind: 'five_hour', pct: 90.4, resetsAt: NOW + 3600, planLabel: 'Céges' }, 'hu', NOW)
    expect(t).toContain('„Céges” előfizetés')
    expect(t).toContain('90%')
    expect(t).toContain('5 órás')
    expect(t).not.toMatch(/—|–/)
  })
})

const NO_LM: LimitMonitorSignal = { lastRunSec: null, stamp: [] }

function deps(over: Partial<QuotaNoticeDeps> & { planList?: PlanQuota[]; state?: QuotaNoticeState; q?: QuotaSnapshot; lm?: LimitMonitorSignal; at?: number }) {
  let state: QuotaNoticeState = over.state ?? { notified: {} }
  const sent: string[] = []
  const d: QuotaNoticeDeps = {
    now: () => (over.at ?? NOW) * 1000,
    config: { noticeEnabled: true, noticePct: 90, dryRun: false },
    lang: () => 'hu',
    plans: () => over.planList ?? [{ planId: DEFAULT_PLAN_ID, label: 'alap (flotta)', snap: over.q ?? snap(10, 10) }],
    limitMonitor: () => over.lm ?? NO_LM,
    notifyOwner: vi.fn(async (t: string) => { sent.push(t); return true }),
    loadState: () => JSON.parse(JSON.stringify(state)),
    saveState: (s) => { state = s },
    ...over,
  }
  return { d, sent, getState: () => state }
}

describe('tick', () => {
  it('notifies the owner once, and not again on the next tick', async () => {
    const { d, getState } = deps({ q: snap(92, 10) })
    await runQuotaNoticeTick(d)
    await runQuotaNoticeTick({ ...d, loadState: () => getState() })
    expect(d.notifyOwner).toHaveBeenCalledTimes(1)
  })
  it('a lost owner notice is retried', async () => {
    const { d } = deps({ q: snap(92, 10), notifyOwner: vi.fn(async () => false) })
    await runQuotaNoticeTick(d)
    await runQuotaNoticeTick(d)
    expect(d.notifyOwner).toHaveBeenCalledTimes(2)
  })
  it('dry-run sends nothing', async () => {
    const { d } = deps({ q: snap(99, 10) })
    await runQuotaNoticeTick({ ...d, config: { ...d.config, dryRun: true } })
    expect(d.notifyOwner).not.toHaveBeenCalled()
  })
  it('switched off: nothing is read or sent', async () => {
    const plans = vi.fn(() => [{ planId: DEFAULT_PLAN_ID, label: 'x', snap: snap(99, 99) }])
    const { d } = deps({ plans })
    await runQuotaNoticeTick({ ...d, config: { ...d.config, noticeEnabled: false } })
    expect(plans).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
  })
})

describe('multi-plan', () => {
  const two = (a: QuotaSnapshot, b: QuotaSnapshot): PlanQuota[] => [
    { planId: DEFAULT_PLAN_ID, label: 'alap (flotta)', snap: a },
    { planId: 'ceges', label: 'Céges', snap: b },
  ]

  it('one notice per plan per window, each naming its plan', async () => {
    const h = deps({ planList: two(snap(92, 10), snap(91, 10, NOW + 7000)) })
    await runQuotaNoticeTick(h.d)
    await runQuotaNoticeTick({ ...h.d, loadState: () => h.getState() })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]).toContain('„alap (flotta)” előfizetés')
    expect(h.sent[1]).toContain('„Céges” előfizetés')
    expect(Object.keys(h.getState().notified).sort()).toEqual(['ceges', DEFAULT_PLAN_ID])
  })

  it('reads a claude-plans-state observation (ms observedAt, usedPercent/resetsAt) with freshness', () => {
    const obs = { observedAt: (NOW - 60) * 1000, windows: { five_hour: { usedPercent: 93, resetsAt: NOW + 100 }, seven_day: { usedPercent: 50, resetsAt: NOW + 9999 } } }
    expect(planStateSnapshot(obs, NOW)).toMatchObject({ status: 'ok', fiveHour: { usedPercentage: 93 } })
    expect(planStateSnapshot(obs, NOW + 5000).status).toBe('stale')
    expect(planStateSnapshot(undefined, NOW).status).toBe('missing')
  })
})

describe('state file', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'qn-state-')), 's.json')
  it('a state file from the single-plan shape is read as the default plan', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ notified: { five_hour: 123, ceges: { seven_day: 5 } } }))
    expect(loadQuotaNoticeState(f).notified).toEqual({ [DEFAULT_PLAN_ID]: { five_hour: 123 }, ceges: { seven_day: 5 } })
  })
  it('the announced threshold survives a save and load', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ notified: { default: { seven_day: 5 } }, notifiedPct: { default: { seven_day: 50 } } }))
    expect(loadQuotaNoticeState(f).notifiedPct).toEqual({ default: { seven_day: 50 } })
  })
  it('an older file with the removed autoReplies list loads, and the list is dropped on save', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ notified: { default: { five_hour: 7 } }, autoReplies: [{ agent: 'alex', chatId: 'B' }] }))
    const st = loadQuotaNoticeState(f)
    expect(st.notified).toEqual({ default: { five_hour: 7 } })
    expect(st).not.toHaveProperty('autoReplies')
    saveQuotaNoticeState(st, f)
    expect(JSON.parse(readFileSync(f, 'utf-8'))).not.toHaveProperty('autoReplies')
  })
  it('a hold for limit-monitor survives a save and load; a malformed one is ignored', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ notified: {}, heldForLimitMonitor: { five_hour: { resetsAt: 5, since: 3 }, seven_day: { resetsAt: 'x' }, bogus: { resetsAt: 1, since: 1 } } }))
    expect(loadQuotaNoticeState(f).heldForLimitMonitor).toEqual({ five_hour: { resetsAt: 5, since: 3 } })
  })
})

describe('limit-monitor dedupe: deciders', () => {
  const R5 = NOW + 3600
  it('parses the quota-check.py HIT key, skipping malformed parts', () => {
    expect(parseLimitMonitorStamp(`five_hour:90:${R5}|seven_day:100:${NOW + 999}|junk|five_hour:x:1\n`)).toEqual([
      { kind: 'five_hour', level: 90, resetsAt: R5 }, { kind: 'seven_day', level: 100, resetsAt: NOW + 999 },
    ])
    expect(parseLimitMonitorStamp('')).toEqual([])
  })
  it('covered: same kind, reset within tolerance, level at or above our threshold', () => {
    const st = parseLimitMonitorStamp(`five_hour:90:${R5}`)
    expect(limitMonitorCovered(st, 'five_hour', R5 + 120, 90)).toBe(true)
    expect(limitMonitorCovered(st, 'five_hour', R5 + 120, 80)).toBe(true)
    expect(limitMonitorCovered(st, 'five_hour', R5, 95)).toBe(false) // it alerted at 90, we were raised to 95
    expect(limitMonitorCovered(st, 'seven_day', R5, 90)).toBe(false)
    expect(limitMonitorCovered(st, 'five_hour', R5 + 18000, 90)).toBe(false) // the next window
    expect(limitMonitorCovered(st, 'five_hour', null, 90)).toBe(false)
  })
  it('active: a run within the freshness window', () => {
    expect(limitMonitorActive({ lastRunSec: NOW - 60, stamp: [] }, NOW)).toBe(true)
    expect(limitMonitorActive({ lastRunSec: NOW - LIMIT_MONITOR_ACTIVE_MAX_AGE_SEC - 1, stamp: [] }, NOW)).toBe(false)
    expect(limitMonitorActive(NO_LM, NOW)).toBe(false)
  })
  it('decision: covered beats everything; active holds for the grace; stale or missing sends', () => {
    const n = { kind: 'five_hour' as const, resetsAt: R5 }
    const fresh = { lastRunSec: NOW - 60, stamp: [] }
    expect(decideDefaultPlanNotice({ ...fresh, stamp: parseLimitMonitorStamp(`five_hour:90:${R5}`) }, NOW, n, 90, undefined)).toBe('covered')
    expect(decideDefaultPlanNotice({ lastRunSec: null, stamp: parseLimitMonitorStamp(`five_hour:90:${R5}`) }, NOW, n, 90, undefined)).toBe('covered')
    expect(decideDefaultPlanNotice(fresh, NOW, n, 90, undefined)).toBe('hold')
    expect(decideDefaultPlanNotice(fresh, NOW, n, 90, NOW - LIMIT_MONITOR_GRACE_SEC + 1)).toBe('hold')
    expect(decideDefaultPlanNotice(fresh, NOW, n, 90, NOW - LIMIT_MONITOR_GRACE_SEC)).toBe('send')
    expect(decideDefaultPlanNotice({ lastRunSec: NOW - 7200, stamp: [] }, NOW, n, 90, undefined)).toBe('send')
    expect(decideDefaultPlanNotice(NO_LM, NOW, n, 90, undefined)).toBe('send')
  })
  it('reads the heartbeat epoch, the log mtime (newer wins) and the stamp from the store dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qn-lm-'))
    expect(readLimitMonitorSignal(dir)).toEqual(NO_LM)
    writeFileSync(join(dir, '.limit-monitor-heartbeat'), `ok ${NOW - 600}\n`)
    expect(readLimitMonitorSignal(dir).lastRunSec).toBe(NOW - 600)
    writeFileSync(join(dir, 'limit-monitor.log'), 'x\n')
    utimesSync(join(dir, 'limit-monitor.log'), NOW - 100, NOW - 100)
    expect(readLimitMonitorSignal(dir).lastRunSec).toBe(NOW - 100)
    writeFileSync(join(dir, '.limit-monitor-quota-state'), `seven_day:90:${NOW + 5}`)
    expect(readLimitMonitorSignal(dir).stamp).toEqual([{ kind: 'seven_day', level: 90, resetsAt: NOW + 5 }])
  })
})

describe('limit-monitor dedupe: tick', () => {
  const plans = (): PlanQuota[] => [
    { planId: DEFAULT_PLAN_ID, label: 'alap (flotta)', snap: snap(92, 10) },
    { planId: 'ceges', label: 'Céges', snap: snap(93, 10, NOW + 7000) },
  ]
  const fresh: LimitMonitorSignal = { lastRunSec: NOW - 60, stamp: [] }

  it('fresh heartbeat: the default plan is held, the named plan is still notified', async () => {
    const h = deps({ planList: plans(), lm: fresh })
    await runQuotaNoticeTick(h.d)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('„Céges”')
    expect(h.getState().heldForLimitMonitor?.five_hour).toEqual({ resetsAt: NOW + 3600, since: NOW })
    expect(h.getState().notified[DEFAULT_PLAN_ID]).toBeUndefined()
  })

  it('limit-monitor stamps during the hold: the default plan is skipped and recorded, never sent', async () => {
    const h = deps({ planList: plans(), lm: fresh })
    await runQuotaNoticeTick(h.d)
    const later = deps({ planList: plans(), state: h.getState(), at: NOW + 300, lm: { lastRunSec: NOW + 200, stamp: parseLimitMonitorStamp(`five_hour:90:${NOW + 3600}`) } })
    await runQuotaNoticeTick(later.d)
    expect(later.sent).toEqual([])
    expect(later.getState().notified[DEFAULT_PLAN_ID]?.five_hour).toBe(NOW + 3600)
    expect(later.getState().heldForLimitMonitor?.five_hour).toBeUndefined()
    // And it stays quiet afterwards, even past the grace.
    const after = deps({ planList: plans(), state: later.getState(), at: NOW + 3000, lm: fresh })
    await runQuotaNoticeTick(after.d)
    expect(after.sent).toEqual([])
  })

  it('no stamp by the end of the hold: ours is sent once', async () => {
    const h = deps({ planList: plans(), lm: fresh })
    await runQuotaNoticeTick(h.d)
    const mid = deps({ planList: plans(), state: h.getState(), at: NOW + LIMIT_MONITOR_GRACE_SEC - 60, lm: { ...fresh, lastRunSec: NOW + 600 } })
    await runQuotaNoticeTick(mid.d)
    expect(mid.sent).toEqual([])
    const end = deps({ planList: plans(), state: mid.getState(), at: NOW + LIMIT_MONITOR_GRACE_SEC, lm: { ...fresh, lastRunSec: NOW + 800 } })
    await runQuotaNoticeTick(end.d)
    expect(end.sent).toHaveLength(1)
    expect(end.sent[0]).toContain('„alap (flotta)”')
    expect(end.getState().heldForLimitMonitor?.five_hour).toBeUndefined()
  })

  it('stale or missing heartbeat: the default plan is notified at once', async () => {
    for (const lm of [NO_LM, { lastRunSec: NOW - 7200, stamp: [] }]) {
      const h = deps({ planList: plans(), lm })
      await runQuotaNoticeTick(h.d)
      expect(h.sent.map((t) => t.includes('alap'))).toEqual([true, false])
    }
  })

  it('a stamp for this window skips the default plan even when limit-monitor is no longer active', async () => {
    const h = deps({ planList: plans(), lm: { lastRunSec: null, stamp: parseLimitMonitorStamp(`five_hour:100:${NOW + 3600}`) } })
    await runQuotaNoticeTick(h.d)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('„Céges”')
  })

  it('a stamp for a named plan window is never consulted (only the default plan is limit-monitor\'s)', async () => {
    const lm = vi.fn(() => ({ lastRunSec: NOW, stamp: parseLimitMonitorStamp(`five_hour:90:${NOW + 7000}`) }))
    const h = deps({ planList: [{ planId: 'ceges', label: 'Céges', snap: snap(93, 10, NOW + 7000) }], limitMonitor: lm })
    await runQuotaNoticeTick(h.d)
    expect(h.sent).toHaveLength(1)
    expect(lm).not.toHaveBeenCalled()
  })
})

describe('owner-alert outbox', () => {
  const box = () => mkdtempSync(join(tmpdir(), 'qn-outbox-'))
  it('delivers a file and deletes it; a dot-file (write in progress) is left alone', async () => {
    const dir = box()
    writeFileSync(join(dir, `${NOW - 10}-1-quota_five_hour.txt`), 'CLAUDE KERET\n5 oras keret: 94%')
    writeFileSync(join(dir, '.tmp.123'), 'half')
    const sent: string[] = []
    const r = await deliverOwnerAlertOutbox(dir, NOW, async (t) => { sent.push(t); return true })
    expect(r).toEqual({ delivered: 1, kept: 0, dropped: 0 })
    expect(sent).toEqual(['CLAUDE KERET\n5 oras keret: 94%'])
    expect(readdirSync(dir)).toEqual(['.tmp.123'])
  })
  it('a failed delivery keeps the file for the next tick', async () => {
    const dir = box()
    const f = join(dir, `${NOW - 10}-1-x.txt`)
    writeFileSync(f, 'alert')
    expect(await deliverOwnerAlertOutbox(dir, NOW, async () => false)).toEqual({ delivered: 0, kept: 1, dropped: 0 })
    expect(existsSync(f)).toBe(true)
    expect(await deliverOwnerAlertOutbox(dir, NOW, async () => { throw new Error('boom') })).toEqual({ delivered: 0, kept: 1, dropped: 0 })
    expect(existsSync(f)).toBe(true)
  })
  it('a file older than 24 hours is dropped undelivered', async () => {
    const dir = box()
    const f = join(dir, `${NOW - 86400 - 1}-1-old.txt`)
    writeFileSync(f, 'old alert')
    const send = vi.fn(async () => true)
    expect(await deliverOwnerAlertOutbox(dir, NOW, send)).toEqual({ delivered: 0, kept: 0, dropped: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(existsSync(f)).toBe(false)
  })
  it('an oversize file is capped, control characters removed', async () => {
    const dir = box()
    writeFileSync(join(dir, `${NOW}-1-big.txt`), `a\u0007b\u001b[31m\n${'x'.repeat(10_000)}`)
    const sent: string[] = []
    await deliverOwnerAlertOutbox(dir, NOW, async (t) => { sent.push(t); return true })
    expect(sent[0].length).toBe(OUTBOX_MAX_CHARS)
    expect(sent[0].startsWith('ab[31m\n')).toBe(true)
    expect(sent[0].endsWith('…')).toBe(true)
    expect(outboxText('short')).toBe('short')
  })
  it('a missing outbox dir is a no-op', async () => {
    expect(await deliverOwnerAlertOutbox(join(box(), 'nope'), NOW, async () => true)).toEqual({ delivered: 0, kept: 0, dropped: 0 })
  })
})

describe('cycle: QUOTA_NOTICE gates the outbox and the per-plan probe', () => {
  const box = () => mkdtempSync(join(tmpdir(), 'qn-cycle-'))
  // A due named token plan with an active agent: with the probe round allowed to run, it WOULD be called.
  const probeDeps = (probeAndRecord: QuotaPlanProbeDeps['probeAndRecord']) => async (enabled: () => boolean): Promise<QuotaPlanProbeDeps> => ({
    enabled, intervalMs: () => 15 * 60_000, now: () => NOW * 1000,
    plans: () => [{ id: 'p2', label: 'p2', planType: 'personal', channelsAllowed: true, tokenSecretId: 'claude-plan-token-p2' }],
    readState: () => ({ activePlanByAgent: {}, plans: {} }),
    lastActiveMs: () => NOW * 1000,
    probeAndRecord,
  })
  const setup = (enabled: boolean) => {
    const dir = box()
    writeFileSync(join(dir, `${NOW - 10}-1-quota_five_hour.txt`), 'queued alert')
    const probe = vi.fn(async () => ({ ok: true }))
    const ownerAlert = vi.fn(async () => true)
    const plans = vi.fn(() => [{ planId: DEFAULT_PLAN_ID, label: 'x', snap: snap(99, 10) }])
    const { d } = deps({ plans })
    const c = { notice: { ...d, config: { ...d.config, noticeEnabled: enabled } }, outboxDir: dir, ownerAlert, probeDeps: probeDeps(probe) }
    return { dir, probe, ownerAlert, plans, d, c }
  }

  it('off: no per-plan probe (no API call), no outbox delivery, no notice, and the marker is removed', async () => {
    const { dir, probe, ownerAlert, plans, d, c } = setup(false)
    writeFileSync(join(dir, OUTBOX_ENABLED_MARKER), 'left over from when it was on')
    await runQuotaNoticeCycle(c)
    expect(probe).not.toHaveBeenCalled()
    expect(ownerAlert).not.toHaveBeenCalled()
    expect(plans).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
    expect(existsSync(join(dir, OUTBOX_ENABLED_MARKER))).toBe(false)
    // The queued file is not touched while off.
    expect(readdirSync(dir)).toEqual([`${NOW - 10}-1-quota_five_hour.txt`])
  })
  it('on: marker written, outbox delivered, the probe runs, then the notice', async () => {
    const { dir, probe, ownerAlert, d, c } = setup(true)
    await runQuotaNoticeCycle(c)
    expect(existsSync(join(dir, OUTBOX_ENABLED_MARKER))).toBe(true)
    expect(ownerAlert).toHaveBeenCalledWith('queued alert')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(d.notifyOwner).toHaveBeenCalledTimes(1)
    // Only the marker is left: it is a dot-file, never delivered as an alert.
    expect(readdirSync(dir)).toEqual([OUTBOX_ENABLED_MARKER])
  })
  it('marker: created with the dir when on (mode 600), idempotent, removed when off', () => {
    const dir = join(box(), 'owner-alert-outbox')
    expect(syncOutboxMarker(dir, true)).toBe(true)
    expect(syncOutboxMarker(dir, true)).toBe(true)
    expect(statSync(join(dir, OUTBOX_ENABLED_MARKER)).mode & 0o777).toBe(0o600)
    expect(syncOutboxMarker(dir, false)).toBe(false)
    expect(existsSync(join(dir, OUTBOX_ENABLED_MARKER))).toBe(false)
    expect(syncOutboxMarker(dir, false)).toBe(false)
  })
  it('the delivery never reads the marker as an alert', async () => {
    const dir = box()
    syncOutboxMarker(dir, true)
    const send = vi.fn(async () => true)
    expect(await deliverOwnerAlertOutbox(dir, NOW, send)).toEqual({ delivered: 0, kept: 0, dropped: 0 })
    expect(send).not.toHaveBeenCalled()
  })
})
