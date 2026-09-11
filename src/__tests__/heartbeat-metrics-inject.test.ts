import { describe, it, expect } from 'vitest'
import {
  renderHeartbeatMetricsBlock,
  HB_METRICS_BLOCK_MARKER,
  HB_METRICS_SENTINEL,
} from '../web/heartbeat-metrics-inject.js'

// A full, healthy instrument output in the exact line vocabulary of
// scripts/heartbeat-metrics.sh (its own conformance test pins that side).
const HAPPY = [
  'HB_METRICS_V1 ts=2026-09-11 11:00',
  'COUNTS urgent=2 in_progress=1 waiting=371 planned=545 new_hot_memories_1h=0 db_size_mb=474.4 waiting_shown=2',
  'URGENT CARDA CARDA (URGENT): first urgent title',
  'URGENT CARDB CARDB: second one',
  'WAITING CARDC CARDC: a waiting card',
  'WAITING CARDD CARDD: another waiting card',
  'CALENDAR_EVENTS n=2 window=2h',
  'CAL_EVENT all-day Stay somewhere nice attendees=1',
  'CAL_EVENT 08:00 Új esemény',
  'SCHEDULES enabled=34',
  'TASK_RUNS_1H total=41 fired=12 skipped=29',
].join('\n')

describe('renderHeartbeatMetricsBlock -- happy path', () => {
  const out = renderHeartbeatMetricsBlock(HAPPY)

  it('opens with the marker line carrying the INSTRUMENT ts, not wall clock', () => {
    expect(out.startsWith(`${HB_METRICS_BLOCK_MARKER} ts=2026-09-11 11:00`)).toBe(true)
  })

  it('renders every number from COUNTS and nowhere else', () => {
    expect(out).toContain('- urgent: 2 (CARDA, CARDB)')
    expect(out).toContain('- in_progress: 1')
    expect(out).toContain('- waiting: 371 (2 legfrissebb: CARDC, CARDD)')
    expect(out).toContain('- planned: 545')
    expect(out).toContain('- DB size: 474.4 MB')
    expect(out).toContain('- new hot memories (1h): 0')
  })

  it('carries the TASK_RUNS_1H line verbatim -- the *1000 cutoff stays un-rederivable', () => {
    expect(out).toContain('- last hour: TASK_RUNS_1H total=41 fired=12 skipped=29')
  })

  it('renders calendar events with time and attendee suffix folded to parentheses', () => {
    expect(out).toContain('- all-day -- Stay somewhere nice (attendees=1)')
    expect(out).toContain('- 08:00 -- Új esemény')
  })

  it('renders the schedules count from the SCHEDULES line', () => {
    expect(out).toContain('- enabled schedules: 34')
  })

  it('contains no muszer-hiba line when everything measured', () => {
    // The header MENTIONS muszer-hiba (it instructs that such a line travels
    // unchanged); what must be absent is an actual failure line.
    expect(out).not.toContain('- muszer-hiba')
  })
})

describe('measured empty vs failed query stay DIFFERENT lines (5E0A32B0)', () => {
  it('CALENDAR_EVENTS n=0 renders "no upcoming events"', () => {
    const raw = [
      'HB_METRICS_V1 ts=2026-09-11 12:00',
      'COUNTS urgent=0 in_progress=0 waiting=1 planned=2 new_hot_memories_1h=0 db_size_mb=100 waiting_shown=1',
      'WAITING X X: t',
      'CALENDAR_EVENTS n=0 window=2h',
      'SCHEDULES enabled=1',
      'TASK_RUNS_1H total=0',
    ].join('\n')
    const out = renderHeartbeatMetricsBlock(raw)
    expect(out).toContain('- no upcoming events')
    expect(out).not.toContain('calendar fetch failed')
  })

  it('ERROR calendar renders the failure with its reason verbatim', () => {
    const raw = [
      'HB_METRICS_V1 ts=2026-09-11 12:00',
      'COUNTS urgent=0 in_progress=0 waiting=1 planned=2 new_hot_memories_1h=0 db_size_mb=100 waiting_shown=1',
      'ERROR calendar: token expired for calendar scope',
      'SCHEDULES enabled=1',
      'TASK_RUNS_1H total=0',
    ].join('\n')
    const out = renderHeartbeatMetricsBlock(raw)
    expect(out).toContain('- calendar fetch failed: token expired for calendar scope')
    expect(out).not.toContain('no upcoming events')
  })
})

describe('fail-closed rendering -- a value the instrument did not print never becomes a number', () => {
  it('ERROR summary poisons kanban AND memory sections, leaves tasks intact', () => {
    const raw = [
      'HB_METRICS_V1 ts=2026-09-11 12:00',
      'ERROR summary: missing/null fields: db_size_mb',
      'CALENDAR_EVENTS n=0 window=2h',
      'SCHEDULES enabled=5',
      'TASK_RUNS_1H total=3 fired=3',
    ].join('\n')
    const out = renderHeartbeatMetricsBlock(raw)
    expect(out).toContain('### Kanban\n- muszer-hiba: ERROR summary: missing/null fields: db_size_mb')
    expect(out).toContain('### Memory / system\n- muszer-hiba: ERROR summary: missing/null fields: db_size_mb')
    expect(out).toContain('- enabled schedules: 5')
    expect(out).toContain('- no upcoming events')
    // The load-bearing negative: no fabricated zero anywhere.
    expect(out).not.toMatch(/DB size: 0/)
    expect(out).not.toMatch(/urgent: 0/)
  })

  it('ERROR token (API-wide) surfaces in every API-backed section that has no data', () => {
    const raw = [
      'HB_METRICS_V1 ts=2026-09-11 12:00',
      'ERROR token: cannot read .dashboard-token: boom',
      'TASK_RUNS_1H total=3 fired=3',
    ].join('\n')
    const out = renderHeartbeatMetricsBlock(raw)
    const hits = out.match(/muszer-hiba: ERROR token/g) ?? []
    // calendar + kanban + schedules + memory = 4 sections; task_runs measured.
    expect(hits.length).toBe(4)
    expect(out).toContain('- last hour: TASK_RUNS_1H total=3 fired=3')
  })
})

describe('the sentinel rule lives here now -- unknown output is instrument failure', () => {
  it('a non-sentinel first line renders muszer-hiba with that literal line in EVERY section', () => {
    const out = renderHeartbeatMetricsBlock('bash: /x/heartbeat-metrics.sh: No such file or directory')
    const hits = out.match(/- muszer-hiba: bash: \/x\/heartbeat-metrics\.sh: No such file or directory/g) ?? []
    expect(hits.length).toBe(4)
  })

  it('a FUTURE sentinel version reads as instrument failure, never accepted as "looks right"', () => {
    // Marveen's stipulation on HBMEMBLIND819 (2026-08-25), carried over: the
    // known-version check must fail closed on V2 under V1 code.
    const out = renderHeartbeatMetricsBlock(HAPPY.replace(HB_METRICS_SENTINEL, 'HB_METRICS_V2'))
    expect(out).toMatch(/muszer-hiba: HB_METRICS_V2 ts=2026-09-11 11:00/)
    expect(out).not.toContain('- urgent: 2')
  })

  it('empty output renders the named empty-output failure', () => {
    const out = renderHeartbeatMetricsBlock('   \n')
    expect(out).toMatch(/muszer-hiba: \(empty instrument output\)/)
  })

  it('null input (spawn error / timeout) carries the supplied reason', () => {
    const out = renderHeartbeatMetricsBlock(null, 'instrument timeout after 30000 ms')
    const hits = out.match(/- muszer-hiba: instrument timeout after 30000 ms/g) ?? []
    expect(hits.length).toBe(4)
  })
})

describe('block header contract', () => {
  it('tells the round the sections are final and muszer-hiba travels unchanged', () => {
    const out = renderHeartbeatMetricsBlock(HAPPY)
    expect(out).toContain('VEGLEGES torzse')
    expect(out).toMatch(/muszer-hiba\s*\n?sor is VALTOZATLANUL/)
  })

  it('contains no em-dash (project style rule)', () => {
    expect(renderHeartbeatMetricsBlock(HAPPY)).not.toContain(String.fromCharCode(0x2014))
    expect(renderHeartbeatMetricsBlock(null, 'x')).not.toContain(String.fromCharCode(0x2014))
  })
})
