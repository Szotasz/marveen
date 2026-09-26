import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskInjectionRank } from '../web/schedule-runner.js'

// Same-minute injection starvation (2026-07-20 incident): several tasks due in
// one scan window are fired sequentially, and a single injection takes seconds
// to a minute (readiness double-sample, waitForIdle gate, chunked typing).
// listScheduledTasks() returns directory order, so at 07:30 the alphabetical
// alkuszoktatas-feedback-figyelo heartbeat was injected before the
// reggeli-napindito morning briefing every day. Fix: order due tasks by
// injection priority (forceSend > plain task > heartbeat) before firing.
//
// The companion delivery bug (2026-07-17): forceSend bypassed EVERY busy state,
// including context saturation -- the prompt was typed into a 100%-context
// session that could never act on it, and the context-guard's rescue restart
// discarded the queued input. A silent drop wearing a "fired" log line.
// Fix: forceSend defers ONLY on saturation, via the pending-retry queue.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('taskInjectionRank: forceSend outranks tasks outranks heartbeats', () => {
  it('ranks forceSend first regardless of type', () => {
    expect(taskInjectionRank({ forceSend: true, type: 'task' })).toBe(0)
    expect(taskInjectionRank({ forceSend: true, type: 'heartbeat' })).toBe(0)
  })

  it('ranks plain tasks before heartbeats', () => {
    expect(taskInjectionRank({ forceSend: false, type: 'task' })).toBeLessThan(
      taskInjectionRank({ forceSend: false, type: 'heartbeat' }),
    )
    expect(taskInjectionRank({ type: 'command' })).toBeLessThan(
      taskInjectionRank({ type: 'heartbeat' }),
    )
  })

  it('reproduces the 07-20 ordering: napindito (forceSend) beats the feedback heartbeat', () => {
    const due = [
      { name: 'alkuszoktatas-feedback-figyelo', forceSend: undefined, type: 'heartbeat' },
      { name: 'reggeli-napindito', forceSend: true, type: 'task' },
      { name: 'reggeli-penzugyi-riasztasok', forceSend: undefined, type: 'task' },
    ] as const
    const ordered = [...due].sort((a, b) => taskInjectionRank(a) - taskInjectionRank(b))
    expect(ordered.map(t => t.name)).toEqual([
      'reggeli-napindito',
      'reggeli-penzugyi-riasztasok',
      'alkuszoktatas-feedback-figyelo',
    ])
  })

  it('the cron loop actually applies the rank ordering', () => {
    // The task list must be rank-sorted before the fire loop iterates it.
    const sortIdx = SRC.indexOf('tasks.sort((a, b) => taskInjectionRank(a) - taskInjectionRank(b))')
    const loopIdx = SRC.indexOf('for (const task of tasks)')
    expect(sortIdx).toBeGreaterThan(0)
    expect(loopIdx).toBeGreaterThan(sortIdx)
  })
})

describe('forceSend defers on context saturation instead of injecting', () => {
  it('asks saturationRefusesDispatch inside the forceSend branch and returns busy', () => {
    // ESCALATEAFTER921: the saturation-deferral check now reads the local
    // `forceSend` (task.forceSend || escalated), not `task.forceSend` alone --
    // a task escalated past its busy-deferral window must go through the SAME
    // saturation guard as a statically forceSend=true task (see the escalation
    // comment in schedule-runner.ts). `task.forceSend` alone still gates a
    // DIFFERENT branch (the MCP pre-check), so anchoring on that literal here
    // would silently match the wrong branch instead of failing loudly.
    const idx = SRC.indexOf('if (forceSend) {')
    expect(idx).toBeGreaterThan(0)
    const branch = SRC.slice(idx, idx + 1800)
    // The deferral must read the SAME verdict the context-guard net and the
    // dispatch gate read. Left on the raw banner it would build a new deadlock
    // with no way out: forceSend tasks queued forever (banner true) while the
    // guard never restarts the agent (corrected verdict false). And it must be
    // the shared predicate, not the override alone -- that one is session-keyed
    // and blind to the hard-error banner it must never overrule.
    expect(branch).toMatch(/saturationRefusesDispatch\(pane, session\)/)
    expect(branch).toMatch(/return 'busy'/)
    expect(branch).not.toMatch(/paneShowsContextSaturation\(pane\)/)
  })

  it('the skipIfBusy drop exempts forceSend so the deferral queues a retry', () => {
    // A forceSend 'busy' comes only from the saturation deferral; dropping it
    // on skipIfBusy would recreate the silent loss the deferral exists to fix.
    expect(SRC).toMatch(/task\.skipIfBusy && !task\.forceSend/)
  })
})
