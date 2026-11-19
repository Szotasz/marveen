import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { noteQuotaBlindness, quotaWorkClass, resetQuotaBlindStateForTest } from '../web/schedule-runner.js'
import { logger } from '../logger.js'
import { parseQuotaSnapshot } from '../quota-snapshot.js'
import { getSettingDefinition } from '../config-registry.js'

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
    // CRONPRECHECKSYNC1007: the cron loop awaits the async form now.
    const preCheckIdx = RUNNER_SRC.indexOf('const cronPc = await runPreCheckAsync(task)')
    expect(preCheckIdx).toBeGreaterThan(0)
    expect(RUNNER_SRC.indexOf("if (quota.action === 'defer')")).toBeLessThan(preCheckIdx)
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

describe('noteQuotaBlindness -- the blind gate is never silent, and never noisy', () => {
  const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
  const estimate = { source: 'estimate', generatedAtMs: NOW - 60_000, windows: null }
  const fresh = { source: 'ratelimit_headers', generatedAtMs: NOW - 60_000, windows: { seven_day: { used_percent: 22, resets_at: NOW / 1000 + 3600 } } }
  const old = { ...fresh, generatedAtMs: NOW - 3 * 60 * 60_000 }

  let saved: string | null = null
  const store = { read: () => saved, write: (k: string) => { saved = k || null } }
  const note = (s: Parameters<typeof noteQuotaBlindness>[0], t: number, n: (x: string) => void) => noteQuotaBlindness(s, t, n, store)
  beforeEach(() => { resetQuotaBlindStateForTest(); saved = null })
  afterEach(() => vi.restoreAllMocks())

  it('estimate: one warn + one owner notice, then quiet on every later tick', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    for (let i = 0; i < 5; i++) note(estimate, NOW + i * 60_000, notify)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('"estimate"')
  })

  it('stale > 2h: one warn + one notice; blind kind change logs but does not re-alert', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(old, NOW, notify)
    note(old, NOW + 60_000, notify)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('180 perce')
    note(estimate, NOW + 120_000, notify)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('recovers with one info line, and a new blind spell alerts again', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(estimate, NOW, notify)
    note(fresh, NOW, notify)
    note(fresh, NOW + 60_000, notify)
    expect(info).toHaveBeenCalledTimes(1)
    note(estimate, NOW + 120_000, notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('restarts while the same blindness lasts do not alert again, even on rewritten snapshots; another source does', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(estimate, NOW, notify)
    for (let i = 1; i <= 3; i++) {
      resetQuotaBlindStateForTest() // dashboard restart: in-memory state lost, store kept
      // a running collector rewrites the estimate every 15 minutes
      note({ ...estimate, generatedAtMs: (estimate.generatedAtMs ?? NOW) + i * 15 * 60_000 }, NOW + i * 15 * 60_000, notify)
    }
    expect(notify).toHaveBeenCalledTimes(1)
    resetQuotaBlindStateForTest()
    note({ ...estimate, source: 'unknown' }, NOW + 60 * 60_000, notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('no snapshot (collector not enabled) is not blind: no log, no notice', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(null, NOW, notify)
    expect(warn).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('is wired once per tick next to the snapshot read, and the gate gets essential + the hard line', () => {
    expect(RUNNER_SRC).toContain('noteQuotaBlindness(quotaSnapshot, now)')
    expect(RUNNER_SRC.match(/noteQuotaBlindness\(quotaSnapshot/g)?.length).toBe(1)
    expect(RUNNER_SRC).toContain('essential: task.essential === true,')
    expect(RUNNER_SRC).toContain('hardAtPercent: quotaHardAtPercent,')
    const io = readFileSync(join(__dirname, '../web/scheduled-tasks-io.ts'), 'utf-8')
    expect(io).toContain('essential: config.essential === true,')
  })

  it('the tiers are off unless set: registry default 0, and the runner falls back to 0', () => {
    expect(getSettingDefinition('QUOTA_GATE_HARD_AT_PERCENT')?.default).toBe(0)
    expect(RUNNER_SRC).toContain("try { return Number(getEffectiveSettingValue('QUOTA_GATE_HARD_AT_PERCENT')) || 0 } catch { return 0 }")
  })
})
