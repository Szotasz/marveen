import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planLocalFirst } from '../costops/local-first.js'

/**
 * The wire between a schedule's declared class and the local-first plan (#301).
 *
 * ScheduledTask.taskClass has existed as a field and as a documented input to
 * planLocalFirst() -- but readScheduledTask() never read it out of the config,
 * so every task arrived unclassified and the plan answered "no task class
 * declared in task-config.json" for all of them. Field on one side, reader on
 * the other, nothing in between, and nothing logged: the same shape as the
 * unlabelled cost rows in #168.
 *
 * The test that matters is therefore not "the field parses" but "a classified
 * schedule reaches the plan as classified".
 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'marveen-class-'))
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => SANDBOX }
})

const { readScheduledTask, writeScheduledTask, listScheduledTasks, SCHEDULED_TASKS_DIR } =
  await import('../web/scheduled-tasks-io.js')
const { unknownScheduleTaskClass } = await import('../web/routes/schedules.js')

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

function configOf(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEDULED_TASKS_DIR, name, 'task-config.json'), 'utf-8'))
}

function makeTask(name: string, taskClass?: string) {
  writeScheduledTask(name, { prompt: 'do it', schedule: '0 8 * * *', agent: 'marveen', taskClass })
}

describe('a declared class reaches the local-first plan', () => {
  it('carries a schedule from its config all the way to a local verdict', () => {
    // The end-to-end property. Without the reader this task arrives with
    // taskClass undefined and the plan says "no task class declared".
    expect(SCHEDULED_TASKS_DIR.startsWith(SANDBOX)).toBe(true)
    makeTask('t-summary', 'summary')
    const task = listScheduledTasks().find(t => t.name === 't-summary')!
    expect(task.taskClass).toBe('summary')

    const [decision] = planLocalFirst([
      { name: task.name, enabled: task.enabled, taskClass: task.taskClass, type: task.type },
    ])
    expect(decision.verdict).toBe('local')
    expect(decision.reason).toContain('summary')
  })

  it('an unclassified schedule still reads as unclassified', () => {
    // The wire must not invent a class; "not classified yet" is a real state
    // and stays in the cloud on purpose.
    makeTask('t-unclassified')
    const task = readScheduledTask('t-unclassified')!
    expect(task.taskClass).toBeUndefined()
    expect(planLocalFirst([{ name: task.name, enabled: true, taskClass: task.taskClass }])[0])
      .toMatchObject({ verdict: 'cloud', reason: 'no task class declared in task-config.json' })
  })

  it('passes an unknown class through so the plan can say so out loud', () => {
    // Normalising a typo away here would turn it into "unclassified", which
    // reads the same as a task nobody has classified yet. Louder is better:
    // the plan names the class it does not serve.
    writeFileSync(
      join(SCHEDULED_TASKS_DIR, 't-unclassified', 'task-config.json'),
      JSON.stringify({ ...configOf('t-unclassified'), taskClass: 'sumary' }),
    )
    const task = readScheduledTask('t-unclassified')!
    expect(task.taskClass).toBe('sumary')
    expect(planLocalFirst([{ name: task.name, enabled: true, taskClass: task.taskClass }])[0])
      .toMatchObject({ verdict: 'cloud', reason: 'class "sumary" is not served locally' })
  })

  it('ignores a non-string class left in a hand-edited config', () => {
    makeTask('t-junk')
    writeFileSync(
      join(SCHEDULED_TASKS_DIR, 't-junk', 'task-config.json'),
      JSON.stringify({ ...configOf('t-junk'), taskClass: 7 }),
    )
    expect(readScheduledTask('t-junk')?.taskClass).toBeUndefined()
  })

  it('round-trips through the writer, and an empty string clears it', () => {
    makeTask('t-clear', 'code')
    expect(readScheduledTask('t-clear')?.taskClass).toBe('code')
    writeScheduledTask('t-clear', { schedule: '0 9 * * *' })
    expect(readScheduledTask('t-clear')?.taskClass).toBe('code')
    writeScheduledTask('t-clear', { taskClass: '  ' })
    expect(readScheduledTask('t-clear')?.taskClass).toBeUndefined()
    expect('taskClass' in configOf('t-clear')).toBe(false)
  })
})

describe('the API refuses a class the router does not know', () => {
  it('accepts every class the router serves', () => {
    for (const c of ['structured', 'summary', 'general', 'hungarian', 'code', 'long-context']) {
      expect(unknownScheduleTaskClass(c), c).toBeNull()
    }
    // agent-loop is routable-but-cloud-only: the config may declare it, and
    // the plan is what refuses it. Rejecting it here would hide the reason.
    expect(unknownScheduleTaskClass('agent-loop')).toBeNull()
  })

  it('names the offending value on a typo or a wrong case', () => {
    expect(unknownScheduleTaskClass('sumary')).toBe('sumary')
    expect(unknownScheduleTaskClass('Structured')).toBe('Structured')
    expect(unknownScheduleTaskClass('json')).toBe('json')
  })

  it('lets an omitted or cleared value through', () => {
    expect(unknownScheduleTaskClass(undefined)).toBeNull()
    expect(unknownScheduleTaskClass('')).toBeNull()
    expect(unknownScheduleTaskClass('   ')).toBeNull()
  })
})
