import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sizeGuardLevel,
  shouldSendSizeGuardNotice,
  isScheduledPromptStuck,
  buildScheduledTaskPrompt,
  scheduledTaskMarker,
} from '../web/schedule-runner.js'
import { scheduledTaskReferencePrompt, SCHEDULED_TASK_PREAMBLE, NUDGE_MAX_CHARS } from '../prompt-safety.js'
import { SCHEDULED_TASK_BODY_WARN_CHARS, MAX_SCHEDULED_TASK_PROMPT_LEN } from '../web/scheduled-tasks-io.js'

// SCHEDPROMPTREF917 + NUDGESHORT1031: reference-based delivery for every local
// fire (a short pointer to a snapshot holding the whole prompt), plus the
// size-guard notices.
// See docs/scheduled-tasks.md and the spec's test plan (5).

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

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
    const pointer = scheduledTaskReferencePrompt(
      marker,
      '/opt/marveen/store/scheduled-runs/20260917-080000-kanban-audit-a3f9.md',
      'a'.repeat(64),
      48745,
    )
    const parkedPane = ['some earlier output', `❯ ${pointer}`].join('\n')
    expect(isScheduledPromptStuck(parkedPane, marker)).toBe(true)
  })
})

describe('wiring: attemptFireTask types the prompt buildScheduledTaskPrompt returns', () => {
  it('measures the size guard on task.prompt (not taskBody/promptWithMetrics)', () => {
    expect(SRC).toMatch(/maybeSendSizeGuardNotice\(task\.name, task\.prompt\.length, now\)/)
  })

  it('builds the prompt with the marker, the prefix and the resolved host', () => {
    expect(SRC).toMatch(/const marker = scheduledTaskMarker\(task\)\n\s*const \{ prompt: fullPrompt \} = buildScheduledTaskPrompt\(task\.name, marker, prefix, taskBody, host, now\)/)
  })

  it('the resubmit loop looks for the same marker', () => {
    expect(SRC).toMatch(/isScheduledPromptStuck\(pane, marker\)/)
    expect(SRC).not.toMatch(/const marker = task\.type === 'heartbeat'/)
  })
})

describe('scheduledTaskMarker', () => {
  it('heartbeat and task markers', () => {
    expect(scheduledTaskMarker({ name: 'hb', type: 'heartbeat' })).toBe('[Heartbeat: hb]')
    expect(scheduledTaskMarker({ name: 't', type: 'task' })).toBe('[Utemezett feladat: t]')
  })
})

describe('buildScheduledTaskPrompt (#1396 review: remote host, rejected reference; NUDGESHORT1031)', () => {
  const big = 'x'.repeat(5000)
  const marker = '[Utemezett feladat: kanban-audit]'
  const prefix = `${marker} Az eredmenyt kuldd el Telegramon (chat_id: 123, reply tool). `
  const snapPath = '/opt/marveen/store/scheduled-runs/20260921-160000-kanban-audit-a3f9.md'
  function deps(valid = true) {
    return {
      writeSnapshot: vi.fn((_n: string, _b: string, _o?: unknown) => ({ filePath: snapPath, sha256: 'a'.repeat(64), chars: 7000 })),
      isValidReference: vi.fn(() => valid),
    }
  }

  it('a LOCAL agent gets the short pointer, whatever the body size', () => {
    for (const body of [big, 'kicsi']) {
      const d = deps()
      const r = buildScheduledTaskPrompt('kanban-audit', marker, prefix, body, null, Date.now(), d)
      expect(r.delivery).toBe('reference')
      expect(r.prompt).toBe(scheduledTaskReferencePrompt(marker, snapPath, 'a'.repeat(64), 7000))
      expect(r.prompt.length).toBeLessThanOrEqual(NUDGE_MAX_CHARS)
      expect(r.prompt).not.toContain(body)
      expect(r.prompt).not.toContain('chat_id')
      expect(d.writeSnapshot).toHaveBeenCalledTimes(1)
    }
  })

  it('the snapshot gets the whole prompt: trust frame, the prefix with its routing, the block around the body', () => {
    const d = deps()
    buildScheduledTaskPrompt('kanban-audit', marker, prefix, big, null, Date.now(), d)
    const [name, body, opts] = d.writeSnapshot.mock.calls[0] as [string, string, { frame: (p: string) => { before: string; after: string } }]
    expect(name).toBe('kanban-audit')
    expect(body).toBe(big)
    const f = opts.frame(snapPath)
    expect(f.before).toMatch(/^SCHEDULED TASK NOTICE -- the next <scheduled-task/)
    expect(f.before).toContain(snapPath)
    expect(f.before).toContain(prefix.trimEnd() + '\n\n<scheduled-task source="scheduled-task:kanban-audit">\n')
    expect(f.after).toBe('\n</scheduled-task>')
  })

  it('a REMOTE agent gets the full inline prompt and never touches the snapshot branch', () => {
    const d = deps()
    const r = buildScheduledTaskPrompt('kanban-audit', marker, prefix, big, 'laptop', Date.now(), d)
    expect(r.delivery).toBe('inline')
    expect(d.writeSnapshot).not.toHaveBeenCalled()
    expect(r.prompt).toBe(SCHEDULED_TASK_PREAMBLE + '\n' + prefix.trimEnd() + '\n\n' + `<scheduled-task source="scheduled-task:kanban-audit">\n${big}\n</scheduled-task>`)
  })

  it('a snapshot whose path fails validation is delivered inline, not referenced', () => {
    const d = deps(false)
    const r = buildScheduledTaskPrompt('kanban-audit', marker, prefix, big, null, Date.now(), d)
    expect(d.isValidReference).toHaveBeenCalledWith(snapPath)
    expect(r.delivery).toBe('inline')
    expect(r.prompt).not.toContain('body-file=')
  })

  it('a failed snapshot write falls back inline (test 11)', () => {
    const d = { writeSnapshot: vi.fn(() => null), isValidReference: vi.fn(() => true) }
    const r = buildScheduledTaskPrompt('kanban-audit', marker, prefix, big, null, Date.now(), d)
    expect(r.delivery).toBe('inline')
    expect(r.prompt).toContain(big)
    expect(d.isValidReference).not.toHaveBeenCalled()
  })
})

describe('size-guard routing (#1396 review: no owner-channel send)', () => {
  const start = SRC.indexOf('function maybeSendSizeGuardNotice(')
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start))

  it('both tiers notify the main agent as an inter-agent message', () => {
    expect(start).toBeGreaterThan(0)
    expect(body.match(/createAgentMessage\('system', MAIN_AGENT_ID,/g)?.length).toBe(2)
  })

  it('never sends to the owner channel', () => {
    expect(body).not.toMatch(/sendSchedulerAlertMessage|resolveSchedulerOwnerChat|resolveSchedulerAlertToken/)
  })
})
