import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldSnapshotTaskBody,
  sizeGuardLevel,
  shouldSendSizeGuardNotice,
  isScheduledPromptStuck,
} from '../web/schedule-runner.js'
import { wrapScheduledTaskByReference } from '../prompt-safety.js'
import { SCHEDULED_TASK_INLINE_MAX_CHARS, SCHEDULED_TASK_BODY_WARN_CHARS, MAX_SCHEDULED_TASK_PROMPT_LEN } from '../web/scheduled-tasks-io.js'

// SCHEDPROMPTREF917: reference-based delivery once a scheduled-task body
// crosses SCHEDULED_TASK_INLINE_MAX_CHARS, plus the size-guard notices.
// See docs/scheduled-tasks.md and the spec's test plan (5).

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('shouldSnapshotTaskBody (tests 1/2: inline vs. reference threshold)', () => {
  it('stays inline at/under the threshold', () => {
    expect(shouldSnapshotTaskBody(SCHEDULED_TASK_INLINE_MAX_CHARS)).toBe(false)
    expect(shouldSnapshotTaskBody(0)).toBe(false)
  })

  it('snapshots once the body exceeds the threshold', () => {
    expect(shouldSnapshotTaskBody(SCHEDULED_TASK_INLINE_MAX_CHARS + 1)).toBe(true)
    expect(shouldSnapshotTaskBody(48_745)).toBe(true) // measured kanban-audit body, spec 1.2
  })
})

describe('sizeGuardLevel (test 10 boundaries)', () => {
  it('19999 -> none, 20001 -> warn, 50001 -> alert', () => {
    expect(sizeGuardLevel(SCHEDULED_TASK_BODY_WARN_CHARS - 1)).toBe('none')
    expect(sizeGuardLevel(SCHEDULED_TASK_BODY_WARN_CHARS + 1)).toBe('warn')
    expect(sizeGuardLevel(MAX_SCHEDULED_TASK_PROMPT_LEN + 1)).toBe('alert')
  })

  it('the alert threshold itself is alert, not warn', () => {
    expect(sizeGuardLevel(MAX_SCHEDULED_TASK_PROMPT_LEN)).toBe('alert')
    expect(sizeGuardLevel(SCHEDULED_TASK_BODY_WARN_CHARS)).toBe('warn')
  })
})

describe('shouldSendSizeGuardNotice (test 10: once per task per day)', () => {
  it('sends the first time for a task/day, and claims the stamp', () => {
    const stamps = new Map<string, string>()
    expect(shouldSendSizeGuardNotice(stamps, 'kanban-audit', '2026-09-18')).toBe(true)
    expect(stamps.get('kanban-audit')).toBe('2026-09-18')
  })

  it('a second fire the same day does not send again', () => {
    const stamps = new Map<string, string>([['kanban-audit', '2026-09-18']])
    expect(shouldSendSizeGuardNotice(stamps, 'kanban-audit', '2026-09-18')).toBe(false)
  })

  it('a reload of the same day\'s stamp (simulated restart) still suppresses it', () => {
    // The map here stands in for loadSizeGuardState() re-reading today's stamp
    // from disk after a restart -- same effect, no fs involved.
    const reloaded = new Map<string, string>([['kanban-audit', '2026-09-18']])
    expect(shouldSendSizeGuardNotice(reloaded, 'kanban-audit', '2026-09-18')).toBe(false)
  })

  it('the next day sends again', () => {
    const stamps = new Map<string, string>([['kanban-audit', '2026-09-18']])
    expect(shouldSendSizeGuardNotice(stamps, 'kanban-audit', '2026-09-19')).toBe(true)
  })

  it('tasks are independent', () => {
    const stamps = new Map<string, string>([['kanban-audit', '2026-09-18']])
    expect(shouldSendSizeGuardNotice(stamps, 'heti-gephaz-report', '2026-09-18')).toBe(true)
  })
})

describe('isScheduledPromptStuck on a reference-delivered prompt (test 7)', () => {
  it('the marker stays where the resubmit loop expects it, so a parked reference prompt reads as stuck', () => {
    const marker = '[Utemezett feladat: kanban-audit]'
    const referenceBlock = wrapScheduledTaskByReference(
      'scheduled-task:kanban-audit',
      '/opt/marveen/store/scheduled-runs/20260917-080000-kanban-audit-a3f9.md',
      'a'.repeat(64),
      48745,
    )
    const parkedPane = [
      'some earlier output',
      `❯ SCHEDULED TASK NOTICE -- ...\n${marker} Az eredmenyt kuldd el ...\n\n${referenceBlock}`,
    ].join('\n')
    expect(isScheduledPromptStuck(parkedPane, marker)).toBe(true)
  })
})

describe('wiring: attemptFireTask uses the snapshot/reference path above the threshold', () => {
  it('measures the size guard on task.prompt (not taskBody/promptWithMetrics)', () => {
    expect(SRC).toMatch(/maybeSendSizeGuardNotice\(task\.name, task\.prompt\.length, now\)/)
  })

  it('branches on shouldSnapshotTaskBody(taskBody.length) before building the tag', () => {
    const idx = SRC.indexOf('if (shouldSnapshotTaskBody(taskBody.length)) {')
    expect(idx).toBeGreaterThan(0)
    const branch = SRC.slice(idx, idx + 700)
    expect(branch).toMatch(/writeScheduledRunSnapshot\(task\.name, taskBody/)
    expect(branch).toMatch(/wrapScheduledTaskByReference\(/)
    // Write failure falls back to the inline wrap, never drops the task (test 11).
    expect(branch).toMatch(/wrapScheduledTask\(`scheduled-task:\$\{task\.name\}`, taskBody\)/)
  })

  it('the fullPrompt still starts with SCHEDULED_TASK_PREAMBLE and the prefix, unchanged', () => {
    expect(SRC).toMatch(/const fullPrompt =\s*\n\s*SCHEDULED_TASK_PREAMBLE \+ '\\n' \+\s*\n\s*prefix\.trimEnd\(\) \+ '\\n\\n' \+\s*\n\s*scheduledTaskBlock/)
  })
})
