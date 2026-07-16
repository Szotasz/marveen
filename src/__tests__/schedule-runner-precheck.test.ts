import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runPreCheck } from '../web/schedule-runner.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Tests for the heartbeat pre-check mechanism (#234).
//
// Pre-check scripts run before the LLM is invoked. If the script outputs
// "SKIP", the LLM is not called this tick (token cost ~0 for empty heartbeats).
// If the script outputs a non-empty string, it is prepended to the prompt as
// context. If the script exits non-zero or is missing, the LLM runs anyway
// (fail-open).

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name: 'test-task',
    description: 'test',
    prompt: 'Do something.',
    schedule: '0 * * * *',
    agent: 'jarvis',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    ...overrides,
  }
}

function withScript(content: string, ext = '.sh'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-'))
  const file = join(dir, `pre-check${ext}`)
  writeFileSync(file, content, { mode: 0o755 })
  return { dir, file }
}

describe('runPreCheck', () => {
  it('returns skip=false when task has no preCheck configured', () => {
    const result = runPreCheck(makeTask())
    expect(result.skip).toBe(false)
    expect(result.prefix).toBeUndefined()
  })

  it('returns skip=true when script outputs SKIP', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\necho "SKIP"\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(true)
      expect(result.prefix).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('returns skip=false with prefix when script outputs actionable text', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\necho "3 actionable cards found"\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(false)
      expect(result.prefix).toBe('3 actionable cards found')
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('returns skip=false with no prefix when script outputs nothing', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\nexit 0\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(false)
      expect(result.prefix).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('fails open (skip=false) when script exits non-zero', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\necho "error"\nexit 1\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(false)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('fails open (skip=false) when script path does not exist', () => {
    const result = runPreCheck(makeTask({ preCheck: '/nonexistent/path/pre-check.sh' }))
    expect(result.skip).toBe(false)
  })
})

describe('schedule-runner pre-check integration (source-level)', () => {
  it('exports runPreCheck function', () => {
    expect(SRC).toMatch(/export function runPreCheck/)
  })

  it('calls runPreCheck in the cron loop before attemptFireTask', () => {
    const cronLoopIdx = SRC.indexOf('for (const task of tasks)')
    expect(cronLoopIdx).toBeGreaterThan(0)
    const cronLoop = SRC.slice(cronLoopIdx)
    const preCheckIdx = cronLoop.indexOf('runPreCheck(task)')
    const fireIdx = cronLoop.indexOf('attemptFireTask(task,')
    expect(preCheckIdx).toBeGreaterThan(0)
    expect(preCheckIdx).toBeLessThan(fireIdx)
  })

  it('calls runPreCheck in the pending-retry loop before attemptFireTask', () => {
    const retryLoopIdx = SRC.indexOf('for (const row of pendingRows)')
    expect(retryLoopIdx).toBeGreaterThan(0)
    const retryLoop = SRC.slice(retryLoopIdx, SRC.indexOf('for (const task of tasks)'))
    expect(retryLoop).toMatch(/runPreCheck\(taskDef\)/)
    expect(retryLoop).toMatch(/attemptFireTask\(taskDef,/)
  })

  it('passes preCheckPrefix to attemptFireTask in the cron loop', () => {
    expect(SRC).toMatch(/attemptFireTask\(task, agentName, now, cronPc\.prefix, lateCatchUpMs\)/)
  })

  it('skips and records the run when pre-check returns skip in cron loop', () => {
    const cronLoopIdx = SRC.indexOf('for (const task of tasks)')
    const afterCronPc = SRC.slice(cronLoopIdx)
    // The cronPc.skip branch must set the lastRun guard and append a skipped run
    const skipBlock = afterCronPc.slice(afterCronPc.indexOf('if (cronPc.skip)'), afterCronPc.indexOf('for (const agentName of targetAgents) {'))
    expect(skipBlock).toMatch(/cronPc\.skip/)
    expect(skipBlock).toMatch(/scheduleLastRun\.set/)
    // appendTaskRun is inside the targetAgents loop within the skip block
    expect(afterCronPc.slice(
      afterCronPc.indexOf('if (cronPc.skip)'),
      afterCronPc.indexOf('if (pendingKeys.has(key))'),
    )).toMatch(/appendTaskRun/)
  })

  it('uses fail-open semantics (no SKIP on non-zero exit, no throw on missing file)', () => {
    const preCheckFn = SRC.slice(SRC.indexOf('export function runPreCheck'))
    const fnBody = preCheckFn.slice(0, preCheckFn.indexOf('\nexport function'))
    // Non-zero exit returns { skip: false }
    expect(fnBody).toMatch(/r\.status !== 0/)
    expect(fnBody).toMatch(/running LLM anyway/)
    // Missing file returns { skip: false }
    expect(fnBody).toMatch(/not found, running LLM anyway/)
  })
})
