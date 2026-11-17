// PLANROTATEDEADLOCK1115 P3 + P6: the plan rotation in the dashboard backend, with no agent turn. Every collaborator
// is injected (RotationBackendDeps): the decision's actions, the rotation, the owner signal and the side-car.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudePlansState } from '../web/claude-plans-state.js'
import { rotationActionFromLine } from '../claude-plan-rotate-check-run.js'
import {
  runRotationTick, staleCheckAlert, lineField, clockHHMM, ROTATION_STALE_AFTER_MS, PENDING_SIGNALS_KEPT, type RotationBackendDeps,
} from '../web/claude-rotation-backend.js'
import { withRotationLock } from '../web/claude-rotation-lock.js'
import {
  exhaustedReadingFrom429, RATE_LIMIT_EXHAUSTED_RETRY_AFTER_SEC, HEADERLESS_429_FRESH_MS, RETRY_AFTER_CAP_SEC,
} from '../claude-plan-rotate-heartbeat.js'
import { probePlanUsage, parseRetryAfter, observationFromProbe, usageFromProbe } from '../claude-plan-usage-probe.js'

const NOW = 1_800_000_000_000
const ROTATE = 'ROTATE agent=marveen target=b targetLabel=Team Seat currentLabel=Personal PRO currentPct=100 resetsInMin=60 trigger=5h'
const NO_ALT = 'NO_ALTERNATIVE agent=marveen currentLabel=Personal PRO currentPct=100 resetsInMin=60 trigger=5h'
const SUB_ROTATE = 'SUBAGENT_ROTATE agent=iris target=c targetLabel=c currentLabel=b currentPct=95 resetsInMin=10 trigger=5h'
const FLEET_FAILED = 'FLEET_FAILED fleetPlan=b restarted=dani failed=geri,iris'

function harness(lines: string[][], opts: { notifyOk?: boolean[]; rotateStatus?: number } = {}) {
  const order: string[] = []
  let state: ClaudePlansState = { activePlanByAgent: { marveen: 'a' }, plans: {} }
  let tick = 0
  const notifyOk = [...(opts.notifyOk ?? [])]
  const deps: RotationBackendDeps = {
    check: vi.fn(async () => (lines[tick++] ?? []).map(rotationActionFromLine)),
    rotate: vi.fn(async (input) => {
      order.push(`rotate:${input.agentId}->${input.targetPlanId}`)
      const status = opts.rotateStatus ?? 200
      return status === 200
        ? { status, payload: { ok: true, agentId: input.agentId, ...(input.agentId !== 'marveen' ? { launchAuth: 'plan-token' } : {}) } }
        : { status, payload: { error: 'Main agent restart failed' } }
    }),
    notify: vi.fn(async (text: string) => {
      const ok = notifyOk.length ? notifyOk.shift()! : true
      order.push(`${ok ? 'signal' : 'signal-FAILED'}:${text}`)
      return ok
    }),
    readState: () => state,
    writeState: (s) => { state = s },
    planLabel: (id) => ({ a: 'Personal PRO', b: 'Team Seat', c: 'Cee' } as Record<string, string>)[id] ?? id,
    rotationOn: () => true,
    now: () => NOW,
    lang: () => 'en',
  }
  return { deps, order, state: () => state }
}

describe('a backend tick (PLANROTATEDEADLOCK1115 P3)', () => {
  it('ROTATE: the owner signal FIRST, then the rotation, and nothing else (no agent turn)', async () => {
    const h = harness([[ROTATE]])
    const s = await runRotationTick(h.deps)
    expect(h.order).toHaveLength(2)
    expect(h.order[0]).toMatch(/^signal:Claude plan switch: Personal PRO \(100%, 5h, resets in 60 min\) -> Team Seat\. The main session restarts now\.$/)
    expect(h.order[1]).toBe('rotate:marveen->b')
    expect(h.deps.rotate).toHaveBeenCalledWith({ agentId: 'marveen', targetPlanId: 'b', continue: false })
    expect(s.rotated).toEqual(['marveen'])
    expect(h.state().backend?.lastCheckAt).toBe(NOW)
  })

  it('D1: the signal fails, the rotation STILL happens, and the signal is sent on the next tick', async () => {
    const h = harness([[ROTATE], []], { notifyOk: [false] })
    await runRotationTick(h.deps)
    expect(h.order[0]).toMatch(/^signal-FAILED:/)
    expect(h.order[1]).toBe('rotate:marveen->b')
    expect(h.state().backend?.pendingSignals).toHaveLength(1)
    // the retry a tick later carries the time it was first meant for
    const later = { ...h.deps, now: () => NOW + 10 * 60_000 }
    await runRotationTick(later)
    expect(h.order[2]).toBe(`signal:[${clockHHMM(NOW)}] ${h.order[0].slice('signal-FAILED:'.length)}`)
    expect(h.state().backend?.pendingSignals).toBeUndefined()
  })

  it('a signal failing again keeps its first time, not a second one', async () => {
    const h = harness([[ROTATE], [], []], { notifyOk: [false, false] })
    await runRotationTick(h.deps)
    await runRotationTick({ ...h.deps, now: () => NOW + 10 * 60_000 })
    expect(h.state().backend?.pendingSignals).toEqual([`[${clockHHMM(NOW)}] ${h.order[0].slice('signal-FAILED:'.length)}`])
  })

  it(`the queue keeps the last ${PENDING_SIGNALS_KEPT} unsent signals; the dropped count is told in one line first`, async () => {
    const many = Array.from({ length: PENDING_SIGNALS_KEPT + 5 }, (_, i) => `FLEET_SKIPPED fleetPlan=b n=${i}`)
    const h = harness([many, []], { notifyOk: Array(many.length).fill(false) })
    await runRotationTick(h.deps)
    const b = h.state().backend
    expect(b?.pendingSignals).toHaveLength(PENDING_SIGNALS_KEPT)
    expect(b?.pendingSignals?.[0]).toContain('n=5')
    expect(b?.pendingDropped).toBe(5)
    await runRotationTick(h.deps)
    const sent = h.order.slice(many.length)
    expect(sent[0]).toMatch(/^signal:5 earlier Claude plan rotation signal\(s\) could not be delivered and were dropped/)
    expect(sent[1]).toContain('n=5')
    expect(h.state().backend?.pendingDropped).toBeUndefined()
    expect(h.state().backend?.pendingSignals).toBeUndefined()
  })

  it('a rotation the route refuses is reported to the owner with its status and error', async () => {
    const h = harness([[ROTATE]], { rotateStatus: 500 })
    const s = await runRotationTick(h.deps)
    expect(s.rotated).toEqual([])
    expect(h.order[2]).toBe('signal:Claude plan switch for marveen FAILED (HTTP 500): Main agent restart failed')
  })

  it('SUBAGENT_ROTATE: the rotation FIRST, then the signal with the launch outcome', async () => {
    const h = harness([[SUB_ROTATE]])
    await runRotationTick(h.deps)
    expect(h.order[0]).toBe('rotate:iris->c')
    expect(h.order[1]).toMatch(/^signal:Sub-agent iris: Claude plan switch: b \(95%, 5h, resets in 10 min\) -> Cee\. \(launchAuth=plan-token\)$/)
  })

  it('NO_ALTERNATIVE: one signal per window, not one per tick', async () => {
    const h = harness([[NO_ALT], [NO_ALT], [NO_ALT]])
    await runRotationTick(h.deps)
    await runRotationTick(h.deps)
    expect(h.order.filter((o) => o.startsWith('signal:'))).toHaveLength(1)
    expect(h.order[0]).toMatch(/no registered plan to switch to\.$/)
    // a later window (the reset moved) is a new signal
    const later = { ...h.deps, now: () => NOW + 5 * 3600_000 }
    await runRotationTick(later)
    expect(h.order.filter((o) => o.startsWith('signal:'))).toHaveLength(2)
  })

  it('FLEET_*: relayed, a non-empty failed= list highlighted', async () => {
    const h = harness([[FLEET_FAILED]])
    await runRotationTick(h.deps)
    expect(h.order[0]).toContain('Not restarted, needs a look: geri,iris')
  })

  it('two ticks at once run one after the other (one lock), and so does a tick against the route', async () => {
    let inside = 0
    let maxInside = 0
    const h = harness([[ROTATE], [ROTATE]])
    const slowRotate = h.deps.rotate
    h.deps.rotate = vi.fn(async (input) => {
      inside++; maxInside = Math.max(maxInside, inside)
      await new Promise((r) => setTimeout(r, 20))
      inside--
      return slowRotate(input)
    })
    const routeLike = withRotationLock(async () => { inside++; maxInside = Math.max(maxInside, inside); await new Promise((r) => setTimeout(r, 20)); inside-- })
    await Promise.all([runRotationTick(h.deps), runRotationTick(h.deps), routeLike])
    expect(maxInside).toBe(1)
  })

  it('a label with a space is read whole from the line', () => {
    expect(lineField(ROTATE, 'targetLabel')).toBe('Team Seat')
    expect(lineField(ROTATE, 'currentLabel')).toBe('Personal PRO')
    expect(lineField(ROTATE, 'target')).toBe('b')
  })
})

describe('the stale-check alert (PLANROTATEDEADLOCK1115 P6)', () => {
  const base = { startedAt: NOW - 2 * ROTATION_STALE_AFTER_MS, nowMs: NOW, lang: 'en' as const }
  it('rotation on and the last check older than 30 minutes: alert', () => {
    expect(staleCheckAlert({ ...base, rotationOn: true, backend: { lastCheckAt: NOW - ROTATION_STALE_AFTER_MS - 60_000 } })).toMatch(/has not run for 31 minutes/)
  })
  it('fresh enough, rotation off, or already said for this episode: nothing', () => {
    expect(staleCheckAlert({ ...base, rotationOn: true, backend: { lastCheckAt: NOW - ROTATION_STALE_AFTER_MS } })).toBeNull()
    expect(staleCheckAlert({ ...base, rotationOn: false, backend: { lastCheckAt: 0 } })).toBeNull()
    expect(staleCheckAlert({ ...base, rotationOn: true, backend: { lastCheckAt: NOW - 2 * ROTATION_STALE_AFTER_MS, staleAlertAt: NOW - 60_000 } })).toBeNull()
  })
  it('never checked since the start, and the start was more than 30 minutes ago: alert', () => {
    expect(staleCheckAlert({ ...base, rotationOn: true, backend: undefined })).toMatch(/has not run/)
  })
})

describe('web.ts wiring', () => {
  const WEB = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  it('the backend starts only with the background services on, and stops on shutdown', () => {
    expect(WEB).toContain('const rotationBackend = servicesOff ? undefined : startRotationBackend()')
    expect(WEB).toContain('rotationBackend?.stop()')
  })
  it('the rotate route takes the same lock', () => {
    const ROUTE = readFileSync(join(__dirname, '..', 'web', 'routes', 'claude-plans.ts'), 'utf-8')
    expect(ROUTE).toContain('await withRotationLock(() => rotatePlan({ agentId, targetPlanId, continue: wantContinue }))')
  })
})

// PLANROTATEDEADLOCK1115 P4 (Samu 79317): an active-plan 429 the reading could not use (no 5h window).
describe('exhaustedReadingFrom429 (P4)', () => {
  const nowS = Math.floor(NOW / 1000)
  const read = (input: Partial<Parameters<typeof exhaustedReadingFrom429>[0]>) =>
    exhaustedReadingFrom429({ usage: null, nowMs: NOW, source: 'probe', ...input })
  it('D: unified headers, only the overall status "rejected": exhausted', () => {
    const r = read({ usage: { fiveHour: null, sevenDay: null, overallStatus: 'rejected' }, retryAfterSec: 120 })
    expect(r?.fiveHour).toEqual({ usedPercent: 100, resetsAt: nowS + 120, status: 'rejected' })
  })
  it('E: only the 7d window, rejected: exhausted until the weekly reset', () => {
    const week = nowS + 3 * 86400
    const r = read({ usage: { fiveHour: null, sevenDay: { usedPercent: 100, resetsAt: week, status: 'rejected' }, overallStatus: 'rejected' } })
    expect(r?.fiveHour).toEqual({ usedPercent: 100, resetsAt: week, status: 'rejected' })
    expect(r?.sevenDay).toMatchObject({ usedPercent: 100, resetsAt: week, status: 'rejected' })
  })
  it('unified headers with nothing rejected: no reading', () => {
    expect(read({ usage: { fiveHour: null, sevenDay: { usedPercent: 50, resetsAt: nowS + 9, status: 'allowed' }, overallStatus: 'allowed' } })).toBeNull()
  })
  it('C once, short or no retry-after: NO reading (a burst limit)', () => {
    expect(read({})).toBeNull()
    expect(read({ retryAfterSec: RATE_LIMIT_EXHAUSTED_RETRY_AFTER_SEC })).toBeNull()
  })
  it('C with retry-after over 5 minutes: exhausted until then', () => {
    expect(read({ retryAfterSec: 301 })?.fiveHour).toEqual({ usedPercent: 100, resetsAt: nowS + 301, status: 'rejected' })
  })
  it('C twice in a row (the previous probe was a header-less 429 too): exhausted', () => {
    const at = NOW - 10 * 60_000
    expect(read({ previous: { at, error: 'rate_limited', headerless: true } })?.fiveHour.status).toBe('rejected')
    // a previous 429 WITH headers, or another error, is not "twice"
    expect(read({ previous: { at, error: 'rate_limited' } })).toBeNull()
    expect(read({ previous: { at, error: 'network', headerless: true } })).toBeNull()
  })
  it('C: an OLD header-less 429 and a short one now are not "twice" (Samu, #2821)', () => {
    const prev = { error: 'rate_limited', headerless: true }
    expect(read({ previous: { ...prev, at: NOW - HEADERLESS_429_FRESH_MS } })?.fiveHour.status).toBe('rejected')
    expect(read({ previous: { ...prev, at: NOW - HEADERLESS_429_FRESH_MS - 1 } })).toBeNull()
    expect(read({ previous: { ...prev, at: NOW - 3 * 86400_000 }, retryAfterSec: 30 })).toBeNull()
    expect(read({ previous: prev })).toBeNull()
  })
  it('a retry-after past the weekly window parks the plan no further than the week (Dani N2)', () => {
    const far = 365 * 86400
    expect(read({ retryAfterSec: far })?.fiveHour.resetsAt).toBe(nowS + RETRY_AFTER_CAP_SEC)
    expect(read({ usage: { fiveHour: null, sevenDay: null, overallStatus: 'rejected' }, retryAfterSec: far })?.fiveHour.resetsAt).toBe(nowS + RETRY_AFTER_CAP_SEC)
  })
})

describe('the probe on a 429 (P4)', () => {
  const fake = (headers: Record<string, string>) => async () => new Response('{}', { status: 429, headers })
  it('reads retry-after, seconds or an HTTP date; never more than it says', () => {
    expect(parseRetryAfter('600', NOW)).toBe(600)
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90)
    expect(parseRetryAfter('soon', NOW)).toBeNull()
    expect(parseRetryAfter(null, NOW)).toBeNull()
  })
  it('a header-less 429 carries retryAfterSec and is marked headerless in the observation', async () => {
    const r = await probePlanUsage('sk-ant-oat01-x', { fetchImpl: fake({ 'retry-after': '900' }) })
    expect(r).toMatchObject({ ok: false, error: 'rate_limited', retryAfterSec: 900 })
    expect(usageFromProbe(r)).toBeNull()
    expect(observationFromProbe(r, undefined, NOW).lastProbe).toMatchObject({ error: 'rate_limited', headerless: true })
  })
  it('a 429 WITH unified headers is not marked headerless', async () => {
    const r = await probePlanUsage('sk-ant-oat01-x', { fetchImpl: fake({ 'anthropic-ratelimit-unified-status': 'rejected' }) })
    expect(observationFromProbe(r, undefined, NOW).lastProbe?.headerless).toBeUndefined()
  })
})
