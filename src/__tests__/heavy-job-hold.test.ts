// The restart-hold episode invariant (heavy-job-hold.ts): an episode is one
// unbroken run of restart decisions for one agent; inside it the total hold is
// at most the cap; anything else than a restart decision closes it.
import { describe, it, expect } from 'vitest'
import {
  aliveBeforeRestart,
  continuesHoldEpisode,
  heldMinutesOf,
  jobKey,
  markReported,
  parseHoldStore,
  planRestart,
  quoteLabel,
  sessionReplaced,
  settleRestart,
  unreportedKilled,
  type Episode,
} from '../web/heavy-job-hold.js'
import type { GatedJob } from '../web/heavy-job-owner.js'

const J = (pid: number, label = `job-${pid}`, state: GatedJob['state'] = 'running'): GatedJob => ({ pid, label, start: String(pid * 10), state })
const MIN = 60_000
const SWEEP = 5 // minutes
const PANES = [100]

/**
 * A sweep-by-sweep model of the runner: 'R' = the decision is a restart, 'N' =
 * anything else (none, guard disabled, agent stopped, cooldown). Each step says
 * which jobs are live. A restart that is not held happens (and kills the live
 * jobs unless `survive`). Returns, per step, 'H' (held), 'X' (restarted) or
 * '-' (no restart decision), plus the alerts and notes.
 */
function run(steps: Array<{ d: 'R' | 'N'; jobs: GatedJob[]; panes?: number[] }>, cap: number, survive = false) {
  let ep: Episode | null = null
  const out: string[] = []
  const alerts: string[][] = []
  const notes: unknown[] = []
  steps.forEach((s, i) => {
    const now = i * SWEEP * MIN
    const live = new Set(s.jobs.map((j) => j.pid))
    const alive = (pid: number) => live.has(pid)
    if (s.d === 'N') { ep = null; out.push('-'); return }   // closeEpisodesAfterSweep
    const plan = planRestart(ep, s.jobs, s.panes ?? PANES, now, cap, alive)
    ep = plan.episode
    if (plan.hold) { out.push('H'); return }
    if (plan.toAlert.length > 0) {
      alerts.push(plan.toAlert.map((e) => e.label))
      for (const e of plan.toAlert) ep!.jobs[jobKey(e)]!.alerted = true
    }
    const before = aliveBeforeRestart(ep, alive)
    const after = (pid: number) => survive && live.has(pid)
    const settled = settleRestart(ep, before, after, true, now, cap)
    ep = settled.episode
    if (settled.note) notes.push(settled.note)
    out.push('X')
  })
  return { seq: out.join(''), alerts, notes }
}

const R = (jobs: GatedJob[], panes?: number[]) => ({ d: 'R' as const, jobs, panes })
const N = (jobs: GatedJob[] = []) => ({ d: 'N' as const, jobs })
const times = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))

describe('episodes over decision sequences (table)', () => {
  const cases: Array<{ name: string; steps: ReturnType<typeof R | typeof N>[]; cap: number; seq: string; alerts?: number }> = [
    { name: 'no job: restart at once', steps: [R([])], cap: 45, seq: 'X' },
    { name: 'held, held, then the restart need dissolves, then a NEW need with a new job: held again',
      steps: [R([J(1)]), R([J(1)]), N([J(1)]), R([J(2)]), R([J(2)])], cap: 45, seq: 'HH-HH' },
    { name: 'the dissolved episode does not eat the next one (same job, still live)',
      steps: [...times(9, () => R([J(1)])), N([J(1)]), R([J(1)]), R([J(1)])], cap: 45, seq: 'HHHHHHHHH-HH' },
    { name: 'one job, unbroken run: released at the cap', steps: times(12, () => R([J(1)])), cap: 45, seq: 'HHHHHHHHHX' + '' , alerts: 1 },
    { name: 'a stream of new jobs inside one episode: released at the cap',
      steps: times(12, (i) => R([J(100 + Math.floor(i / 2)), J(101 + Math.floor(i / 2))])), cap: 45, seq: 'HHHHHHHHHX', alerts: 1 },
    { name: 'cap 0: never held', steps: [R([J(1)])], cap: 0, seq: 'X', alerts: 1 },
    { name: 'a new session (no old pane left) is a new episode',
      steps: [...times(9, () => R([J(1)])), R([J(2)], [200]), R([J(2)], [200])], cap: 45, seq: 'HHHHHHHHHHH' },
    { name: 'a new tmux window (old pane still there) is NOT a new episode',
      steps: [...times(9, () => R([J(1)])), R([J(2)], [100, 300])], cap: 45, seq: 'HHHHHHHHHX' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const r = run(c.steps.slice(0, c.seq.length), c.cap)
      expect(r.seq).toBe(c.seq)
      if (c.alerts !== undefined) expect(r.alerts).toHaveLength(c.alerts)
    })
  }

  it('cap 1440 and a job living 48 h: released at the cap (+1 sweep at most), one alert', () => {
    const sweeps = (48 * 60) / SWEEP
    const r = run(times(sweeps, () => R([J(1)])), 1440)
    const released = r.seq.indexOf('X')
    expect(released).toBeGreaterThan(0)
    expect(released * SWEEP).toBeLessThanOrEqual(1440 + SWEEP)
    expect(r.alerts).toEqual([['job-1']])
  })

  it('guard disabled mid-episode, then re-enabled: a new episode with its own full hold', () => {
    const steps = [...times(5, () => R([J(1)])), N([J(1)]), N([J(1)]), ...times(10, () => R([J(1)]))]
    const r = run(steps, 45)
    expect(r.seq).toBe('HHHHH--HHHHHHHHHX')
  })

  it('a job that survives a restart is held again only in a NEW episode, bounded the same way', () => {
    const steps = [...times(10, () => R([J(1)])), N([J(1)]), ...times(10, () => R([J(1)]))]
    const r = run(steps, 45, true)
    expect(r.seq).toBe('HHHHHHHHHX-HHHHHHHHHX')
    expect(r.alerts).toHaveLength(2)                // once per episode
  })
})

describe('what the restart did, from facts', () => {
  it('ended during the hold vs killed by the restart; heldMinutes over the killed jobs only, <= cap', () => {
    let ep = planRestart(null, [J(1), J(2)], PANES, 0, 45, () => true).episode
    ep = planRestart(ep, [J(2)], PANES, 10 * MIN, 45, (pid) => pid === 2).episode   // job 1 ended
    expect(ep!.jobs[jobKey(J(1))]).toMatchObject({ outcome: 'ended', outcomeAtMs: 10 * MIN })
    const before = aliveBeforeRestart(ep, (pid) => pid === 2)
    const r = settleRestart(ep, before, () => false, true, 300 * MIN, 45)
    expect(r.episode).toBeNull()
    expect(r.note).toEqual({ heldMinutes: 45, ended: ['job-1'], killed: [{ label: 'job-2', state: 'running' }] })
  })

  it('only ended jobs: heldMinutes 0 (it belongs to the stopped jobs)', () => {
    let ep = planRestart(null, [J(1)], PANES, 0, 45, () => true).episode
    ep = planRestart(ep, [], PANES, 20 * MIN, 45, () => false).episode
    expect(settleRestart(ep, new Set(), () => false, true, 20 * MIN, 45).note).toEqual({ heldMinutes: 0, ended: ['job-1'], killed: [] })
  })

  it('a failed restart keeps the episode and its facts; the next restart of the run reports them', () => {
    const ep0 = planRestart(null, [J(1)], PANES, 0, 0, () => true).episode
    const failed = settleRestart(ep0, aliveBeforeRestart(ep0, () => true), () => false, false, MIN, 0)
    expect(failed.note).toBeNull()
    expect(failed.episode!.jobs[jobKey(J(1))]).toMatchObject({ outcome: 'killed' })
    const retry = settleRestart(failed.episode, new Set(), () => false, true, 2 * MIN, 0)
    expect(retry.note).toEqual({ heldMinutes: 0, ended: [], killed: [{ label: 'job-1', state: 'running' }] })
  })

  it('a job gone BEFORE the call is not "killed"; a survivor is not reported', () => {
    const ep = planRestart(null, [J(1), J(2)], PANES, 0, 0, () => true).episode
    const r = settleRestart(ep, aliveBeforeRestart(ep, (pid) => pid === 2), (pid) => pid === 2, true, MIN, 45)
    expect(r.note).toBeNull()
  })

  it('heldMinutesOf is bounded by the episode and the cap', () => {
    const ep: Episode = { startMs: 10 * MIN, panes: PANES, jobs: {} }
    const e = { pid: 1, start: '1', label: 'a', state: 'running' as const, firstSeenMs: 0, alerted: false, outcome: 'killed' as const, outcomeAtMs: 200 * MIN }
    expect(heldMinutesOf(e, ep, 0, 45)).toBe(45)
    expect(heldMinutesOf({ ...e, outcomeAtMs: 30 * MIN }, ep, 0, 45)).toBe(20)
  })
})

describe('ownership edge cases', () => {
  it('unmeasured ownership: never holds, keeps the records, alerts the live recorded ones', () => {
    const p1 = planRestart(null, [J(1)], PANES, 0, 45, () => true)
    const p2 = planRestart(p1.episode, null, null, MIN, 45, () => true)
    expect(p2.hold).toBe(false)
    expect(p2.toAlert.map((e) => e.label)).toEqual(['job-1'])
    expect(p2.episode?.startMs).toBe(0)
  })

  it('a recorded job that left the agent tree while alive is dropped', () => {
    const p1 = planRestart(null, [J(1), J(2)], PANES, 0, 45, () => true)
    const p2 = planRestart(p1.episode, [J(2)], PANES, MIN, 45, () => true)
    expect(Object.keys(p2.episode!.jobs)).toEqual([jobKey(J(2))])
  })

  it('jobKey is pid + start: a label that reads differently in the lock record keeps the first sighting', () => {
    const queued = { ...J(7, 'build  with   spaces' + 'x'.repeat(120), 'queued') }
    const running = { ...J(7, 'build_with_spaces' + 'x'.repeat(83), 'running') }
    const p1 = planRestart(null, [queued], PANES, 0, 45, () => true)
    const p2 = planRestart(p1.episode, [running], PANES, 5 * MIN, 45, () => true)
    expect(p2.firstSeen).toEqual([])
    expect(Object.values(p2.episode!.jobs)).toMatchObject([{ firstSeenMs: 0, state: 'running' }])
  })

  it('sessionReplaced: only when no old pane is left', () => {
    expect(sessionReplaced([1, 2], [3])).toBe(true)
    expect(sessionReplaced([1, 2], [2, 3])).toBe(false)
    expect(sessionReplaced([], [3])).toBe(false)
  })
})

describe('parseHoldStore', () => {
  it('keeps well-formed episodes and entries; an earlier store shape reads as no episode', () => {
    const good = { pid: 1, start: '1', label: 'a', state: 'running', firstSeenMs: 5, alerted: false }
    expect(parseHoldStore({
      boni: { startMs: 5, panes: [7], jobs: { k: good, bad: { ...good, state: 'x' } } },
      old: { '1:1': good },
      bad: { startMs: 'x', panes: [], jobs: {} },
      arr: [1],
    })).toEqual({ boni: { startMs: 5, panes: [7], jobs: { '1:1': good } } })
    expect(parseHoldStore(null)).toEqual({})
    expect(parseHoldStore([1])).toEqual({})
  })
})

describe('continuesHoldEpisode: the one rule that keeps an episode open', () => {
  const cases: Array<[string, { action: string; nextState: { phase: string } }, boolean]> = [
    ['restart', { action: 'restart', nextState: { phase: 'await-ready' } }, true],
    ['hard tier, busy pane: handoff requested, the restart waits for the turn', { action: 'request-handoff', nextState: { phase: 'await-handoff' } }, true],
    ['await-handoff, still busy (none, same phase)', { action: 'none', nextState: { phase: 'await-handoff' } }, true],
    ['the context dropped (none, idle)', { action: 'none', nextState: { phase: 'idle' } }, false],
    ['guard disabled', { action: 'none', nextState: { phase: 'idle' } }, false],
    ['cooldown (agent stopped, guard disabled during await-handoff, after a restart)', { action: 'none', nextState: { phase: 'cooldown' } }, false],
    ['resume injection after a restart', { action: 'inject-resume', nextState: { phase: 'cooldown' } }, false],
  ]
  for (const [name, d, want] of cases) it(name, () => expect(continuesHoldEpisode(d)).toBe(want))
})

describe('stopped jobs are reported where that becomes known', () => {
  it('a failed restart leaves unreported "killed" facts; once marked, nothing is owed', () => {
    const ep0 = planRestart(null, [J(1), J(2)], PANES, 0, 45, () => true).episode
    const failed = settleRestart(ep0, aliveBeforeRestart(ep0, () => true), (pid) => pid === 2, false, MIN, 45).episode
    expect(unreportedKilled(failed).map((e) => e.label)).toEqual(['job-1'])
    const marked = markReported(failed!, unreportedKilled(failed))
    expect(unreportedKilled(marked)).toEqual([])
    expect(marked.jobs[jobKey(J(1))]).toMatchObject({ outcome: 'killed', reported: true })
    // still in the episode, so a later successful restart tells the fresh session too
    expect(settleRestart(marked, new Set(), () => false, true, 2 * MIN, 45).note?.killed).toEqual([{ label: 'job-1', state: 'running' }])
  })

  it('quoteLabel quotes and keeps only [A-Za-z0-9._:-]', () => {
    expect(quoteLabel('build-1.2:x_y')).toBe('"build-1.2:x_y"')
    expect(quoteLabel('a"b c\u202e')).toBe('"a_b_c_"')
  })
})
