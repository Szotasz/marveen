import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { quotaWorkClass } from '../web/schedule-runner.js'
import { parseQuotaSnapshot } from '../quota-snapshot.js'

// The gate itself is covered in quota-gate.test.ts. This file covers the two
// seams around it: how a scheduled task is classified, and how the collector's
// on-disk JSON becomes the gate's input.

const RUNNER_SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('quotaWorkClass', () => {
  it('exempts shell-command tasks -- they never call a model', () => {
    expect(quotaWorkClass({ type: 'command' })).toBe('free')
  })

  it('classifies heartbeats as background', () => {
    expect(quotaWorkClass({ type: 'heartbeat' })).toBe('background')
  })

  it('treats owner-visible and unknown future types as owner-facing', () => {
    expect(quotaWorkClass({ type: 'task' })).toBe('owner-facing')
    expect(quotaWorkClass({ type: 'dream-engine' } as never)).toBe('owner-facing')
    expect(quotaWorkClass({} as never)).toBe('owner-facing')
  })
})

describe('schedule-runner wiring', () => {
  it('reads the snapshot once per tick, not once per task', () => {
    // A per-task read would re-parse the same file N times every 60s tick.
    expect(RUNNER_SRC).toContain('const quotaSnapshot = readQuotaSnapshot()')
    expect(RUNNER_SRC.match(/readQuotaSnapshot\(\)/g)?.length).toBe(1)
  })

  it('records a held-back occurrence so the catch-up window cannot re-fire it', () => {
    // Mirrors the pre-check skip: mark the tick as run, log a task-run row.
    const gate = RUNNER_SRC.slice(RUNNER_SRC.indexOf("if (quota.action === 'defer')"))
    const block = gate.slice(0, gate.indexOf('const cronPc'))
    expect(block).toContain('scheduleLastRun.set(task.name, now)')
    expect(block).toContain('persistScheduleLastRun()')
    expect(block).toContain("appendTaskRun(task.name, agentName, 'skipped')")
  })

  it('gates before the pre-check, so a deferred task never spawns its script', () => {
    expect(RUNNER_SRC.indexOf("if (quota.action === 'defer')")).toBeLessThan(
      RUNNER_SRC.indexOf('const cronPc = runPreCheck(task)'),
    )
  })
})

describe('parseQuotaSnapshot', () => {
  const onDisk = {
    generated_at: '2026-08-17T14:53:57.362898+00:00',
    generated_at_local: '2026-08-17 16:53:57 CEST',
    codex: { ok: false },
    claude: {
      provider: 'claude',
      source: 'authoritative',
      ok: true,
      windows: {
        five_hour: { used_percent: 10.0, resets_at: 1786990200.146628 },
        seven_day: { used_percent: 13.0, resets_at: 1787205600.146654 },
      },
    },
  }

  it('maps the collector output onto the gate input', () => {
    const s = parseQuotaSnapshot(onDisk)
    expect(s?.source).toBe('authoritative')
    expect(s?.generatedAtMs).toBe(Date.parse('2026-08-17T14:53:57.362898+00:00'))
    expect(s?.windows?.five_hour?.used_percent).toBe(10)
  })

  it('returns null for anything that is not a collector snapshot', () => {
    expect(parseQuotaSnapshot(null)).toBeNull()
    expect(parseQuotaSnapshot('nope')).toBeNull()
    expect(parseQuotaSnapshot({})).toBeNull()
    expect(parseQuotaSnapshot({ claude: 'not-an-object' })).toBeNull()
  })

  it('survives a snapshot with an unparseable timestamp', () => {
    const s = parseQuotaSnapshot({ ...onDisk, generated_at: 'yesterday-ish' })
    // Null timestamp -> the gate fails open rather than trusting stale numbers.
    expect(s?.generatedAtMs).toBeNull()
    expect(s?.source).toBe('authoritative')
  })
})
