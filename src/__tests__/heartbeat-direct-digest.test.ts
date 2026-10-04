import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb, hasHeartbeatDigestSince, hasAgentMessageStartingWith, createAgentMessage } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { renderHeartbeatMetricsBlock } from '../web/heartbeat-metrics-inject.js'
import { parseKanbanClaims } from '../web/heartbeat-kanban-verify.js'
import {
  buildHeartbeatDigestFromBlock,
  sendHeartbeatDigestDirect,
  checkHeartbeatDigestGaps,
  gapNoteMarker,
  HEARTBEAT_DIGEST_GRACE_MS,
  DIRECT_DIGEST_RUN_STATUS,
  type DirectDigestDeps,
  type GapGuardDeps,
} from '../web/heartbeat-direct-digest.js'
import { isDirectDigestTask, digestGapTasks } from '../web/schedule-runner.js'

// HBFABRIC1003 (measured 2026-10-03): 4 heartbeat sends, 1 reached the server.
// The digest is now sent by the runner (A), and a missing one is reported (B).

const RAW = [
  'HB_METRICS_V1 ts=2026-10-04 12:00',
  'COUNTS urgent=2 in_progress=4 waiting=414 planned=697 new_hot_memories_1h=0 db_size_mb=525.3 waiting_shown=2',
  'URGENT VAULTSZELES826 VAULTSZELES826: t',
  'URGENT SEMPELIOROOM917 SEMPELIOROOM917: t',
  'WAITING ALKTANUSFK911 ALKTANUSFK911: t',
  'WAITING PR1682PERSONAFU1003 PR1682PERSONAFU1003: t',
  'CALENDAR_EVENTS n=0 window=2h',
  'TOKEN_PRUNE state=ok retention_days=90 lag_hours=16.44 tolerance_hours=48',
  'SCHEDULES enabled=40',
  'TASK_RUNS_1H total=45 fired=12 skipped=1',
].join('\n')

describe('(A) the digest the runner builds from the block', () => {
  const digest = buildHeartbeatDigestFromBlock(renderHeartbeatMetricsBlock(RAW), 'Europe/Budapest', 'FALLBACK')

  it('header and freshness line carry the BLOCK ts, not the fallback clock', () => {
    expect(digest.split('\n').slice(0, 3)).toEqual([
      '## Heartbeat 2026-10-04 12:00 (Europe/Budapest)',
      'merve: 2026-10-04 12:00',
      '',
    ])
  })

  it('the marker line and the LLM copy-instructions are not in the digest', () => {
    expect(digest).not.toContain('[HB-METRIKA-BLOKK')
    expect(digest).not.toContain('VALTOZATLANUL')
  })

  it('the sections are the block verbatim, and the Kanban lines are exactly what the gate parses', () => {
    const block = renderHeartbeatMetricsBlock(RAW)
    expect(block).toContain(digest.slice(digest.indexOf('### ')))
    expect(parseKanbanClaims(digest)).toEqual([
      { key: 'urgent', count: 2, ids: ['VAULTSZELES826', 'SEMPELIOROOM917'] },
      { key: 'in_progress', count: 4, ids: [] },
      { key: 'waiting', count: 414, ids: ['ALKTANUSFK911', 'PR1682PERSONAFU1003'] },
      { key: 'planned', count: 697, ids: [] },
    ])
  })

  it('an instrument failure still yields a digest (with its muszer-hiba lines), never an empty send', () => {
    const d = buildHeartbeatDigestFromBlock(renderHeartbeatMetricsBlock(null, 'instrument timeout'), 'Europe/Budapest', 'X')
    expect(d.startsWith('## Heartbeat ')).toBe(true)
    expect(d).toContain('muszer-hiba')
  })
})

function fakeDeps(over: Partial<DirectDigestDeps> = {}) {
  const sent: Array<{ from: string; to: string; content: string }> = []
  const runs: string[] = []
  const warns: string[] = []
  const deps: DirectDigestDeps = {
    collectBlock: async () => renderHeartbeatMetricsBlock(RAW),
    verify: () => ({ ok: true }),
    send: (from, to, content) => { sent.push({ from, to, content }) },
    appendRun: (_t, _a, status) => { runs.push(status) },
    warn: (_o, msg) => { warns.push(msg) },
    tz: 'Europe/Budapest',
    nowLabel: () => '2026-10-04 12:00',
    mainAgentId: 'marveen',
    ...over,
  }
  return { deps, sent, runs, warns }
}

describe('(A) sendHeartbeatDigestDirect', () => {
  it('sends ONE digest from the task agent to the main agent and records a terminal run', async () => {
    const f = fakeDeps()
    expect(await sendHeartbeatDigestDirect('hourly-heartbeat', 'heartbeat', f.deps)).toBe(true)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].from).toBe('heartbeat')
    expect(f.sent[0].to).toBe('marveen')
    expect(f.sent[0].content.startsWith('## Heartbeat 2026-10-04 12:00')).toBe(true)
    expect(f.runs).toEqual([DIRECT_DIGEST_RUN_STATUS])
  })

  it('a self-check mismatch is logged, and the measured digest still goes out', async () => {
    const f = fakeDeps({ verify: () => ({ ok: false, problems: ['waiting: sent 414, live 415 (tolerance 0)'] }) })
    expect(await sendHeartbeatDigestDirect('hourly-heartbeat', 'heartbeat', f.deps)).toBe(true)
    expect(f.sent).toHaveLength(1)
    expect(f.warns.some((w) => /instrument drift/.test(w))).toBe(true)
  })

  it('a failure sends nothing, records an error run and does not throw (the gap guard reports it)', async () => {
    const f = fakeDeps({ send: () => { throw new Error('db locked') } })
    expect(await sendHeartbeatDigestDirect('hourly-heartbeat', 'heartbeat', f.deps)).toBe(false)
    expect(f.runs).toEqual(['error'])
  })
})

describe('(A) which tasks the runner sends itself -- flag-less tasks are untouched (Marveen, 3.)', () => {
  const base = { type: 'heartbeat' as const, injectMetrics: true, agent: 'heartbeat' }
  it('only heartbeat + injectMetrics + sendDigestDirect, never "all"', () => {
    expect(isDirectDigestTask({ ...base, sendDigestDirect: true })).toBe(true)
    expect(isDirectDigestTask({ ...base })).toBe(false)
    expect(isDirectDigestTask({ ...base, sendDigestDirect: false })).toBe(false)
    expect(isDirectDigestTask({ ...base, injectMetrics: false, sendDigestDirect: true })).toBe(false)
    expect(isDirectDigestTask({ ...base, type: 'task', sendDigestDirect: true })).toBe(false)
    expect(isDirectDigestTask({ ...base, agent: 'all', sendDigestDirect: true })).toBe(false)
  })

  // Marveen, 1.: the direct send must not fall under skipIfBusy / the session
  // path. The branch sits before the quota gate and before attemptFireTask in
  // the tick, so a busy main agent cannot hold it back.
  // Geri's #1687 verify: removing the direct branch from runScheduledTaskNow
  // survived -- a manual "run now" would silently fall back to the LLM round.
  it('the manual run-now takes the direct branch before any session dispatch', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export async function runScheduledTaskNow('))
    const direct = fn.indexOf('if (isDirectDigestTask(task)) {\n    const sent = await sendHeartbeatDigestDirect(')
    const dispatch = fn.indexOf('await attemptFireTask(task, agentName, now)')
    expect(direct).toBeGreaterThan(0)
    expect(dispatch).toBeGreaterThan(direct)
  })

  it('in the tick, the direct branch runs before the quota gate and the session dispatch', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
    const direct = src.indexOf('if (isDirectDigestTask(task)) {\n        await sendHeartbeatDigestDirect(')
    const quota = src.indexOf('const quota = decideQuotaAction({')
    const dispatch = src.indexOf('const result = await attemptFireTask(task, agentName, now, cronPc.prefix, lateCatchUpMs)')
    expect(direct).toBeGreaterThan(0)
    expect(direct).toBeLessThan(quota)
    expect(direct).toBeLessThan(dispatch)
  })
})

const HOUR = 60 * 60 * 1000
const SLOT = Date.UTC(2026, 9, 4, 10, 0, 0) // 12:00 Budapest

function gapDeps(over: Partial<GapGuardDeps> = {}) {
  const notes: string[] = []
  const existing = new Set<string>()
  const deps: GapGuardDeps = {
    prevOccurrence: (_s, fromMs, toMs) => (SLOT > fromMs && SLOT <= toMs ? SLOT : null),
    digestSince: () => false,
    noteExists: (m) => existing.has(m),
    sendNote: (c) => { notes.push(c); existing.add(c.slice(0, c.indexOf(' A '))) },
    slotLabel: () => '12:00',
    ...over,
  }
  return { deps, notes }
}

describe('(B) the gap guard (Marveen, 2.)', () => {
  const task = [{ name: 'hourly-heartbeat', agent: 'heartbeat', schedule: '0 9-22 * * *' }]

  it('NEGATIVE CONTROL: a slot whose digest arrived does not report', () => {
    const g = gapDeps({ digestSince: () => true })
    expect(checkHeartbeatDigestGaps(task, SLOT + HEARTBEAT_DIGEST_GRACE_MS + 60_000, g.deps)).toEqual([])
    expect(g.notes).toEqual([])
  })

  it('inside the grace period nothing is reported yet', () => {
    const g = gapDeps()
    expect(checkHeartbeatDigestGaps(task, SLOT + HEARTBEAT_DIGEST_GRACE_MS - 60_000, g.deps)).toEqual([])
  })

  // Geri's #1687 verify: a mutant with the grace set to 0 survived the line
  // above, because the test computed its own "inside" from the same constant.
  // The contract in absolute minutes: 9 minutes after the slot is too early.
  it('9 minutes after the slot is still inside the grace (absolute, not derived from the constant)', () => {
    const g = gapDeps()
    expect(checkHeartbeatDigestGaps(task, SLOT + 9 * 60_000, g.deps)).toEqual([])
    expect(checkHeartbeatDigestGaps(task, SLOT + 11 * 60_000, g.deps)).toHaveLength(1)
  })

  it('a missing digest is reported EXACTLY once per slot, however many passes run', () => {
    const g = gapDeps()
    const now = SLOT + HEARTBEAT_DIGEST_GRACE_MS + 60_000
    expect(checkHeartbeatDigestGaps(task, now, g.deps)).toEqual([gapNoteMarker('hourly-heartbeat', SLOT)])
    expect(checkHeartbeatDigestGaps(task, now + 5 * 60_000, g.deps)).toEqual([])
    expect(checkHeartbeatDigestGaps(task, now + 30 * 60_000, g.deps)).toEqual([])
    expect(g.notes).toHaveLength(1)
    expect(g.notes[0]).toContain('[HB-HIANY]')
  })

  it('the OLD (flag-less) route is in the guarded family too -- the absence is the finding, not the route', () => {
    const tasks = digestGapTasks([
      { name: 'hourly-heartbeat', agent: 'heartbeat', schedule: '0 9-22 * * *', enabled: true, type: 'heartbeat', injectMetrics: true },
      { name: 'direct-hb', agent: 'heartbeat', schedule: '0 * * * *', enabled: true, type: 'heartbeat', injectMetrics: true },
      { name: 'memoria-heartbeat', agent: 'marveen', schedule: '0 */4 * * *', enabled: true, type: 'heartbeat' },
      { name: 'off', agent: 'heartbeat', schedule: '0 * * * *', enabled: false, type: 'heartbeat', injectMetrics: true },
      { name: 'a-task', agent: 'samu', schedule: '0 * * * *', enabled: true, type: 'task', injectMetrics: true },
    ])
    expect(tasks.map((t) => t.name)).toEqual(['hourly-heartbeat', 'direct-hb'])
  })
})

describe('(B) the DB side of the guard (real queries)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('a digest row counts only from the right sender, to the main agent, at or after the slot, with the digest header', () => {
    const since = Date.now() - 1000
    expect(hasHeartbeatDigestSince('heartbeat', MAIN_AGENT_ID, since)).toBe(false)
    createAgentMessage('heartbeat', MAIN_AGENT_ID, 'not a digest')
    createAgentMessage('samu', MAIN_AGENT_ID, '## Heartbeat 2026-10-04 12:00 (Europe/Budapest)')
    expect(hasHeartbeatDigestSince('heartbeat', MAIN_AGENT_ID, since)).toBe(false)
    createAgentMessage('heartbeat', MAIN_AGENT_ID, '## Heartbeat 2026-10-04 12:00 (Europe/Budapest)\nmerve: x')
    expect(hasHeartbeatDigestSince('heartbeat', MAIN_AGENT_ID, since)).toBe(true)
    expect(hasHeartbeatDigestSince('heartbeat', MAIN_AGENT_ID, Date.now() + 120_000)).toBe(false)
  })

  it('the one-note-per-slot memory survives a restart: it is the queued row itself', () => {
    const marker = gapNoteMarker('hourly-heartbeat', SLOT)
    expect(hasAgentMessageStartingWith('system', MAIN_AGENT_ID, marker)).toBe(false)
    createAgentMessage('system', MAIN_AGENT_ID, `${marker} A 12:00-s heartbeat-digest ...`)
    expect(hasAgentMessageStartingWith('system', MAIN_AGENT_ID, marker)).toBe(true)
    expect(hasAgentMessageStartingWith('system', MAIN_AGENT_ID, gapNoteMarker('hourly-heartbeat', SLOT + HOUR))).toBe(false)
    const n = (getDb().prepare("SELECT count(*) AS n FROM agent_messages WHERE content LIKE '[HB-HIANY]%'").get() as { n: number }).n
    expect(n).toBe(1)
  })
})

describe('(A)+(B) a direct send that did not land is caught by the guard (Marveen, 1.)', () => {
  it('send fails -> no digest row -> the guard reports that slot; send works -> the guard stays silent', async () => {
    initDatabase(':memory:')
    const slot = Date.now() - HEARTBEAT_DIGEST_GRACE_MS - 60_000
    const real = (sendWorks: boolean): GapGuardDeps => ({
      prevOccurrence: (_s, fromMs, toMs) => (slot > fromMs && slot <= toMs ? slot : null),
      digestSince: (agent, sinceMs) => hasHeartbeatDigestSince(agent, MAIN_AGENT_ID, sinceMs - 1000),
      noteExists: (m) => hasAgentMessageStartingWith('system', MAIN_AGENT_ID, m),
      sendNote: (c) => { createAgentMessage('system', MAIN_AGENT_ID, c) },
      slotLabel: () => 'slot',
    })
    const task = [{ name: 'hourly-heartbeat', agent: 'heartbeat', schedule: '0 * * * *' }]

    const failing = fakeDeps({ send: () => { throw new Error('db locked') } })
    await sendHeartbeatDigestDirect('hourly-heartbeat', 'heartbeat', failing.deps)
    expect(checkHeartbeatDigestGaps(task, Date.now(), real(false))).toHaveLength(1)

    initDatabase(':memory:')
    const working = fakeDeps({ send: (from, to, content) => { createAgentMessage(from, to, content) }, mainAgentId: MAIN_AGENT_ID })
    await sendHeartbeatDigestDirect('hourly-heartbeat', 'heartbeat', working.deps)
    expect(checkHeartbeatDigestGaps(task, Date.now(), real(true))).toEqual([])
  })
})
