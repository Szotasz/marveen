import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A schedule declares which project its token spend belongs to (#168).
 *
 * The provenance wrapper already names the run exactly; this field is the
 * other half -- which bucket to bill it to. Because a wrong project reads as
 * fact in the cost view while a missing one reads as a gap, the value is
 * checked against the projects that actually exist on the board, and an
 * absent value stays absent instead of falling back to anything.
 */

// SCHEDULED_TASKS_DIR is built from homedir() at import time, so the sandbox
// has to exist before the module is loaded -- never point the writer at the
// live ~/.claude/scheduled-tasks.
const SANDBOX = mkdtempSync(join(tmpdir(), 'marveen-sched-'))
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => SANDBOX }
})

let KNOWN_PROJECTS: string[] = []
vi.mock('../db.js', async (orig) => {
  const actual = await orig<typeof import('../db.js')>()
  return { ...actual, listKanbanProjects: () => KNOWN_PROJECTS }
})

const { readScheduledTask, writeScheduledTask, SCHEDULED_TASKS_DIR } =
  await import('../web/scheduled-tasks-io.js')
const { unknownScheduleProject } = await import('../web/routes/schedules.js')

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

function configOf(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEDULED_TASKS_DIR, name, 'task-config.json'), 'utf-8'))
}

describe('the schedule config carries a project', () => {
  it('writes it, reads it back, and survives an unrelated update', () => {
    expect(SCHEDULED_TASKS_DIR.startsWith(SANDBOX)).toBe(true)
    writeScheduledTask('t-round-trip', {
      prompt: 'do it', schedule: '0 8 * * *', agent: 'marveen', project: 'persistent-cart',
    })
    expect(readScheduledTask('t-round-trip')?.project).toBe('persistent-cart')

    writeScheduledTask('t-round-trip', { schedule: '0 9 * * *' })
    expect(readScheduledTask('t-round-trip')?.project).toBe('persistent-cart')
  })

  it('a schedule with no project reads as undefined, not as an empty bucket', () => {
    writeScheduledTask('t-no-project', { prompt: 'x', schedule: '0 8 * * *', agent: 'marveen' })
    expect(readScheduledTask('t-no-project')?.project).toBeUndefined()
    expect('project' in configOf('t-no-project')).toBe(false)
  })

  it('an empty string clears the attribution instead of storing ""', () => {
    // Otherwise every reader would have to tell "no project" from "the empty
    // project", and one of them eventually would not.
    writeScheduledTask('t-clear', { prompt: 'x', schedule: '0 8 * * *', project: 'marveen' })
    expect(readScheduledTask('t-clear')?.project).toBe('marveen')
    writeScheduledTask('t-clear', { project: '   ' })
    expect(readScheduledTask('t-clear')?.project).toBeUndefined()
    expect('project' in configOf('t-clear')).toBe(false)
  })

  it('ignores a non-string project left in a hand-edited config', () => {
    writeScheduledTask('t-junk', { prompt: 'x', schedule: '0 8 * * *' })
    const path = join(SCHEDULED_TASKS_DIR, 't-junk', 'task-config.json')
    const cfg = configOf('t-junk')
    cfg.project = 42
    writeFileSync(path, JSON.stringify(cfg))
    expect(existsSync(path)).toBe(true)
    expect(readScheduledTask('t-junk')?.project).toBeUndefined()
  })
})

describe('the API refuses a project that is not on the board', () => {
  beforeEach(() => { KNOWN_PROJECTS = ['marveen', 'persistent-cart', 'peci.io'] })

  it('accepts a known project', () => {
    expect(unknownScheduleProject('persistent-cart')).toBeNull()
    expect(unknownScheduleProject('  marveen  ')).toBeNull()
  })

  it('names the offending value when the project does not exist', () => {
    // A typo would open a bucket that looks like a real project in the cost
    // report -- the one failure the reader cannot see.
    expect(unknownScheduleProject('persistant-cart')).toBe('persistant-cart')
    expect(unknownScheduleProject('Marveen')).toBe('Marveen')
  })

  it('lets an omitted or cleared value through', () => {
    expect(unknownScheduleProject(undefined)).toBeNull()
    expect(unknownScheduleProject('')).toBeNull()
    expect(unknownScheduleProject('   ')).toBeNull()
  })
})
